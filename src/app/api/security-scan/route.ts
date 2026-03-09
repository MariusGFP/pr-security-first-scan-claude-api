export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getDb, addCost } from '@/lib/db';
import { runClaudeAgentic, AVAILABLE_MODELS, type ModelKey, getKeyValue } from '@/lib/claude';
import { logAndBroadcast, broadcastScanProgress } from '@/lib/websocket';
import fs from 'fs';
import path from 'path';

const PROMPTS_DIR = path.join(process.cwd(), 'prompts', 'security-scan');

function getAuditsDir(): string {
  const fromKeys = getKeyValue('AUDITS_DIR');
  return fromKeys || path.join(process.env.HOME || '~', 'automation', 'audits');
}

// Security scan agent definitions
const SECURITY_AGENTS = [
  { id: '01-auth-identity',          name: 'Auth & Identity Flow',    focus: 'JWT/Token security, RBAC, cross-service auth, session management, IDOR' },
  { id: '02-api-security',           name: 'API Security',            focus: 'Input validation, rate limiting, CORS, response filtering, SSRF, mass assignment' },
  { id: '03-crypto-web3',            name: 'Crypto/Web3 Security',    focus: 'Fireblocks integration, transaction safety, smart contracts, RPC security, DeFi risks' },
  { id: '04-secrets-credentials',    name: 'Secrets & Credentials',   focus: 'Hardcoded secrets, env config, git history, credential exposure, secret rotation' },
  { id: '05-cross-repo-attack-surface', name: 'Cross-Repo Attack Surface', focus: 'Trust boundaries, lateral movement, service-to-service auth, shared resources' },
  { id: '06-injection-owasp',        name: 'Injection & OWASP',       focus: 'SQL/NoSQL/Command injection, XSS, SSRF, broken access control, full OWASP Top 10' },
  { id: '07-scheduler-job-safety',   name: 'Scheduler & Job Safety',  focus: 'Idempotency, race conditions, double execution, concurrency control in trading ops' },
  { id: '08-dependency-supply-chain', name: 'Dependency & Supply Chain', focus: 'CVEs, typosquatting, outdated packages, crypto library versions, license audit' },
];

