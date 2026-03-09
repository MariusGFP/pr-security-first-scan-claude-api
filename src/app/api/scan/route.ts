export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getDb, getRepoById, addCost } from '@/lib/db';
import { runClaudeAgentic, AVAILABLE_MODELS, type ModelKey, getKeyValue } from '@/lib/claude';
import { logAndBroadcast, broadcastScanProgress } from '@/lib/websocket';
import fs from 'fs';
import path from 'path';

const DASHBOARD_DIR = process.env.DASHBOARD_DIR || path.join(process.env.HOME || '~', 'automation', 'claude-dashboard');
const PROMPTS_DIR = path.join(DASHBOARD_DIR, 'prompts', 'first-scan');

function getAuditsDir(): string {
  const fromKeys = getKeyValue('AUDITS_DIR');
  return fromKeys || path.join(process.env.HOME || '~', 'automation', 'audits');
}

function resolveRepoDir(repo: { id: number; name: string; org: string; local_path: string }): string | null {
  const { updateRepo } = require('@/lib/db');
  const dbPath = repo.local_path.replace('~', process.env.HOME || '');
  if (fs.existsSync(dbPath)) return dbPath;

  const reposDir = getKeyValue('REPOS_DIR') || path.join(process.env.HOME || '~', 'repos');
  const candidates = [
    path.join(reposDir, repo.name),
    path.join(reposDir, repo.org, repo.name),
    path.join(reposDir, 'github', repo.name),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.existsSync(path.join(candidate, '.git'))) {
      updateRepo(repo.id, { local_path: candidate } as any);
      logAndBroadcast(`  [Scan] Updated repo path: ${candidate}`);
      return candidate;
    }
  }
  return null;
}

// First Scan agent definitions (code quality focused, not security)
const SCAN_AGENTS = [
  { id: '01-code-quality',      name: 'Code Quality',      focus: 'Code smells, duplication, complexity, style inconsistencies, naming' },
  { id: '02-bug-analysis',      name: 'Bug Analysis',      focus: 'Logic errors, edge cases, race conditions, runtime errors, error handling' },
  { id: '03-security',          name: 'Security',          focus: 'XSS, injection, insecure API calls, missing input validation, auth issues' },
  { id: '04-best-practices',    name: 'Best Practices',    focus: 'Framework patterns, conventions, anti-patterns, SOLID principles' },
  { id: '05-dead-code',         name: 'Dead Code',         focus: 'Unused imports, variables, functions, unreachable code, deprecated code' },
  { id: '06-behavioral-impact', name: 'Behavioral Impact', focus: 'UI bugs, state issues, rendering problems, UX inconsistencies, data integrity' },
  { id: '07-performance',       name: 'Performance',       focus: 'N+1 queries, missing indexes, caching, lazy loading, memory leaks' },
  { id: '08-test-coverage',     name: 'Test Coverage',     focus: 'Missing tests, untested paths, test quality, test suggestions' },
  { id: '09-dependency-check',  name: 'Dependencies',      focus: 'Outdated packages, CVEs, unnecessary dependencies, license issues' },
  { id: '10-ai-code-safety',    name: 'AI Code Safety',    focus: 'Hallucinated APIs, fake implementations, copy-paste errors, inconsistent auth, missing validation' },
];

// Ensure scans table has the new columns
function ensureScanColumns() {
  try {
    const cols = getDb().prepare("PRAGMA table_info(scans)").all() as any[];
    const colNames = cols.map((c: any) => c.name);
    if (!colNames.includes('architecture_map')) {
      getDb().exec('ALTER TABLE scans ADD COLUMN architecture_map TEXT');
    }
    if (!colNames.includes('agent_results')) {
      getDb().exec('ALTER TABLE scans ADD COLUMN agent_results TEXT');
    }
    if (!colNames.includes('full_report')) {
      getDb().exec('ALTER TABLE scans ADD COLUMN full_report TEXT');
    }
    if (!colNames.includes('report_file')) {
      getDb().exec('ALTER TABLE scans ADD COLUMN report_file TEXT');
    }
    if (!colNames.includes('model')) {
      getDb().exec('ALTER TABLE scans ADD COLUMN model TEXT');
    }
    if (!colNames.includes('framework_info')) {
      getDb().exec('ALTER TABLE scans ADD COLUMN framework_info TEXT');
    }
  } catch { /* ignore */ }
}

