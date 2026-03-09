export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getDb, getRepoById, addCost } from '@/lib/db';
import { runClaudeAgentic, AVAILABLE_MODELS, type ModelKey, getKeyValue } from '@/lib/claude';
import { logAndBroadcast, broadcastScanProgress } from '@/lib/websocket';
import fs from 'fs';
import path from 'path';

const PROMPTS_DIR = path.join(process.cwd(), 'prompts', 'first-scan');

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
  { id: '01-code-quality',      name: 'Code Quality',      focus: 'Code smells, duplication, complexity, style inconsistencies, naming',                              deep: true },
  { id: '02-bug-analysis',      name: 'Bug Analysis',      focus: 'Logic errors, edge cases, race conditions, runtime errors, error handling',                        deep: true },
  { id: '03-security',          name: 'Security',          focus: 'XSS, injection, insecure API calls, missing input validation, auth issues',                        deep: true },
  { id: '04-best-practices',    name: 'Best Practices',    focus: 'Framework patterns, conventions, anti-patterns, SOLID principles',                                 deep: true },
  { id: '05-dead-code',         name: 'Dead Code',         focus: 'Unused imports, variables, functions, unreachable code, deprecated code',                           deep: false },
  { id: '06-behavioral-impact', name: 'Behavioral Impact', focus: 'UI bugs, state issues, rendering problems, UX inconsistencies, data integrity',                    deep: true },
  { id: '07-performance',       name: 'Performance',       focus: 'N+1 queries, missing indexes, caching, lazy loading, memory leaks',                                deep: true },
  { id: '08-test-coverage',     name: 'Test Coverage',     focus: 'Missing tests, untested paths, test quality, test suggestions',                                    deep: false },
  { id: '09-dependency-check',  name: 'Dependencies',      focus: 'Outdated packages, CVEs, unnecessary dependencies, license issues',                                deep: false },
  { id: '10-ai-code-safety',    name: 'AI Code Safety',    focus: 'Hallucinated APIs, fake implementations, copy-paste errors, inconsistent auth, missing validation', deep: false },
];

// ── Module Discovery ──
// Discover logical modules by analyzing source directory structure

interface CodeModule {
  name: string;
  dirs: string[];
  lines: number;
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'vendor', 'storage',
  '.idea', '.vscode', '__pycache__', '.cache', 'coverage', '.turbo',
]);

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.php', '.py', '.rb', '.java', '.go',
  '.rs', '.vue', '.svelte', '.cs', '.swift', '.kt', '.scala', '.ex', '.exs',
]);

function countLines(filePath: string): number {
  try {
    return fs.readFileSync(filePath, 'utf8').split('\n').length;
  } catch { return 0; }
}

function countDirLines(dirPath: string): number {
  let total = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += countDirLines(fullPath);
      } else if (CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        total += countLines(fullPath);
      }
    }
  } catch { /* ignore */ }
  return total;
}