// Ensure security_scans table exists
function ensureTable() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS security_scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform_name TEXT NOT NULL,
      repos_dir TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      model TEXT,
      total_agents INTEGER DEFAULT 0,
      duration_seconds INTEGER,
      architecture_map TEXT,
      agent_results TEXT,
      full_report TEXT,
      report TEXT,
      report_file TEXT,
      estimated_cost REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    );
  `);
  // Migration: add agent_results column if missing
  try {
    const cols = getDb().prepare("PRAGMA table_info(security_scans)").all() as any[];
    if (!cols.find((c: any) => c.name === 'agent_results')) {
      getDb().exec('ALTER TABLE security_scans ADD COLUMN agent_results TEXT');
    }
    if (!cols.find((c: any) => c.name === 'full_report')) {
      getDb().exec('ALTER TABLE security_scans ADD COLUMN full_report TEXT');
    }
  } catch { /* ignore */ }
}

export async function GET() {
  ensureTable();
  const scans = getDb().prepare('SELECT * FROM security_scans ORDER BY created_at DESC').all();
  return NextResponse.json({ scans, models: Object.entries(AVAILABLE_MODELS).map(([key, val]) => ({ key, ...val })) });
}

export async function POST(req: NextRequest) {
  ensureTable();
  const { platformName, reposDir, repoPaths, model } = await req.json();
  const selectedModel: ModelKey = (model && model in AVAILABLE_MODELS) ? model : 'opus';

  let resolvedDir: string;
  let repos: string[];
  let repoFullPaths: string[];

  if (repoPaths && Array.isArray(repoPaths) && repoPaths.length > 0) {
    // Mode 1: Explicit repo paths (from security scan repos)
    repoFullPaths = repoPaths.map((p: string) => p.replace('~', process.env.HOME || ''));

    // Validate all paths exist
    for (const rp of repoFullPaths) {
      if (!fs.existsSync(rp)) {
        return NextResponse.json({ error: `Directory not found: ${rp}` }, { status: 404 });
      }
    }

    repos = repoFullPaths.map(p => path.basename(p));
    // Use common parent directory as working dir, or first repo's parent
    resolvedDir = path.dirname(repoFullPaths[0]);
  } else if (reposDir) {
    // Mode 2: Scan all repos in directory (legacy)
    resolvedDir = reposDir.replace('~', process.env.HOME || '');
    if (!fs.existsSync(resolvedDir)) {
      return NextResponse.json({ error: `Directory not found: ${reposDir}` }, { status: 404 });
    }

    repos = fs.readdirSync(resolvedDir).filter(f =>
      fs.statSync(path.join(resolvedDir, f)).isDirectory() && fs.existsSync(path.join(resolvedDir, f, '.git'))
    );
    repoFullPaths = repos.map(r => path.join(resolvedDir, r));
  } else {
    return NextResponse.json({ error: 'reposDir or repoPaths is required' }, { status: 400 });
  }

  if (repos.length === 0) {
    return NextResponse.json({ error: 'No repos found' }, { status: 400 });
  }

  const modelInfo = AVAILABLE_MODELS[selectedModel];
  const displayDir = repoPaths ? `[${repos.length} Repos]` : reposDir;
  const result = getDb().prepare(
    `INSERT INTO security_scans (platform_name, repos_dir, status, model, total_agents) VALUES (?, ?, 'running', ?, ?)`
  ).run(platformName, displayDir, selectedModel, SECURITY_AGENTS.length);
  const scanId = result.lastInsertRowid as number;

  logAndBroadcast(`🔒 Security Scan started for "${platformName}" (${repos.length} Repos, ${modelInfo.name}, ${SECURITY_AGENTS.length} Agents)`);
  logAndBroadcast(`   Repos: ${repos.join(', ')}`);

  // Run async — pass full paths for explicit repos
  runSecurityScan(scanId, platformName, resolvedDir, repos, selectedModel, repoFullPaths).catch(e => {
    logAndBroadcast(`❌ Security Scan failed: ${e.message}`);
    getDb().prepare('UPDATE security_scans SET status = ? WHERE id = ?').run('failed', scanId);
  });

  return NextResponse.json({ scanId, status: 'started', repos, model: selectedModel });
}

async function runSecurityScan(
  scanId: number, platformName: string, reposDir: string, repos: string[], model: ModelKey, repoFullPaths?: string[]
) {
  const startTime = Date.now();
  let totalCost = 0;
  const modelInfo = AVAILABLE_MODELS[model];

  // Build repo info for prompts
  const repoPathsList = repoFullPaths
    ? repoFullPaths.map((fp, i) => `- ${repos[i]}: ${fp}`).join('\n')
    : repos.map(r => `- ${r}: ${path.join(reposDir, r)}`).join('\n');
  const workingDir = repoFullPaths ? path.dirname(repoFullPaths[0]) : reposDir;

  // Build initial agent status list
  const agentStatus: Array<{ id: string; name: string; status: string; chars?: number; cost?: number; attempt?: number }> =
    SECURITY_AGENTS.map(a => ({ id: a.id, name: a.name, status: 'pending' }));

  // ── Phase 0: Architecture Mapping ──
  logAndBroadcast(`  [Security] Phase 0: Architecture Mapping (${modelInfo.name})...`);
  broadcastScanProgress(scanId, { phase: 'mapping', agents: agentStatus });

  const mappingPromptFile = path.join(PROMPTS_DIR, '00-architecture-mapping.md');
  let mappingPrompt = fs.existsSync(mappingPromptFile) ? fs.readFileSync(mappingPromptFile, 'utf8') : '';
  mappingPrompt = mappingPrompt
    .replace(/\{\{PLATFORM_NAME\}\}/g, platformName)
    .replace(/\{\{REPOS_DIR\}\}/g, workingDir);

  const mappingResult = await runClaudeAgentic(
    `${mappingPrompt}\n\nRepos (Name: Path):\n${repoPathsList}\n\nNavigate to the listed paths to analyze each repo.`,
    workingDir,
    900000, // 15 min for mapping
    model
  );

  totalCost += mappingResult.cost;
  const architectureMap = mappingResult.success ? mappingResult.result : 'Architecture mapping failed — proceed without context.';
  logAndBroadcast(`  [Security] ✅ Architecture Mapping done ($${mappingResult.cost.toFixed(2)})`);

  // Save architecture map to DB
  getDb().prepare('UPDATE security_scans SET architecture_map = ? WHERE id = ?').run(architectureMap, scanId);

  // ── Phase 1: 8 Security Agents parallel ──
  logAndBroadcast(`  [Security] Phase 1: ${SECURITY_AGENTS.length} Security Agents parallel (${modelInfo.name})...`);
  agentStatus.forEach(a => a.status = 'running' as any);
  broadcastScanProgress(scanId, { phase: 'agents', agents: agentStatus });

  const MAX_RETRIES = 2;
  const MIN_OUTPUT_CHARS = 500;

  const agentPromises = SECURITY_AGENTS.map(async (agent, idx) => {
    const promptFile = path.join(PROMPTS_DIR, `${agent.id}.md`);
    let basePrompt = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : '';
    basePrompt = basePrompt
      .replace(/\{\{PLATFORM_NAME\}\}/g, platformName)
      .replace(/\{\{REPOS_DIR\}\}/g, workingDir)
      .replace(/\{\{ARCHITECTURE_MAP\}\}/g, architectureMap.substring(0, 15000));

    const fullPrompt = `${basePrompt}\n\nRepos (Name: Path):\n${repoPathsList}\n\nYou have full access to ALL files. Navigate to the paths listed above to analyze each repo.`;

    agentStatus[idx] = { ...agentStatus[idx], status: 'running' };
    broadcastScanProgress(scanId, { phase: 'agents', agents: agentStatus, totalCost });

    let result = await runClaudeAgentic(fullPrompt, workingDir, 900000, model);
    totalCost += result.cost;

    // Auto-retry on failure or suspiciously short output
    let attempt = 1;
    while (attempt < MAX_RETRIES && (!result.success || (result.result || '').length < MIN_OUTPUT_CHARS)) {
      attempt++;
      const reason = !result.success ? 'FAILED' : 'short output';
      logAndBroadcast(`  [Security] 🔄 ${agent.name} retry ${attempt}/${MAX_RETRIES} (${reason}: ${(result.result || '').length} chars)`);
      agentStatus[idx] = { ...agentStatus[idx], status: 'retrying', attempt };
      broadcastScanProgress(scanId, { phase: 'agents', agents: agentStatus, totalCost });
      result = await runClaudeAgentic(fullPrompt, workingDir, 900000, model);
      totalCost += result.cost;
    }

    const outputLen = (result.result || '').length;
    if (!result.success) {
      logAndBroadcast(`  [Security] ❌ ${agent.name} FAILED after ${attempt} attempts: ${result.result.substring(0, 200)}`);
      agentStatus[idx] = { ...agentStatus[idx], status: 'failed', chars: outputLen, cost: result.cost };
    } else if (outputLen < MIN_OUTPUT_CHARS) {
      logAndBroadcast(`  [Security] ⚠️ ${agent.name} still short after ${attempt} attempts (${outputLen} chars)`);
      agentStatus[idx] = { ...agentStatus[idx], status: 'done', chars: outputLen, cost: result.cost };
    } else {
      logAndBroadcast(`  [Security] ✅ ${agent.name} done (${outputLen} chars, $${result.cost.toFixed(2)}${attempt > 1 ? `, ${attempt} attempts` : ''})`);
      agentStatus[idx] = { ...agentStatus[idx], status: 'done', chars: outputLen, cost: result.cost };
    }
    broadcastScanProgress(scanId, { phase: 'agents', agents: agentStatus, totalCost });
    return { agent, result };
  });

  const results = await Promise.all(agentPromises);

  // ── Phase 2: Aggregation (grouped by repo) ──
  logAndBroadcast(`  [Security] Phase 2: Aggregation (by repo)...`);
  broadcastScanProgress(scanId, { phase: 'aggregation', agents: agentStatus, totalCost });

  // Save individual agent results to DB for debugging
  const agentResultsObj = results.map(r => ({
    id: r.agent.id,
    name: r.agent.name,
    success: r.result.success,
    chars: (r.result.result || '').length,
    cost: r.result.cost,
    durationMs: r.result.durationMs,
    output: r.result.result,
  }));
  getDb().prepare('UPDATE security_scans SET agent_results = ? WHERE id = ?')
    .run(JSON.stringify(agentResultsObj), scanId);

  const agentResults = results.map(r =>
    `### ${r.agent.name}\n${r.result.result}`
  ).join('\n\n---\n\n');

  // Build the full report (all agents combined with headers)
  const fullReport = `# ${platformName} — Full Security Audit Report\nDate: ${new Date().toISOString().split('T')[0]}\nModel: ${modelInfo.name}\nRepos: ${repos.join(', ')}\n\n` +
    results.map(r =>
      `${'='.repeat(80)}\n## ${r.agent.id}: ${r.agent.name}\nFocus: ${SECURITY_AGENTS.find(a => a.id === r.agent.id)?.focus || ''}\nStatus: ${r.result.success ? 'OK' : 'FAILED'} | ${(r.result.result || '').length} chars | $${r.result.cost.toFixed(2)}\n${'='.repeat(80)}\n\n${r.result.result}`
    ).join('\n\n\n');

  // Save full report to DB
  getDb().prepare('UPDATE security_scans SET full_report = ? WHERE id = ?')
    .run(fullReport, scanId);

  const aggResult = await runClaudeAgentic(
    `You are creating the final Security Audit Report for the "${platformName}" platform.

Combine the following ${SECURITY_AGENTS.length} security agent reports into ONE structured report.

REPOS: ${repos.join(', ')}

⚠️ CRITICAL: Your report MUST include an "Audit Coverage Summary" section at the end. This is NOT optional. If agents did not include Coverage Reports, flag them as "Coverage unverified". A report WITHOUT the coverage summary is INCOMPLETE.

RULES:
1. Executive Summary at top with TWO counts:
   - CONFIRMED findings: X 🔴 Critical, Y 🟡 Warning, Z 🔵 Info
   - POTENTIAL/NEEDS-VERIFICATION findings: X ⚠️ Total (these need manual verification)
2. Group findings BY REPO — each repo gets its own section
3. Within each repo section, create TWO sub-sections:
   a) "🔒 Confirmed Findings" — sorted by severity (Critical → Warning → Info)
   b) "⚠️ Requires Verification" — POTENTIAL and NEEDS-VERIFICATION findings, sorted by severity
4. For each finding include: Severity, Confidence, File:Line, Category, Description, Impact, Compensation Check, Fix
5. After repo sections: "Cross-Repo Findings" section (same CONFIRMED/POTENTIAL split)
6. NEW section: "Infrastructure Verification Checklist" — list all NEEDS-VERIFICATION items as a checklist the team can work through
7. Final section: "Priority Remediation Roadmap" — top 10 CONFIRMED actions ordered by risk
8. Remove duplicate findings (prefer the version with more detail)
9. If two agents report the same finding, merge them and keep the higher confidence level
10. Maximum 100 findings total (prioritize CONFIRMED over POTENTIAL)
11. All text in English

CONFIDENCE HANDLING:
- 🔒 CONFIRMED = proven vulnerability, must be fixed
- ⚠️ POTENTIAL = likely issue but needs verification (infrastructure/deployment check)
- 🔍 NEEDS-VERIFICATION = theoretical, depends on deployment/runtime
- When in doubt between CONFIRMED and POTENTIAL, keep POTENTIAL
- The "Infrastructure Verification Checklist" helps the team quickly verify all POTENTIAL/NEEDS-VERIFICATION items

FORMAT:
# ${platformName} — Security Audit Report
Date: ${new Date().toISOString().split('T')[0]}
Model: ${modelInfo.name}
Repos scanned: ${repos.length}

## Executive Summary
### Confirmed Findings
🔴 X Critical | 🟡 Y Warning | 🔵 Z Info

### Requiring Verification
⚠️ X Potential | 🔍 Y Needs Verification

### False Positive Prevention
This audit uses a three-tier confidence system. POTENTIAL and NEEDS-VERIFICATION findings should be verified against your deployment infrastructure before action.

## Findings by Repository

### [repo-name-1]

#### 🔒 Confirmed Findings
...

#### ⚠️ Requires Verification
...

### [repo-name-2]
...

## Cross-Repo Findings
...

## Infrastructure Verification Checklist
- [ ] Verify: [NEEDS-VERIFICATION item 1]
- [ ] Verify: [NEEDS-VERIFICATION item 2]
...

## Priority Remediation Roadmap
(Only CONFIRMED findings, ordered by risk)
...

## Audit Coverage Summary (MANDATORY — DO NOT SKIP)

⚠️ This section is REQUIRED. Extract the "Coverage Report" from EACH agent's output below.

### Per-Agent Coverage Matrix

| Agent | Repos Covered | Files Reviewed | Coverage % | Has Coverage Report? |
|-------|--------------|----------------|------------|---------------------|
| 01 Auth & Identity | ... | ... | ...% | ✅ / ⚠️ Missing |
| 02 API Security | ... | ... | ...% | ✅ / ⚠️ Missing |
| 03 Crypto/Web3 | ... | ... | ...% | ✅ / ⚠️ Missing |
| 04 Secrets & Credentials | ... | ... | ...% | ✅ / ⚠️ Missing |
| 05 Cross-Repo Attack Surface | ... | ... | ...% | ✅ / ⚠️ Missing |
| 06 Injection & OWASP | ... | ... | ...% | ✅ / ⚠️ Missing |
| 07 Scheduler & Job Safety | ... | ... | ...% | ✅ / ⚠️ Missing |
| 08 Dependency & Supply Chain | ... | ... | ...% | ✅ / ⚠️ Missing |

### File Coverage Detail
For EACH repo, list ALL files that were reviewed by at least one agent:
- ✅ file.ts — reviewed by Agent 01, 02
- ❌ file.ts — NOT reviewed by any agent

### Summary
**Overall Coverage**: X% of security-relevant files were reviewed by at least one agent.
**Coverage Gaps**: [list any files/repos that NO agent reviewed]
**Reliability Assessment**: [HIGH if >90% coverage, MEDIUM if 70-90%, LOW if <70%]

If an agent did NOT include a Coverage Report → mark "⚠️ Missing" and flag as "Coverage unverified".
...

AGENT RESULTS:

${agentResults}`,
    workingDir,
    600000,
    model
  );

  totalCost += aggResult.cost;
  const duration = Math.round((Date.now() - startTime) / 1000);
  const report = aggResult.success ? aggResult.result : agentResults;

  // ── Save all reports to numbered audit folder ──
  const platformSlug = platformName.toLowerCase().replace(/\s+/g, '-');
  const platformAuditsDir = path.join(getAuditsDir(), 'security-audits', platformSlug);
  if (!fs.existsSync(platformAuditsDir)) fs.mkdirSync(platformAuditsDir, { recursive: true });

  // Determine next audit number (01, 02, 03, ...)
  const existingAudits = fs.readdirSync(platformAuditsDir)
    .filter(f => f.match(/^\d{2}-audit-/))
    .sort();
  const nextNum = existingAudits.length + 1;
  const numStr = String(nextNum).padStart(2, '0');

  const now = new Date();
  const dateTimeStr = `${now.toISOString().split('T')[0]}_${now.toTimeString().slice(0, 8).replace(/:/g, '-')}`;
  const auditFolderName = `${numStr}-audit-${dateTimeStr}`;
  const auditDir = path.join(platformAuditsDir, auditFolderName);
  fs.mkdirSync(auditDir, { recursive: true });

  // Save architecture map
  fs.writeFileSync(path.join(auditDir, '00-architecture-map.md'), architectureMap);

  // Save individual agent results
  for (const r of results) {
    const agentFile = path.join(auditDir, `${r.agent.id}.md`);
    fs.writeFileSync(agentFile, `# ${r.agent.name}\n\n${r.result.result}`);
  }

  // Save full combined report (all agents)
  fs.writeFileSync(path.join(auditDir, '09-full-report.md'), fullReport);

  // Save aggregated summary report
  const reportFile = path.join(auditDir, '10-summary-report.md');
  fs.writeFileSync(reportFile, report);

  logAndBroadcast(`  [Security] 📁 All reports saved to: ${auditDir}`);

  // Update DB
  getDb().prepare(
    `UPDATE security_scans SET status = ?, duration_seconds = ?, report = ?, report_file = ?, estimated_cost = ?, completed_at = ? WHERE id = ?`
  ).run('completed', duration, report, auditDir, totalCost, new Date().toISOString(), scanId);

  addCost({
    type: 'security-scan',
    reference_id: scanId,
    repo_id: null as any,
    estimated_tokens: 0,
    estimated_cost: totalCost,
  });

  logAndBroadcast(`✅ Security Scan for "${platformName}" completed (${modelInfo.name}, ${duration}s, $${totalCost.toFixed(2)})`);
  logAndBroadcast(`   Audit folder: ${auditDir}`);
  broadcastScanProgress(scanId, { phase: 'done', agents: agentStatus, totalCost, duration });
}