export async function GET() {
  ensureScanColumns();
  // Return available models + recent scans for the UI
  const models = Object.entries(AVAILABLE_MODELS).map(([key, val]) => ({
    key,
    name: val.name,
    context: val.context,
    costPer1MInput: val.costPer1MInput,
    costPer1MOutput: val.costPer1MOutput,
  }));
  return NextResponse.json({ models });
}

export async function POST(req: NextRequest) {
  ensureScanColumns();
  const { repoId, model } = await req.json();
  const selectedModel: ModelKey = (model && model in AVAILABLE_MODELS) ? model : 'sonnet';

  const repo = getRepoById(repoId);
  if (!repo) return NextResponse.json({ error: 'Repo not found' }, { status: 404 });

  const repoDir = resolveRepoDir(repo);
  if (!repoDir) {
    return NextResponse.json({ error: `Repo directory not found. Checked: ${repo.local_path} and REPOS_DIR. Update the path in Settings or re-clone.` }, { status: 404 });
  }

  const modelInfo = AVAILABLE_MODELS[selectedModel];

  // Create scan record with model info
  const result = getDb().prepare(
    `INSERT INTO scans (repo_id, status, total_agents, model) VALUES (?, 'running', ?, ?)`
  ).run(repoId, SCAN_AGENTS.length, selectedModel);
  const scanId = result.lastInsertRowid as number;

  logAndBroadcast(`🔍 First Scan started for ${repo.full_name} with ${modelInfo.name} (${modelInfo.context}, agentic mode, ${SCAN_AGENTS.length} agents)...`);

  // Run scan asynchronously
  runFullScan(scanId, repo.id, repo.name, repo.full_name, repoDir, selectedModel).catch(e => {
    logAndBroadcast(`❌ First Scan failed: ${e.message}`);
    getDb().prepare('UPDATE scans SET status = ? WHERE id = ?').run('failed', scanId);
  });

  return NextResponse.json({ scanId, status: 'started', model: selectedModel });
}