function discoverModules(repoDir: string): CodeModule[] {
  // Find top-level source directories with code
  const entries = fs.readdirSync(repoDir, { withFileTypes: true });
  const dirStats: { name: string; lines: number }[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
    const lines = countDirLines(path.join(repoDir, entry.name));
    if (lines > 0) dirStats.push({ name: entry.name, lines });
  }

  // Also count root-level files
  let rootLines = 0;
  for (const entry of entries) {
    if (entry.isFile() && CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      rootLines += countLines(path.join(repoDir, entry.name));
    }
  }

  // Sort by lines descending
  dirStats.sort((a, b) => b.lines - a.lines);
  const totalLines = dirStats.reduce((s, d) => s + d.lines, 0) + rootLines;

  // If small repo (<15k lines) or few dirs, no splitting needed
  if (totalLines < 15000 || dirStats.length <= 2) {
    return [{ name: 'full-repo', dirs: ['.'], lines: totalLines }];
  }

  // Target: 3-5 modules, each 15k-60k lines
  const TARGET_MODULE_LINES = Math.max(15000, Math.ceil(totalLines / 5));
  const modules: CodeModule[] = [];
  let currentModule: CodeModule = { name: '', dirs: [], lines: 0 };

  for (const dir of dirStats) {
    // Large dir becomes its own module
    if (dir.lines >= TARGET_MODULE_LINES) {
      if (currentModule.dirs.length > 0) {
        currentModule.name = currentModule.dirs.length === 1 ? currentModule.dirs[0] : currentModule.dirs.slice(0, 2).join('+');
        modules.push(currentModule);
        currentModule = { name: '', dirs: [], lines: 0 };
      }
      modules.push({ name: dir.name, dirs: [dir.name], lines: dir.lines });
      continue;
    }

    // Accumulate smaller dirs into one module
    currentModule.dirs.push(dir.name);
    currentModule.lines += dir.lines;

    if (currentModule.lines >= TARGET_MODULE_LINES) {
      currentModule.name = currentModule.dirs.length === 1 ? currentModule.dirs[0] : currentModule.dirs.slice(0, 2).join('+');
      modules.push(currentModule);
      currentModule = { name: '', dirs: [], lines: 0 };
    }
  }

  // Add remaining dirs + root files
  if (currentModule.dirs.length > 0 || rootLines > 0) {
    if (rootLines > 0) currentModule.dirs.push('.');
    currentModule.lines += rootLines;
    currentModule.name = currentModule.dirs.length === 1 ? currentModule.dirs[0] : currentModule.dirs.slice(0, 2).join('+');
    if (modules.length > 0) {
      modules.push(currentModule);
    } else {
      // Only small dirs, single module
      modules.push({ name: 'full-repo', dirs: ['.'], lines: totalLines });
    }
  }

  // Cap at 5 modules — merge smallest if over
  while (modules.length > 5) {
    modules.sort((a, b) => a.lines - b.lines);
    const smallest = modules.shift()!;
    modules[0].dirs.push(...smallest.dirs);
    modules[0].lines += smallest.lines;
    modules[0].name = modules[0].dirs.slice(0, 2).join('+');
  }

  return modules;
}

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
  const AGENT_TIMEOUT = 900000; // 15 min per agent (like Security scan)

  // Build initial agent status list
  const agentStatus: Array<{ id: string; name: string; status: string; chars?: number; cost?: number; attempt?: number; subAgents?: number }> =
    SCAN_AGENTS.map(a => ({ id: a.id, name: a.name, status: 'pending' }));

  // ── Phase 0: Framework Detection & Architecture Mapping ──
  logAndBroadcast(`  [Scan] Phase 0: Framework Detection & Architecture Mapping (${modelInfo.name})...`);
  broadcastScanProgress(scanId, { phase: 'mapping', agents: agentStatus });

  const detectionPromptFile = path.join(PROMPTS_DIR, '00-framework-detection.md');
  let detectionPrompt = fs.existsSync(detectionPromptFile) ? fs.readFileSync(detectionPromptFile, 'utf8') : '';
  detectionPrompt = detectionPrompt
    .replace(/\{\{REPO_NAME\}\}/g, repoFullName)
    .replace(/\{\{REPO_DIR\}\}/g, repoDir);

  const claudeMdPath = path.join(repoDir, 'CLAUDE.md');
  const claudeMd = fs.existsSync(claudeMdPath) ? fs.readFileSync(claudeMdPath, 'utf8').substring(0, 3000) : '';

  const detectionResult = await runClaudeAgentic(
    `${detectionPrompt}\n\nRepository path: ${repoDir}\n\n${claudeMd ? `Existing CLAUDE.md content:\n${claudeMd}` : 'No CLAUDE.md found — detect everything from source.'}`,
    repoDir,
    AGENT_TIMEOUT,
    model
  );

  totalCost += detectionResult.cost;
  const architectureMap = detectionResult.success ? detectionResult.result : 'Framework detection failed — proceed without context.';
  const frameworkInfo = extractFrameworkSummary(architectureMap);
  logAndBroadcast(`  [Scan] ✅ Framework Detection done — ${frameworkInfo} ($${detectionResult.cost.toFixed(2)})`);

  getDb().prepare('UPDATE scans SET architecture_map = ?, framework_info = ? WHERE id = ?')
    .run(architectureMap, frameworkInfo, scanId);

  // ── Phase 0.5: Module Discovery ──
  const modules = discoverModules(repoDir);
  const totalLines = modules.reduce((s, m) => s + m.lines, 0);
  const useSubAgents = modules.length > 1;

  if (useSubAgents) {
    logAndBroadcast(`  [Scan] Module Split: ${modules.length} modules detected (${totalLines.toLocaleString()} lines total)`);
    for (const mod of modules) {
      logAndBroadcast(`    → ${mod.name}: ${mod.dirs.join(', ')} (${mod.lines.toLocaleString()} lines)`);
    }
  } else {
    logAndBroadcast(`  [Scan] Single-module repo (${totalLines.toLocaleString()} lines) — no sub-agent splitting`);
  }

  // ── Phase 1: Run agents (with sub-agents for deep agents on large repos) ──
  const deepAgentCount = SCAN_AGENTS.filter(a => a.deep).length;
  const totalSubAgents = useSubAgents
    ? deepAgentCount * modules.length + SCAN_AGENTS.filter(a => !a.deep).length
    : SCAN_AGENTS.length;

  logAndBroadcast(`  [Scan] Phase 1: ${SCAN_AGENTS.length} Agents${useSubAgents ? ` (${totalSubAgents} total sub-agents)` : ''} on ${repoName} (${modelInfo.name}, agentic mode)...`);
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

    agentStatus[idx] = { ...agentStatus[idx], status: 'running' };
    broadcastScanProgress(scanId, { phase: 'agents', agents: agentStatus, totalCost });

    // ── Deep agents with sub-agents per module ──
    if (agent.deep && useSubAgents) {
      logAndBroadcast(`    [${agent.id}] ${modules.length} sub-agents (deep scan per module)`);
      agentStatus[idx] = { ...agentStatus[idx], subAgents: modules.length };

      const subPromises = modules.map(mod => {
        const dirsList = mod.dirs.map(d => d === '.' ? repoDir : path.join(repoDir, d)).join(', ');
        const subPrompt = `${basePrompt}

CONTEXT: This is a FULL CODEBASE first scan (NOT a PR review, NOT a diff review).
Repository: ${repoFullName}
Path: ${repoDir}
Framework: ${frameworkInfo}
Your Focus: ${agent.focus}

⚠️ MODULE ASSIGNMENT: You are Sub-Agent for module "${mod.name}".
Focus ONLY on files in these directories: ${dirsList}
Do NOT analyze files outside your assigned directories.

Analyze ALL source files in your assigned directories thoroughly.
Read relevant files — start with the directory structure then dive into details.
Begin your report with: ## ${agent.name} — Module: ${mod.name}

Format per finding:
- **Severity**: 🔴 Critical / 🟡 Warning / 🔵 Info
- **Confidence**: 🔒 CONFIRMED / ⚠️ POTENTIAL / 🔍 NEEDS-VERIFICATION
- **File:Line**: Description
- **Fix Suggestion**: Concrete code

End with a Coverage Report listing ALL files you reviewed.
If no issues found: "✅ No ${agent.name} issues found in ${mod.name}."`;

        return runClaudeAgentic(subPrompt, repoDir, AGENT_TIMEOUT, model);
      });

      const subResults = await Promise.all(subPromises);
      let agentCost = 0;
      const subOutputs: string[] = [];

      for (let i = 0; i < subResults.length; i++) {
        const sub = subResults[i];
        agentCost += sub.cost;
        totalCost += sub.cost;
        if (sub.success) {
          subOutputs.push(sub.result);
        } else {
          subOutputs.push(`## ${agent.name} — Module: ${modules[i].name}\n❌ Sub-agent failed: ${sub.result.substring(0, 200)}`);
        }
      }

      // Merge sub-agent results
      let mergedResult = subOutputs.join('\n\n---\n\n');

      // If >2 sub-agents, do a per-agent merge to deduplicate
      if (modules.length > 2) {
        logAndBroadcast(`    [${agent.id}] Merging ${modules.length} sub-agent results...`);
        const mergeResult = await runClaudeAgentic(
          `Merge the following ${modules.length} sub-agent reports for the ${agent.name} analysis of ${repoFullName}.

Remove duplicates. Keep all unique findings. Sort by severity.
Preserve the Coverage Reports from each sub-agent and combine them.

Begin with: ## ${agent.name}

${mergedResult}`,
          repoDir,
          AGENT_TIMEOUT,
          model
        );
        agentCost += mergeResult.cost;
        totalCost += mergeResult.cost;
        if (mergeResult.success) mergedResult = mergeResult.result;
      }

      const outputLen = mergedResult.length;
      logAndBroadcast(`  [Scan] ✅ ${agent.name} done (${modules.length} sub-agents, ${outputLen} chars, $${agentCost.toFixed(2)})`);
      agentStatus[idx] = { ...agentStatus[idx], status: 'done', chars: outputLen, cost: agentCost, subAgents: modules.length };
      broadcastScanProgress(scanId, { phase: 'agents', agents: agentStatus, totalCost });

      return { agent, result: { success: true, result: mergedResult, cost: agentCost, durationMs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    }

    // ── Holistic agents (single agent, full repo) ──
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

    let result = await runClaudeAgentic(fullPrompt, repoDir, AGENT_TIMEOUT, model);
    totalCost += result.cost;

    let attempt = 1;
    while (attempt < MAX_RETRIES && (!result.success || (result.result || '').length < MIN_OUTPUT_CHARS)) {
      attempt++;
      const reason = !result.success ? 'FAILED' : 'short output';
      logAndBroadcast(`  [Scan] 🔄 ${agent.name} retry ${attempt}/${MAX_RETRIES} (${reason}: ${(result.result || '').length} chars)`);
      agentStatus[idx] = { ...agentStatus[idx], status: 'retrying', attempt };
      broadcastScanProgress(scanId, { phase: 'agents', agents: agentStatus, totalCost });
      result = await runClaudeAgentic(fullPrompt, repoDir, AGENT_TIMEOUT, model);
      totalCost += result.cost;
    }

    const outputLen = (result.result || '').length;
    if (!result.success) {
      logAndBroadcast(`  [Scan] ❌ ${agent.name} FAILED after ${attempt} attempts: ${result.result.substring(0, 200)}`);
      agentStatus[idx] = { ...agentStatus[idx], status: 'failed', chars: outputLen, cost: result.cost };
    } else {
      logAndBroadcast(`  [Scan] ✅ ${agent.name} done (${outputLen} chars, $${result.cost.toFixed(2)}${attempt > 1 ? `, ${attempt} attempts` : ''})`);
      agentStatus[idx] = { ...agentStatus[idx], status: 'done', chars: outputLen, cost: result.cost };
    }
    broadcastScanProgress(scanId, { phase: 'agents', agents: agentStatus, totalCost });
    return { agent, result };
  });

  const results = await Promise.all(agentPromises);

  // ── Phase 2: Aggregation (agentic mode with selected model for 1M context) ──
  logAndBroadcast(`  [Scan] Phase 2: Aggregation (${modelInfo.name}, agentic mode)...`);
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
  const fullReport = `# ${repoFullName} — Full Code Audit Report\nDate: ${new Date().toISOString().split('T')[0]}\nModel: ${modelInfo.name}\nFramework: ${frameworkInfo}\nModules: ${modules.map(m => `${m.name} (${m.lines} lines)`).join(', ')}\n\n` +
    results.map(r =>
      `${'='.repeat(80)}\n## ${r.agent.id}: ${r.agent.name}\nFocus: ${SCAN_AGENTS.find(a => a.id === r.agent.id)?.focus || ''}\nDeep: ${SCAN_AGENTS.find(a => a.id === r.agent.id)?.deep ? 'Yes (sub-agents)' : 'No (holistic)'}\nStatus: ${r.result.success ? 'OK' : 'FAILED'} | ${(r.result.result || '').length} chars | $${r.result.cost.toFixed(2)}\n${'='.repeat(80)}\n\n${r.result.result}`
    ).join('\n\n\n');

  getDb().prepare('UPDATE scans SET full_report = ? WHERE id = ?')
    .run(fullReport, scanId);

  // Agentic aggregation with selected model (1M context support)
  const aggResult = await runClaudeAgentic(
    `You are creating the final Code Audit Report for "${repoFullName}".

Combine the following ${SCAN_AGENTS.length} agent reports into ONE structured report.

Repository: ${repoFullName}
Framework: ${frameworkInfo}
Modules scanned: ${modules.map(m => m.name).join(', ')}
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
| Agent | Type | Sub-Agents | Files Reviewed | Coverage % | Has Coverage Report? |
|-------|------|------------|----------------|------------|---------------------|
...

### Summary
**Overall Coverage**: X% of files were reviewed by at least one agent.

AGENT RESULTS:

${agentResults}`,
    repoDir,
    AGENT_TIMEOUT,
    model
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