async function runFullScan(
  scanId: number, repoId: number, repoName: string, repoFullName: string, repoDir: string, model: ModelKey
) {
  const startTime = Date.now();
  let totalCost = 0;
  const modelInfo = AVAILABLE_MODELS[model];

  // Build initial agent status list
  const agentStatus: Array<{ id: string; name: string; status: string; chars?: number; cost?: number; attempt?: number }> =
    SCAN_AGENTS.map(a => ({ id: a.id, name: a.name, status: 'pending' }));

  // ── Phase 0: Framework Detection & Architecture Mapping ──
  logAndBroadcast(`  [Scan] Phase 0: Framework Detection & Architecture Mapping (${modelInfo.name})...`);
  broadcastScanProgress(scanId, { phase: 'mapping', agents: agentStatus });

  const detectionPromptFile = path.join(PROMPTS_DIR, '00-framework-detection.md');
  let detectionPrompt = fs.existsSync(detectionPromptFile) ? fs.readFileSync(detectionPromptFile, 'utf8') : '';
  detectionPrompt = detectionPrompt
    .replace(/\{\{REPO_NAME\}\}/g, repoFullName)
    .replace(/\{\{REPO_DIR\}\}/g, repoDir);

  // Also read CLAUDE.md if it exists for extra context
  const claudeMdPath = path.join(repoDir, 'CLAUDE.md');
  const claudeMd = fs.existsSync(claudeMdPath) ? fs.readFileSync(claudeMdPath, 'utf8').substring(0, 3000) : '';

  const detectionResult = await runClaudeAgentic(
    `${detectionPrompt}\n\nRepository path: ${repoDir}\n\n${claudeMd ? `Existing CLAUDE.md content:\n${claudeMd}` : 'No CLAUDE.md found — detect everything from source.'}`,
    repoDir,
    600000, // 10 min for detection
    model
  );

  totalCost += detectionResult.cost;
  const architectureMap = detectionResult.success ? detectionResult.result : 'Framework detection failed — proceed without context.';
  const frameworkInfo = extractFrameworkSummary(architectureMap);
  logAndBroadcast(`  [Scan] ✅ Framework Detection done — ${frameworkInfo} ($${detectionResult.cost.toFixed(2)})`);

  // Save to DB
  getDb().prepare('UPDATE scans SET architecture_map = ?, framework_info = ? WHERE id = ?')
    .run(architectureMap, frameworkInfo, scanId);

  // ── Phase 1: Run 10 agents in parallel ──
  logAndBroadcast(`  [Scan] Phase 1: ${SCAN_AGENTS.length} Agents parallel on ${repoName} (${modelInfo.name}, agentic mode)...`);
  agentStatus.forEach(a => a.status = 'running');
  broadcastScanProgress(scanId, { phase: 'agents', agents: agentStatus });

  const MAX_RETRIES = 2;
  const MIN_OUTPUT_CHARS = 500;

  const agentPromises = SCAN_AGENTS.map(async (agent, idx) => {
    const promptFile = path.join(PROMPTS_DIR, `${agent.id}.md`);
    let basePrompt = '';
    if (fs.existsSync(promptFile)) {
      basePrompt = fs.readFileSync(promptFile, 'utf8');
      basePrompt = basePrompt
        .replace(/\{\{REPO_NAME\}\}/g, repoFullName)
        .replace(/\{\{FRAMEWORK_INFO\}\}/g, frameworkInfo)
        .replace(/\{\{ARCHITECTURE_MAP\}\}/g, architectureMap.substring(0, 15000));
    }

    const fullPrompt = `${basePrompt}

CONTEXT: This is a FULL CODEBASE first scan (NOT a PR review, NOT a diff review).
Repository: ${repoFullName}
Path: ${repoDir}
Framework: ${frameworkInfo}
Your Focus: ${agent.focus}

Analyze the ENTIRE codebase. You have full access to ALL files.
Read relevant files — start with the project structure then dive into details.
Begin your report with: ## ${agent.name}

Format per finding:
- **Severity**: 🔴 Critical / 🟡 Warning / 🔵 Info
- **Confidence**: 🔒 CONFIRMED / ⚠️ POTENTIAL / 🔍 NEEDS-VERIFICATION
- **File:Line**: Description
- **Fix Suggestion**: Concrete code

If no issues found: "✅ No ${agent.name} issues found."`;

    agentStatus[idx] = { ...agentStatus[idx], status: 'running' };
    broadcastScanProgress(scanId, { phase: 'agents', agents: agentStatus, totalCost });

    let result = await runClaudeAgentic(fullPrompt, repoDir, 600000, model);
    totalCost += result.cost;

    // Auto-retry on failure or suspiciously short output
    let attempt = 1;
    while (attempt < MAX_RETRIES && (!result.success || (result.result || '').length < MIN_OUTPUT_CHARS)) {
      attempt++;
      const reason = !result.success ? 'FAILED' : 'short output';
      logAndBroadcast(`  [Scan] 🔄 ${agent.name} retry ${attempt}/${MAX_RETRIES} (${reason}: ${(result.result || '').length} chars)`);
      agentStatus[idx] = { ...agentStatus[idx], status: 'retrying', attempt };
      broadcastScanProgress(scanId, { phase: 'agents', agents: agentStatus, totalCost });
      result = await runClaudeAgentic(fullPrompt, repoDir, 600000, model);
      totalCost += result.cost;
    }

    const outputLen = (result.result || '').length;
    if (!result.success) {
      logAndBroadcast(`  [Scan] ❌ ${agent.name} FAILED after ${attempt} attempts: ${result.result.substring(0, 200)}`);
      agentStatus[idx] = { ...agentStatus[idx], status: 'failed', chars: outputLen, cost: result.cost };
    } else if (outputLen < MIN_OUTPUT_CHARS) {
      logAndBroadcast(`  [Scan] ⚠️ ${agent.name} still short after ${attempt} attempts (${outputLen} chars)`);
      agentStatus[idx] = { ...agentStatus[idx], status: 'done', chars: outputLen, cost: result.cost };
    } else {
      logAndBroadcast(`  [Scan] ✅ ${agent.name} done (${outputLen} chars, $${result.cost.toFixed(2)}${attempt > 1 ? `, ${attempt} attempts` : ''})`);
      agentStatus[idx] = { ...agentStatus[idx], status: 'done', chars: outputLen, cost: result.cost };
    }
    broadcastScanProgress(scanId, { phase: 'agents', agents: agentStatus, totalCost });
    return { agent, result };
  });

  const results = await Promise.all(agentPromises);

  // ── Phase 2: Aggregation ──
  logAndBroadcast(`  [Scan] Phase 2: Aggregation...`);
  broadcastScanProgress(scanId, { phase: 'aggregation', agents: agentStatus, totalCost });

  // Save individual agent results to DB
  const agentResultsObj = results.map(r => ({
    id: r.agent.id,
    name: r.agent.name,
    success: r.result.success,
    chars: (r.result.result || '').length,
    cost: r.result.cost,
    durationMs: r.result.durationMs,
    output: r.result.result,
  }));
  getDb().prepare('UPDATE scans SET agent_results = ? WHERE id = ?')
    .run(JSON.stringify(agentResultsObj), scanId);

  const agentResults = results.map(r =>
    `### ${r.agent.name}\n${r.result.result}`
  ).join('\n\n---\n\n');

  // Build the full report (all agents combined with headers)
  const fullReport = `# ${repoFullName} — Full Code Audit Report\nDate: ${new Date().toISOString().split('T')[0]}\nModel: ${modelInfo.name}\nFramework: ${frameworkInfo}\n\n` +
    results.map(r =>
      `${'='.repeat(80)}\n## ${r.agent.id}: ${r.agent.name}\nFocus: ${SCAN_AGENTS.find(a => a.id === r.agent.id)?.focus || ''}\nStatus: ${r.result.success ? 'OK' : 'FAILED'} | ${(r.result.result || '').length} chars | $${r.result.cost.toFixed(2)}\n${'='.repeat(80)}\n\n${r.result.result}`
    ).join('\n\n\n');

  // Save full report to DB
  getDb().prepare('UPDATE scans SET full_report = ? WHERE id = ?')
    .run(fullReport, scanId);

  // Use direct API for aggregation (cheaper, no tool use needed)
  const { runClaude } = await import('@/lib/claude');
  const aggResult = await runClaude(
    `You are creating the final Code Audit Report for "${repoFullName}".

Combine the following ${SCAN_AGENTS.length} agent reports into ONE structured report.

Repository: ${repoFullName}
Framework: ${frameworkInfo}
NOTE: This code may have been partially or fully generated by AI without thorough human review.

⚠️ CRITICAL: Your report MUST include an "Audit Coverage Summary" section at the end. A report WITHOUT the coverage summary is INCOMPLETE.

RULES:
1. Executive Summary at top with TWO counts:
   - CONFIRMED findings: X 🔴 Critical, Y 🟡 Warning, Z 🔵 Info
   - POTENTIAL/NEEDS-VERIFICATION findings: X ⚠️ Total
2. Group findings by CATEGORY (Code Quality, Bugs, Security, etc.)
3. Within each category, create TWO sub-sections:
   a) "🔒 Confirmed Findings" — sorted by severity
   b) "⚠️ Requires Verification" — POTENTIAL and NEEDS-VERIFICATION findings
4. For each finding: Severity, Confidence, File:Line, Category, Description, Fix
5. Section: "AI Code Safety Findings" — highlight Agent 10 results separately
6. Section: "Priority Remediation Roadmap" — top 15 CONFIRMED actions ordered by impact
7. Remove duplicate findings (prefer the version with more detail)
8. Maximum 80 findings total (prioritize CONFIRMED over POTENTIAL)
9. All text in English

FORMAT:
# ${repoFullName} — Code Audit Report
Date: ${new Date().toISOString().split('T')[0]}
Model: ${modelInfo.name}
Framework: ${frameworkInfo}

## Executive Summary
### Confirmed Findings
🔴 X Critical | 🟡 Y Warning | 🔵 Z Info

### Requiring Verification
⚠️ X Potential | 🔍 Y Needs Verification

## Findings by Category

### Code Quality
#### 🔒 Confirmed Findings
...
#### ⚠️ Requires Verification
...

### Bug Analysis
...

### Security
...

### Best Practices
...

### Dead Code
...

### Behavioral Impact
...

### Performance
...

### Test Coverage
...

### Dependencies
...

## ⚠️ AI Code Safety Findings
...

## Priority Remediation Roadmap
...

## Audit Coverage Summary (MANDATORY — DO NOT SKIP)

### Per-Agent Coverage Matrix
| Agent | Files Reviewed | Coverage % | Has Coverage Report? |
|-------|----------------|------------|---------------------|
...

### Summary
**Overall Coverage**: X% of files were reviewed by at least one agent.

AGENT RESULTS:

${agentResults}`,
    repoDir,
    300000
  );

  totalCost += aggResult.cost;
  const duration = Math.round((Date.now() - startTime) / 1000);
  const report = aggResult.success ? aggResult.result : agentResults;

  // ── Save all reports to numbered audit folder ──
  const repoSlug = repoFullName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const repoAuditsDir = path.join(getAuditsDir(), 'code-audits', repoSlug);
  if (!fs.existsSync(repoAuditsDir)) fs.mkdirSync(repoAuditsDir, { recursive: true });

  // Determine next audit number
  const existingAudits = fs.readdirSync(repoAuditsDir)
    .filter(f => f.match(/^\d{2}-scan-/))
    .sort();
  const nextNum = existingAudits.length + 1;
  const numStr = String(nextNum).padStart(2, '0');

  const now = new Date();
  const dateTimeStr = `${now.toISOString().split('T')[0]}_${now.toTimeString().slice(0, 8).replace(/:/g, '-')}`;
  const auditFolderName = `${numStr}-scan-${dateTimeStr}`;
  const auditDir = path.join(repoAuditsDir, auditFolderName);
  fs.mkdirSync(auditDir, { recursive: true });

  // Save architecture/framework detection
  fs.writeFileSync(path.join(auditDir, '00-framework-detection.md'), architectureMap);

  // Save individual agent results
  for (const r of results) {
    const agentFile = path.join(auditDir, `${r.agent.id}.md`);
    fs.writeFileSync(agentFile, `# ${r.agent.name}\n\n${r.result.result}`);
  }

  // Save full combined report (all agents)
  fs.writeFileSync(path.join(auditDir, '11-full-report.md'), fullReport);

  // Save aggregated summary report
  const reportFile = path.join(auditDir, '12-summary-report.md');
  fs.writeFileSync(reportFile, report);

  logAndBroadcast(`  [Scan] 📁 All reports saved to: ${auditDir}`);

  // Update DB
  getDb().prepare(
    `UPDATE scans SET status = ?, duration_seconds = ?, report = ?, report_file = ?, estimated_cost = ?, completed_at = ? WHERE id = ?`
  ).run('completed', duration, report, auditDir, totalCost, new Date().toISOString(), scanId);

  addCost({
    type: 'scan',
    reference_id: scanId,
    repo_id: repoId,
    estimated_tokens: 0,
    estimated_cost: totalCost,
  });

  logAndBroadcast(`✅ First Scan for ${repoFullName} completed (${modelInfo.name}, ${frameworkInfo}, ${duration}s, $${totalCost.toFixed(2)})`);
  logAndBroadcast(`   Audit folder: ${auditDir}`);
  broadcastScanProgress(scanId, { phase: 'done', agents: agentStatus, totalCost, duration });
}

/**
 * Extract a short framework summary from the architecture map output.
 * e.g., "Laravel 12 / PHP 8.4 / MySQL"
 */
function extractFrameworkSummary(architectureMap: string): string {
  // Try to extract from structured output
  const lines = architectureMap.split('\n');
  let framework = '';
  let language = '';
  let db = '';

  for (const line of lines) {
    const l = line.toLowerCase();
    if (l.includes('**framework**') || l.includes('* **framework**')) {
      framework = line.replace(/[^:]*\*\*[Ff]ramework\*\*[:\s]*/i, '').replace(/\*\*/g, '').trim();
    }
    if (l.includes('**language**') || l.includes('* **language**')) {
      language = line.replace(/[^:]*\*\*[Ll]anguage\*\*[:\s]*/i, '').replace(/\*\*/g, '').trim();
    }
    if (l.includes('**database**') || l.includes('* **database**')) {
      db = line.replace(/[^:]*\*\*[Dd]atabase\*\*[:\s]*/i, '').replace(/\*\*/g, '').trim();
    }
  }

  const parts = [framework, language, db].filter(Boolean);
  if (parts.length > 0) return parts.join(' / ');

  // Fallback: scan for common framework names
  const text = architectureMap.substring(0, 5000);
  const frameworks = [
    'Laravel', 'Next\\.js', 'Nuxt', 'Django', 'Rails', 'Spring Boot', 'Express',
    'NestJS', 'FastAPI', 'Flask', 'Symfony', 'Angular', 'React', 'Vue\\.js',
    'Svelte', 'Remix', 'Astro', 'Gatsby',
  ];

  const found: string[] = [];
  for (const fw of frameworks) {
    const regex = new RegExp(`${fw}[\\s]*[\\d.]*`, 'i');
    const match = text.match(regex);
    if (match) found.push(match[0].trim());
  }

  return found.length > 0 ? found.join(' / ') : 'Unknown framework';
}
