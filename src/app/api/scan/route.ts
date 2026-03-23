export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getDb, getRepoById, addCost } from '@/lib/db';
import { runClaudeAgentic, AVAILABLE_MODELS, type ModelKey, getKeyValue } from '@/lib/claude';
import { logAndBroadcast, broadcastScanProgress } from '@/lib/websocket';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const PROMPTS_BASE_DIR = path.join(process.cwd(), 'prompts', 'first-scan');

// ── Framework Presets ──
// Each preset maps to a prompt directory under prompts/first-scan/<dir>/
const FRAMEWORK_PRESETS: Record<string, { name: string; promptDir: string }> = {
  'laravel-vue': { name: 'Laravel 12 + Blade + Vue', promptDir: 'laravel' },
  'nodejs-react': { name: 'Node.js + React', promptDir: 'nodejs-react' },
  'generic': { name: 'Auto-Detect (Generic)', promptDir: 'generic' },
};

function getPromptsDir(framework: string): string {
  const preset = FRAMEWORK_PRESETS[framework];
  if (preset) {
    const dir = path.join(PROMPTS_BASE_DIR, preset.promptDir);
    if (fs.existsSync(dir)) return dir;
  }
  // Fallback to generic
  return path.join(PROMPTS_BASE_DIR, 'generic');
}

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
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      updateRepo(repo.id, { local_path: candidate } as any);
      logAndBroadcast(`  [Scan] Updated repo path: ${candidate}`);
      return candidate;
    }
  }
  return null;
}

// First Scan agent definitions — overlap-free responsibilities
const SCAN_AGENTS = [
  { id: '01-code-quality',      name: 'Code Quality',           focus: 'Naming, readability, duplication, complexity metrics, style consistency',                                   deep: true },
  { id: '02-bug-analysis',      name: 'Bug Analysis',           focus: 'Logic errors, null/type issues, off-by-one, race conditions, unhandled exceptions',                         deep: true },
  { id: '03-security',          name: 'Security',               focus: 'ALL security: injection, XSS, CSRF, auth consistency, mass assignment, input validation, data exposure',     deep: true },
  { id: '04-best-practices',    name: 'Framework Patterns',     focus: 'Framework-specific patterns, architecture, layer separation, SOLID, DI, conventions',                       deep: true },
  { id: '05-dead-code',         name: 'Dead Code',              focus: 'Unused imports, variables, functions, unreachable code, deprecated code, framework-aware detection',         deep: false },
  { id: '06-behavioral-impact', name: 'Behavioral Impact',      focus: 'API response consistency, validation UX, queue/job reliability, data integrity, state consistency',          deep: true },
  { id: '07-performance',       name: 'Performance',            focus: 'N+1 queries, missing indexes/eager loading, caching, memory leaks, query optimization',                     deep: true },
  { id: '08-test-coverage',     name: 'Test Coverage',          focus: 'Missing tests, untested critical paths, test quality, test suggestions',                                    deep: false },
  { id: '09-dependency-check',  name: 'Dependencies',           focus: 'Outdated packages, CVEs, unnecessary dependencies, license issues',                                        deep: false },
  { id: '10-ai-code-safety',    name: 'AI Code Safety',         focus: 'Hallucinated APIs, fake implementations, copy-paste errors, over-engineering, inconsistent patterns',        deep: false },
];

/**
 * Pre-flight checks before starting a first scan.
 * Returns an array of error messages. Empty = all checks passed.
 */
function runPreFlightChecks(repoDir: string, framework: string): string[] {
  const errors: string[] = [];

  // 1. Check prompt files exist for selected framework
  const promptsDir = getPromptsDir(framework);
  const detectionPrompt = path.join(promptsDir, '00-framework-detection.md');
  if (!fs.existsSync(detectionPrompt)) {
    errors.push(`Prompt-Dateien nicht gefunden: ${promptsDir} existiert nicht`);
  } else {
    const missingPrompts = SCAN_AGENTS
      .map(a => a.id)
      .filter(id => !fs.existsSync(path.join(promptsDir, `${id}.md`)));
    if (missingPrompts.length > 0) {
      errors.push(`Fehlende Agent-Prompts: ${missingPrompts.join(', ')}`);
    }
  }

  // 2. Check Claude CLI available
  try {
    execSync('which claude', { timeout: 5000, stdio: 'pipe' });
  } catch {
    errors.push('Claude CLI nicht gefunden. Bitte installieren: npm install -g @anthropic-ai/claude-code');
  }

  // 3. Check SSH known_hosts for github.com (auto-fix)
  const sshDir = path.join(process.env.HOME || '~', '.ssh');
  const knownHostsFile = path.join(sshDir, 'known_hosts');
  let githubKnown = false;
  if (fs.existsSync(knownHostsFile)) {
    githubKnown = fs.readFileSync(knownHostsFile, 'utf8').includes('github.com');
  }
  if (!githubKnown) {
    try {
      if (!fs.existsSync(sshDir)) fs.mkdirSync(sshDir, { mode: 0o700, recursive: true });
      const keys = execSync('ssh-keyscan -t ed25519 github.com 2>/dev/null', { timeout: 10000, stdio: 'pipe' }).toString();
      if (keys.trim()) {
        fs.appendFileSync(knownHostsFile, keys);
        logAndBroadcast('  [Scan] ✅ GitHub SSH key added to known_hosts');
      } else {
        errors.push('GitHub SSH-Key konnte nicht abgerufen werden. Manuell: ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts');
      }
    } catch {
      errors.push('GitHub SSH-Key konnte nicht hinzugefügt werden. Manuell: ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts');
    }
  }

  // 4. Check repo directory exists (git is optional — plain folders are supported for scans)
  if (!fs.existsSync(repoDir)) {
    errors.push(`Repo-Verzeichnis nicht gefunden: ${repoDir}`);
  }

  // 5. Check ANTHROPIC_API_KEY is set
  const apiKey = getKeyValue('ANTHROPIC_API_KEY') || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    errors.push('ANTHROPIC_API_KEY nicht gesetzt. Unter Settings konfigurieren.');
  }

  return errors;
}

// ── Module Discovery ──
// Discover logical modules by analyzing source directory structure

interface CodeModule {
  name: string;
  dirs: string[];
  lines: number;
  files: string[];  // All source files in this module (relative to repoDir)
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'vendor', 'storage',
  '.idea', '.vscode', '__pycache__', '.cache', 'coverage', '.turbo',
]);

const CODE_EXTENSIONS = new Set([
  // Primary code
  '.ts', '.tsx', '.js', '.jsx', '.php', '.py', '.rb', '.java', '.go',
  '.rs', '.vue', '.svelte', '.cs', '.swift', '.kt', '.scala', '.ex', '.exs',
  // Templates & markup
  '.twig', '.hbs', '.ejs', '.pug',
]);

// Config files: included in manifest (for dependency/security audits) but excluded from coverage %
const CONFIG_EXTENSIONS = new Set([
  '.json', '.yaml', '.yml', '.xml', '.toml',
]);

// Combined set for file collection
const ALL_SCANNABLE_EXTENSIONS = new Set([...CODE_EXTENSIONS, ...CONFIG_EXTENSIONS]);

// Files to exclude even if their extension matches (lock files, generated files)
const SKIP_FILES = new Set([
  'package-lock.json', 'composer.lock', 'yarn.lock', 'pnpm-lock.yaml',
  'bun.lockb', 'Gemfile.lock', 'poetry.lock', 'Cargo.lock',
  'phpunit.xml.dist', '.phpunit.result.cache',
]);

function countLines(filePath: string): number {
  try {
    const buf = fs.readFileSync(filePath);
    let count = 1;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0A) count++;
    }
    return count;
  } catch { return 0; }
}

/**
 * Collect all source files in a directory recursively.
 * Returns paths relative to repoDir.
 */
function collectSourceFiles(dirPath: string, repoDir: string): string[] {
  const files: string[] = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        files.push(...collectSourceFiles(fullPath, repoDir));
      } else if (ALL_SCANNABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && !SKIP_FILES.has(entry.name)) {
        files.push(path.relative(repoDir, fullPath));
      }
    }
  } catch { /* ignore */ }
  return files;
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
      } else if (ALL_SCANNABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && !SKIP_FILES.has(entry.name)) {
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
    if (entry.isFile() && ALL_SCANNABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && !SKIP_FILES.has(entry.name)) {
      rootLines += countLines(path.join(repoDir, entry.name));
    }
  }

  // Sort by lines descending
  dirStats.sort((a, b) => b.lines - a.lines);
  const totalLines = dirStats.reduce((s, d) => s + d.lines, 0) + rootLines;

  // If small repo (<15k lines) or few dirs, no splitting needed
  if (totalLines < 15000 || dirStats.length <= 2) {
    const allFiles = collectSourceFiles(repoDir, repoDir);
    return [{ name: 'full-repo', dirs: ['.'], lines: totalLines, files: allFiles }];
  }

  // Target: 8-10 modules of ~15k lines each for thorough per-agent review
  const TARGET_MODULE_LINES = Math.max(10000, Math.ceil(totalLines / 10));
  const modules: CodeModule[] = [];
  let currentModule: CodeModule = { name: '', dirs: [], lines: 0, files: [] };

  for (const dir of dirStats) {
    // Large dir: split into subdirectories if it exceeds the target
    if (dir.lines >= TARGET_MODULE_LINES) {
      // Flush any accumulated small dirs first
      if (currentModule.dirs.length > 0) {
        currentModule.name = currentModule.dirs.length === 1 ? currentModule.dirs[0] : currentModule.dirs.slice(0, 2).join('+');
        modules.push(currentModule);
        currentModule = { name: '', dirs: [], lines: 0, files: [] };
      }

      // Try to split large directory by its subdirectories
      const subEntries = fs.readdirSync(path.join(repoDir, dir.name), { withFileTypes: true });
      const subDirStats: { name: string; relPath: string; lines: number }[] = [];
      let dirRootLines = 0;

      for (const sub of subEntries) {
        if (sub.isDirectory() && !SKIP_DIRS.has(sub.name)) {
          const subLines = countDirLines(path.join(repoDir, dir.name, sub.name));
          if (subLines > 0) subDirStats.push({ name: sub.name, relPath: `${dir.name}/${sub.name}`, lines: subLines });
        } else if (sub.isFile() && ALL_SCANNABLE_EXTENSIONS.has(path.extname(sub.name).toLowerCase()) && !SKIP_FILES.has(sub.name)) {
          dirRootLines += countLines(path.join(repoDir, dir.name, sub.name));
        }
      }

      // Only split if there are enough subdirs to make it worthwhile
      if (subDirStats.length >= 2) {
        subDirStats.sort((a, b) => b.lines - a.lines);
        let subModule: CodeModule = { name: '', dirs: [], lines: 0, files: [] };

        for (const sub of subDirStats) {
          // Large subdir becomes its own module
          if (sub.lines >= TARGET_MODULE_LINES) {
            if (subModule.dirs.length > 0) {
              subModule.name = subModule.dirs.length === 1 ? subModule.dirs[0].replace('/', '-') : subModule.dirs.slice(0, 2).map(d => d.split('/').pop()).join('+');
              modules.push(subModule);
              subModule = { name: '', dirs: [], lines: 0, files: [] };
            }
            const subFiles = collectSourceFiles(path.join(repoDir, sub.relPath), repoDir);
            modules.push({ name: sub.relPath.replace('/', '-'), dirs: [sub.relPath], lines: sub.lines, files: subFiles });
            continue;
          }

          subModule.dirs.push(sub.relPath);
          subModule.lines += sub.lines;
          subModule.files.push(...collectSourceFiles(path.join(repoDir, sub.relPath), repoDir));

          if (subModule.lines >= TARGET_MODULE_LINES) {
            subModule.name = subModule.dirs.length === 1 ? subModule.dirs[0].replace('/', '-') : subModule.dirs.slice(0, 2).map(d => d.split('/').pop()).join('+');
            modules.push(subModule);
            subModule = { name: '', dirs: [], lines: 0, files: [] };
          }
        }

        // Add root-level files of the large dir to the last sub-module
        if (dirRootLines > 0) {
          for (const sub of subEntries) {
            if (sub.isFile() && ALL_SCANNABLE_EXTENSIONS.has(path.extname(sub.name).toLowerCase()) && !SKIP_FILES.has(sub.name)) {
              subModule.files.push(path.relative(repoDir, path.join(repoDir, dir.name, sub.name)));
            }
          }
          subModule.dirs.push(dir.name);
          subModule.lines += dirRootLines;
        }

        if (subModule.dirs.length > 0) {
          subModule.name = subModule.dirs.length === 1 ? subModule.dirs[0].replace('/', '-') : subModule.dirs.slice(0, 2).map(d => d.split('/').pop()).join('+');
          modules.push(subModule);
        }
      } else {
        // Not enough subdirs to split — keep as single module
        const dirFiles = collectSourceFiles(path.join(repoDir, dir.name), repoDir);
        modules.push({ name: dir.name, dirs: [dir.name], lines: dir.lines, files: dirFiles });
      }
      continue;
    }

    // Accumulate smaller dirs into one module
    currentModule.dirs.push(dir.name);
    currentModule.lines += dir.lines;
    currentModule.files.push(...collectSourceFiles(path.join(repoDir, dir.name), repoDir));

    if (currentModule.lines >= TARGET_MODULE_LINES) {
      currentModule.name = currentModule.dirs.length === 1 ? currentModule.dirs[0] : currentModule.dirs.slice(0, 2).join('+');
      modules.push(currentModule);
      currentModule = { name: '', dirs: [], lines: 0, files: [] };
    }
  }

  // Add remaining dirs + root files
  if (currentModule.dirs.length > 0 || rootLines > 0) {
    if (rootLines > 0) {
      currentModule.dirs.push('.');
      // Collect root-level files only
      for (const entry of entries) {
        if (entry.isFile() && ALL_SCANNABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && !SKIP_FILES.has(entry.name)) {
          currentModule.files.push(entry.name);
        }
      }
    }
    currentModule.lines += rootLines;
    currentModule.name = currentModule.dirs.length === 1 ? currentModule.dirs[0] : currentModule.dirs.slice(0, 2).join('+');
    if (modules.length > 0) {
      modules.push(currentModule);
    } else {
      // Only small dirs, single module
      const allFiles = collectSourceFiles(repoDir, repoDir);
      modules.push({ name: 'full-repo', dirs: ['.'], lines: totalLines, files: allFiles });
    }
  }

  // Cap at 10 modules — merge smallest if over
  while (modules.length > 10) {
    modules.sort((a, b) => a.lines - b.lines);
    const smallest = modules.shift()!;
    modules[0].dirs.push(...smallest.dirs);
    modules[0].lines += smallest.lines;
    modules[0].files.push(...smallest.files);
    modules[0].name = modules[0].dirs.slice(0, 2).map(d => d.split('/').pop()).join('+');
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
  // Return available models, framework presets, and recent scans for the UI
  const models = Object.entries(AVAILABLE_MODELS).map(([key, val]) => ({
    key,
    name: val.name,
    context: val.context,
    costPer1MInput: val.costPer1MInput,
    costPer1MOutput: val.costPer1MOutput,
  }));
  const frameworks = Object.entries(FRAMEWORK_PRESETS).map(([key, val]) => ({
    key,
    name: val.name,
  }));
  return NextResponse.json({ models, frameworks });
}

export async function POST(req: NextRequest) {
  ensureScanColumns();
  const { repoId, model, framework } = await req.json();
  const selectedModel: ModelKey = (model && model in AVAILABLE_MODELS) ? model : 'sonnet';
  const selectedFramework: string = (framework && framework in FRAMEWORK_PRESETS) ? framework : 'generic';

  const repo = getRepoById(repoId);
  if (!repo) return NextResponse.json({ error: 'Repo not found' }, { status: 404 });

  const repoDir = resolveRepoDir(repo);
  if (!repoDir) {
    return NextResponse.json({ error: `Repo directory not found. Checked: ${repo.local_path} and REPOS_DIR. Update the path in Settings or re-clone.` }, { status: 404 });
  }

  // Pre-flight checks
  const preFlightErrors = runPreFlightChecks(repoDir, selectedFramework);
  if (preFlightErrors.length > 0) {
    return NextResponse.json({
      error: 'Pre-Flight-Check fehlgeschlagen',
      details: preFlightErrors,
    }, { status: 400 });
  }

  const modelInfo = AVAILABLE_MODELS[selectedModel];

  // Create scan record with model info
  const result = getDb().prepare(
    `INSERT INTO scans (repo_id, status, total_agents, model) VALUES (?, 'running', ?, ?)`
  ).run(repoId, SCAN_AGENTS.length, selectedModel);
  const scanId = result.lastInsertRowid as number;

  const frameworkName = FRAMEWORK_PRESETS[selectedFramework]?.name || 'Auto-Detect';
  logAndBroadcast(`🔍 First Scan started for ${repo.full_name} with ${modelInfo.name} (${frameworkName}, ${SCAN_AGENTS.length} agents)...`);

  // Run scan asynchronously
  runFullScan(scanId, repo.id, repo.name, repo.full_name, repoDir, selectedModel, selectedFramework).catch(e => {
    const errMsg = e instanceof Error ? e.message : String(e);
    const errStack = e instanceof Error ? e.stack : '';
    logAndBroadcast(`❌ First Scan failed: ${errMsg}`);
    if (errStack) console.error(`[First Scan] Stack trace for scan ${scanId}:\n${errStack}`);
    getDb().prepare('UPDATE scans SET status = ? WHERE id = ?').run('failed', scanId);
  });

  return NextResponse.json({ scanId, status: 'started', model: selectedModel, framework: selectedFramework });
}

async function runFullScan(
  scanId: number, repoId: number, repoName: string, repoFullName: string, repoDir: string, model: ModelKey, framework: string
) {
  const startTime = Date.now();
  let totalCost = 0;
  let aborted = false;
  const modelInfo = AVAILABLE_MODELS[model];
  const AGENT_TIMEOUT = 600000;    // 10 min per agent
  const MAX_SCAN_DURATION_MS = 45 * 60 * 1000; // 45 min total
  const promptsDir = getPromptsDir(framework);
  const frameworkName = FRAMEWORK_PRESETS[framework]?.name || 'Auto-Detect';

  logAndBroadcast(`  [Scan] Using ${frameworkName} prompts from: ${path.basename(promptsDir)}/`);

  // Build initial agent status list
  const agentStatus: Array<{ id: string; name: string; status: string; chars?: number; cost?: number; attempt?: number; subAgents?: number }> =
    SCAN_AGENTS.map(a => ({ id: a.id, name: a.name, status: 'pending' }));

  // ── Phase 0: Framework Detection & Architecture Mapping ──
  logAndBroadcast(`  [Scan] Phase 0: Framework Detection & Architecture Mapping (${modelInfo.name})...`);
  broadcastScanProgress(scanId, { phase: 'mapping', agents: agentStatus });

  const detectionPromptFile = path.join(promptsDir, '00-framework-detection.md');
  let detectionPrompt = fs.existsSync(detectionPromptFile) ? fs.readFileSync(detectionPromptFile, 'utf8') : '';
  detectionPrompt = detectionPrompt
    .replace(/\{\{REPO_NAME\}\}/g, repoFullName)
    .replace(/\{\{REPO_DIR\}\}/g, repoDir);

  const claudeMdPath = path.join(repoDir, 'CLAUDE.md');
  const claudeMd = fs.existsSync(claudeMdPath) ? fs.readFileSync(claudeMdPath, 'utf8').substring(0, 3000) : '';

  // Ensure audits base dir exists for detection output file
  const detectionOutputDir = path.join(getAuditsDir(), 'code-audits');
  if (!fs.existsSync(detectionOutputDir)) fs.mkdirSync(detectionOutputDir, { recursive: true });
  const detectionOutputFile = path.join(detectionOutputDir, `_detection-${scanId}.md`);

  const detectionResult = await runClaudeAgentic(
    `${detectionPrompt}\n\nRepository path: ${repoDir}\n\n${claudeMd ? `Existing CLAUDE.md content:\n${claudeMd}` : 'No CLAUDE.md found — detect everything from source.'}

OUTPUT INSTRUCTIONS (MANDATORY):
1. Write your COMPLETE framework detection and architecture map to this file: ${detectionOutputFile}
2. Do NOT write files to any other location.
3. Your text response should be a brief summary only — the detailed map goes in the file.`,
    repoDir,
    AGENT_TIMEOUT,
    model
  );

  totalCost += detectionResult.cost;

  // Prefer file output over result text
  let architectureMap = detectionResult.success ? detectionResult.result : 'Framework detection failed — proceed without context.';
  if (fs.existsSync(detectionOutputFile)) {
    const fileContent = fs.readFileSync(detectionOutputFile, 'utf8');
    if (fileContent.length > architectureMap.length) {
      logAndBroadcast(`  [Scan] 📄 Framework Detection: using file output (${fileContent.length} chars) over result text (${architectureMap.length} chars)`);
      architectureMap = fileContent;
    }
    try { fs.unlinkSync(detectionOutputFile); } catch { /* ignore */ }
  }
  const frameworkInfo = extractFrameworkSummary(architectureMap);
  logAndBroadcast(`  [Scan] ✅ Framework Detection done — ${frameworkInfo} ($${detectionResult.cost.toFixed(2)})`);

  getDb().prepare('UPDATE scans SET architecture_map = ?, framework_info = ? WHERE id = ?')
    .run(architectureMap, frameworkInfo, scanId);

  // ── Phase 0.5: Module Discovery & File Manifest ──
  const modules = discoverModules(repoDir);
  const totalLines = modules.reduce((s, m) => s + m.lines, 0);
  const allSourceFiles = new Set(modules.flatMap(m => m.files));
  const totalFiles = allSourceFiles.size;
  const useSubAgents = modules.length > 1;

  if (useSubAgents) {
    logAndBroadcast(`  [Scan] Module Split: ${modules.length} modules, ${totalFiles} files (${totalLines.toLocaleString()} lines total)`);
    for (const mod of modules) {
      logAndBroadcast(`    → ${mod.name}: ${mod.dirs.join(', ')} (${mod.files.length} files, ${mod.lines.toLocaleString()} lines)`);
    }
  } else {
    logAndBroadcast(`  [Scan] Single-module repo (${totalFiles} files, ${totalLines.toLocaleString()} lines) — no sub-agent splitting`);
  }

  // ── Create audit directory BEFORE agents run (so agents can write files there) ──
  const repoSlug = repoFullName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const repoAuditsDir = path.join(getAuditsDir(), 'code-audits', repoSlug);
  if (!fs.existsSync(repoAuditsDir)) fs.mkdirSync(repoAuditsDir, { recursive: true });

  const now = new Date();
  const dateTimeStr = now.toISOString().replace(/[:.]/g, '-');
  const auditFolderName = `scan-${dateTimeStr}-${scanId}`;
  const auditDir = path.join(repoAuditsDir, auditFolderName);
  fs.mkdirSync(auditDir, { recursive: true });

  // Save architecture/framework detection
  fs.writeFileSync(path.join(auditDir, '00-framework-detection.md'), architectureMap);

  // Save file manifest for coverage tracking
  const manifestContent = modules.map(m =>
    `## Module: ${m.name} (${m.files.length} files)\n${m.files.map(f => `- ${f}`).join('\n')}`
  ).join('\n\n');
  fs.writeFileSync(path.join(auditDir, '00-file-manifest.md'), `# File Manifest\nTotal: ${totalFiles} source files\n\n${manifestContent}`);
  logAndBroadcast(`  [Scan] 📁 Audit folder: ${auditDir}`);

  // ── Phase 1: Run agents (with sub-agents for deep agents on large repos) ──
  const deepAgentCount = SCAN_AGENTS.filter(a => a.deep).length;
  const totalSubAgents = useSubAgents
    ? deepAgentCount * modules.length + SCAN_AGENTS.filter(a => !a.deep).length
    : SCAN_AGENTS.length;

  logAndBroadcast(`  [Scan] Phase 1: ${SCAN_AGENTS.length} Agents${useSubAgents ? ` (${totalSubAgents} total sub-agents)` : ''} on ${repoName} (${modelInfo.name}, agentic mode)...`);
  agentStatus.forEach(a => a.status = 'running');
  broadcastScanProgress(scanId, { phase: 'agents', agents: agentStatus });

  const MAX_RETRIES = 3;
  const MIN_OUTPUT_CHARS = 500;
  const RETRY_DELAY_MS = 30000;

  // Pre-compute holistic manifest block once (used by all holistic agents)
  const allFilesList = Array.from(allSourceFiles);
  const MAX_INLINE_FILES_HOLISTIC = 300;
  const holisticManifestBlock = allFilesList.length <= MAX_INLINE_FILES_HOLISTIC
    ? `\n📋 FILE MANIFEST (${allFilesList.length} files in this repo):\n${allFilesList.map(f => `- ${f}`).join('\n')}`
    : `\n📋 FILE MANIFEST (${allFilesList.length} files — full list in: ${path.join(auditDir, '00-file-manifest.md')}):\nFirst ${MAX_INLINE_FILES_HOLISTIC} files:\n${allFilesList.slice(0, MAX_INLINE_FILES_HOLISTIC).map(f => `- ${f}`).join('\n')}\n... and ${allFilesList.length - MAX_INLINE_FILES_HOLISTIC} more (see manifest file)`;

  const agentPromises = SCAN_AGENTS.map(async (agent, idx) => {
    const promptFile = path.join(promptsDir, `${agent.id}.md`);
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
      // Check safety limits before starting sub-agents
      if (aborted) {
        agentStatus[idx] = { ...agentStatus[idx], status: 'skipped' };
        return { agent, result: { success: false, result: 'Skipped: scan aborted', durationMs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 } };
      }

      logAndBroadcast(`    [${agent.id}] ${modules.length} sub-agents (deep scan per module)`);
      agentStatus[idx] = { ...agentStatus[idx], subAgents: modules.length };

      const subPromises = modules.map(mod => {
        const dirsList = mod.dirs.map(d => d === '.' ? repoDir : path.join(repoDir, d)).join(', ');
        const safeModName = mod.name.replace(/[^a-zA-Z0-9_-]+/g, '-');
        const subOutputFile = path.join(auditDir, `${agent.id}-${safeModName}.md`);

        // Build file manifest for this module (cap at 200 inline, reference manifest file for larger)
        const MAX_INLINE_FILES = 200;
        let fileManifestBlock: string;
        if (mod.files.length <= MAX_INLINE_FILES) {
          fileManifestBlock = `\n📋 FILE MANIFEST (${mod.files.length} files — you MUST review ALL of these):\n${mod.files.map(f => `- ${f}`).join('\n')}`;
        } else {
          fileManifestBlock = `\n📋 FILE MANIFEST (${mod.files.length} files — you MUST review ALL of these):\nFirst ${MAX_INLINE_FILES} files listed here, full list in: ${path.join(auditDir, '00-file-manifest.md')}\n${mod.files.slice(0, MAX_INLINE_FILES).map(f => `- ${f}`).join('\n')}\n... and ${mod.files.length - MAX_INLINE_FILES} more (see manifest file)`;
        }

        const subPrompt = `${basePrompt}

CONTEXT: This is a FULL CODEBASE first scan (NOT a PR review, NOT a diff review).
Repository: ${repoFullName}
Path: ${repoDir}
Framework: ${frameworkInfo}
Your Focus: ${agent.focus}

⚠️ MODULE ASSIGNMENT: You are Sub-Agent for module "${mod.name}".
Focus ONLY on files in these directories: ${dirsList}
Do NOT analyze files outside your assigned directories.
${fileManifestBlock}

Analyze ALL source files in your assigned directories thoroughly.
Read EVERY file from the manifest above — start with the directory structure then dive into each file.
Begin your report with: ## ${agent.name} — Module: ${mod.name}

Format per finding:
- **Severity**: 🔴 Critical / 🟡 Warning / 🔵 Info
- **Confidence**: 🔒 CONFIRMED / ⚠️ POTENTIAL / 🔍 NEEDS-VERIFICATION
- **File:Line**: Description
- **Fix Suggestion**: Concrete code

End with a MANDATORY Coverage Report:
### Coverage Report
For EVERY file you reviewed, output exactly this marker line (one per file):
[REVIEWED] path/to/file.ts | findings: N
- "path/to/file.ts" must be the exact relative path from the manifest
- "findings: N" is the number of issues found (0 if clean)

**Files reviewed**: X / ${mod.files.length}
**Files NOT reviewed**: [list — MUST be empty for a complete audit]
If no issues found: "✅ No ${agent.name} issues found in ${mod.name}."

OUTPUT INSTRUCTIONS (MANDATORY):
1. Write your COMPLETE report to this file: ${subOutputFile}
2. Do NOT write files to any other location. No docs/, no Desktop/, no other folders.
3. The file must contain your FULL detailed analysis with all findings, not just a summary.
4. Your text response should be a brief summary only — the detailed report goes in the file.`;

        return { promise: runClaudeAgentic(subPrompt, repoDir, AGENT_TIMEOUT, model), outputFile: subOutputFile };
      });

      const subResults = await Promise.all(subPromises.map(s => s.promise));
      let agentCost = 0;
      const subOutputs: string[] = [];
      let successfulSubCount = 0;

      for (let i = 0; i < subResults.length; i++) {
        let sub = subResults[i];
        agentCost += sub.cost;
        totalCost += sub.cost;

        // Check if sub-agent wrote a file (preferred over result text)
        const subFile = subPromises[i].outputFile;
        if (fs.existsSync(subFile)) {
          const fileContent = fs.readFileSync(subFile, 'utf8');
          if (fileContent.length > (sub.result || '').length) {
            logAndBroadcast(`    [${agent.id}] 📄 Sub-agent ${modules[i].name}: using file output (${fileContent.length} chars)`);
            const fileSuccess = sub.success || fileContent.length >= MIN_OUTPUT_CHARS;
            sub = { ...sub, result: fileContent, success: fileSuccess };
          }
        }

        if (sub.success) {
          subOutputs.push(sub.result);
          successfulSubCount++;
        } else {
          subOutputs.push(`## ${agent.name} — Module: ${modules[i].name}\n❌ Sub-agent failed: ${(sub.result || '').substring(0, 200)}`);
        }
      }

      // Second pass: recover files written by killed sub-agents (race condition safety)
      // When a Claude CLI process is SIGKILL'd, its file write may complete moments after
      // the error callback fires, causing fs.existsSync to miss the file in the first pass.
      for (let i = 0; i < subResults.length; i++) {
        if (subOutputs[i].includes('❌ Sub-agent failed')) {
          const subFile = subPromises[i].outputFile;
          if (fs.existsSync(subFile)) {
            const fileContent = fs.readFileSync(subFile, 'utf8');
            if (fileContent.length >= MIN_OUTPUT_CHARS) {
              logAndBroadcast(`    [${agent.id}] 📄 Sub-agent ${modules[i].name}: late file recovery (${fileContent.length} chars)`);
              subOutputs[i] = fileContent;
              successfulSubCount++;
            }
          }
        }
      }

      // Check safety limits after sub-agents
      if (Date.now() - startTime > MAX_SCAN_DURATION_MS) {
        logAndBroadcast(`  [Scan] 🛑 TIME LIMIT reached (${Math.round((Date.now() - startTime) / 60000)}min). Remaining agents will be skipped.`);
        aborted = true;
      }

      // Merge sub-agent results
      let mergedResult = subOutputs.join('\n\n---\n\n');

      // If >2 sub-agents, do a per-agent merge to deduplicate (skip if aborted)
      if (modules.length > 2 && !aborted) {
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
      const deepSuccess = successfulSubCount > 0 && outputLen >= MIN_OUTPUT_CHARS;

      if (deepSuccess) {
        logAndBroadcast(`  [Scan] ✅ ${agent.name} done (${successfulSubCount}/${modules.length} sub-agents, ${outputLen} chars, $${agentCost.toFixed(2)})`);
        agentStatus[idx] = { ...agentStatus[idx], status: 'done', chars: outputLen, cost: agentCost, subAgents: modules.length };
      } else {
        logAndBroadcast(`  [Scan] ❌ ${agent.name} FAILED (${successfulSubCount}/${modules.length} sub-agents succeeded, ${outputLen} chars)`);
        agentStatus[idx] = { ...agentStatus[idx], status: 'failed', chars: outputLen, cost: agentCost, subAgents: modules.length };
      }
      broadcastScanProgress(scanId, { phase: 'agents', agents: agentStatus, totalCost });

      return { agent, result: { success: deepSuccess, result: mergedResult, cost: agentCost, durationMs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    }

    // ── Holistic agents (single agent, full repo) ──
    const outputFile = path.join(auditDir, `${agent.id}.md`);

    const fullPrompt = `${basePrompt}

CONTEXT: This is a FULL CODEBASE first scan (NOT a PR review, NOT a diff review).
Repository: ${repoFullName}
Path: ${repoDir}
Framework: ${frameworkInfo}
Your Focus: ${agent.focus}
${holisticManifestBlock}

Analyze the ENTIRE codebase. You have full access to ALL files.
Read relevant files from the manifest above — start with the project structure then dive into details.
Begin your report with: ## ${agent.name}

Format per finding:
- **Severity**: 🔴 Critical / 🟡 Warning / 🔵 Info
- **Confidence**: 🔒 CONFIRMED / ⚠️ POTENTIAL / 🔍 NEEDS-VERIFICATION
- **File:Line**: Description
- **Fix Suggestion**: Concrete code

If no issues found: "✅ No ${agent.name} issues found."

End with a MANDATORY Coverage Report:
### Coverage Report
For EVERY file you reviewed, output exactly this marker line (one per file):
[REVIEWED] path/to/file.ts | findings: N
- "path/to/file.ts" must be the exact relative path from the manifest
- "findings: N" is the number of issues found (0 if clean)

**Files reviewed**: X / ${totalFiles}
**Files NOT reviewed**: [list — should be empty for a complete audit, or explain why skipped]

OUTPUT INSTRUCTIONS (MANDATORY):
1. Write your COMPLETE report to this file: ${outputFile}
2. Do NOT write files to any other location. No docs/, no Desktop/, no other folders.
3. The file must contain your FULL detailed analysis with all findings, not just a summary.
4. Your text response should be a brief summary only — the detailed report goes in the file.`;

    // Check safety limits before starting
    if (aborted) {
      agentStatus[idx] = { ...agentStatus[idx], status: 'skipped' };
      return { agent, result: { success: false, result: 'Skipped: scan aborted', durationMs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 } };
    }

    let result = await runClaudeAgentic(fullPrompt, repoDir, AGENT_TIMEOUT, model);
    totalCost += result.cost;

    // Check time limit after each agent
    if (Date.now() - startTime > MAX_SCAN_DURATION_MS) {
      logAndBroadcast(`  [Scan] 🛑 TIME LIMIT (${Math.round((Date.now() - startTime) / 60000)}min). Remaining agents skipped.`);
      aborted = true;
    }

    let attempt = 1;
    while (!aborted && attempt < MAX_RETRIES && (!result.success || (result.result || '').length < MIN_OUTPUT_CHARS)) {
      attempt++;
      const reason = !result.success ? `FAILED: ${(result.result || '').substring(0, 200)}` : `short output: ${(result.result || '').length} chars`;
      logAndBroadcast(`  [Scan] 🔄 ${agent.name} retry ${attempt}/${MAX_RETRIES} (${reason})`);
      agentStatus[idx] = { ...agentStatus[idx], status: 'retrying', attempt };
      broadcastScanProgress(scanId, { phase: 'agents', agents: agentStatus, totalCost });
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      result = await runClaudeAgentic(fullPrompt, repoDir, AGENT_TIMEOUT, model);
      totalCost += result.cost;

      if (Date.now() - startTime > MAX_SCAN_DURATION_MS) {
        logAndBroadcast(`  [Scan] 🛑 Time limit reached during retry. Stopping retries for ${agent.name}.`);
        aborted = true;
      }
    }

    // Check if agent wrote a file (preferred) — use file content over result text
    if (fs.existsSync(outputFile)) {
      const fileContent = fs.readFileSync(outputFile, 'utf8');
      if (fileContent.length > (result.result || '').length) {
        logAndBroadcast(`  [Scan] 📄 ${agent.name}: using file output (${fileContent.length} chars) over result text (${(result.result || '').length} chars)`);
        const fileSuccess = result.success || fileContent.length >= MIN_OUTPUT_CHARS;
        result = { ...result, result: fileContent, success: fileSuccess };
      }
    }

    const outputLen = (result.result || '').length;
    if (!result.success) {
      logAndBroadcast(`  [Scan] ❌ ${agent.name} FAILED after ${attempt} attempts: ${(result.result || '').substring(0, 200)}`);
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

  // ── Phase 1.5: Coverage Verification ──
  // Parse [REVIEWED] markers from agent reports for reliable coverage tracking
  // Coverage % only counts code files (not config like .json, .yaml)
  const allReportText = results
    .filter(r => r.result.success)
    .map(r => r.result.result || '')
    .join('\n');

  const coveredFiles = new Set<string>();
  const uncoveredFiles: string[] = [];

  // Separate code files from config files for coverage calculation
  const codeFiles: string[] = [];
  const configFiles: string[] = [];
  for (const file of allSourceFiles) {
    const ext = path.extname(file).toLowerCase();
    if (CONFIG_EXTENSIONS.has(ext)) {
      configFiles.push(file);
    } else {
      codeFiles.push(file);
    }
  }

  // Primary: parse explicit [REVIEWED] markers from agent reports
  const reviewedPattern = /\[REVIEWED\]\s+(.+?)\s+\|/g;
  let match;
  while ((match = reviewedPattern.exec(allReportText))) {
    const reviewedPath = match[1].trim();
    if (allSourceFiles.has(reviewedPath)) {
      coveredFiles.add(reviewedPath);
    }
  }

  // Fallback: for agents that didn't use markers, check text mentions
  // This ensures backward compatibility and catches partial compliance
  if (coveredFiles.size < allSourceFiles.size * 0.5) {
    // Count duplicate basenames to avoid false-positive matching
    const basenameCounts = new Map<string, number>();
    for (const file of allSourceFiles) {
      const bn = path.basename(file);
      basenameCounts.set(bn, (basenameCounts.get(bn) || 0) + 1);
    }

    for (const file of allSourceFiles) {
      if (coveredFiles.has(file)) continue;
      // Check if the full relative path appears in any report
      if (allReportText.includes(file)) {
        coveredFiles.add(file);
        continue;
      }
      // Only use basename if it's unique in the repo
      const basename = path.basename(file);
      if (basenameCounts.get(basename) === 1 && allReportText.includes(basename)) {
        coveredFiles.add(file);
      }
    }
  }

  for (const file of allSourceFiles) {
    if (!coveredFiles.has(file)) {
      uncoveredFiles.push(file);
    }
  }

  // Coverage % based on code files only (config files are bonus, not expected in reports)
  const coveredCodeFiles = codeFiles.filter(f => coveredFiles.has(f));
  const uncoveredCodeFiles = codeFiles.filter(f => !coveredFiles.has(f));
  const coveragePercent = codeFiles.length > 0 ? Math.round((coveredCodeFiles.length / codeFiles.length) * 100) : 100;
  logAndBroadcast(`  [Scan] 📊 Coverage Check: ${coveredCodeFiles.length}/${codeFiles.length} code files mentioned in reports (${coveragePercent}%) + ${configFiles.length} config files`);

  if (uncoveredCodeFiles.length > 0) {
    logAndBroadcast(`  [Scan] ⚠️ ${uncoveredCodeFiles.length} code files NOT mentioned in any agent report`);
  }

  // Save coverage report to audit dir
  const coverageReport = `# Coverage Verification Report\n\nDate: ${new Date().toISOString()}\nTotal files: ${totalFiles} (${codeFiles.length} code + ${configFiles.length} config)\nCode files covered: ${coveredCodeFiles.length}/${codeFiles.length} (${coveragePercent}%)\nUncovered code files: ${uncoveredCodeFiles.length}\n\n## Uncovered Code Files\n${uncoveredCodeFiles.length > 0 ? uncoveredCodeFiles.map(f => `- ${f}`).join('\n') : '✅ All code files covered!'}\n\n## Config Files (not counted for coverage %)\n${configFiles.map(f => `- ${f} ${coveredFiles.has(f) ? '✅' : '—'}`).join('\n')}\n`;
  fs.writeFileSync(path.join(auditDir, '00-coverage-verification.md'), coverageReport);

  // ── Phase 1.6: Coverage Gap Agent (if significant gaps exist) ──
  let gapAgentResult = '';
  if (!aborted && uncoveredCodeFiles.length > 0 && coveragePercent < 90) {
    const MAX_GAP_FILES = 100; // Cap to avoid oversized prompts
    const gapFiles = uncoveredCodeFiles.slice(0, MAX_GAP_FILES);
    logAndBroadcast(`  [Scan] 🔍 Running Coverage Gap Agent for ${gapFiles.length} uncovered code files...`);
    broadcastScanProgress(scanId, { phase: 'coverage-gap', agents: agentStatus, totalCost });

    const gapOutputFile = path.join(auditDir, '00-coverage-gaps.md');
    const gapResult = await runClaudeAgentic(
      `You are a Coverage Gap Agent for the code audit of "${repoFullName}".

The main audit agents MISSED the following ${gapFiles.length} files. Your job is to review them for issues.

Repository: ${repoFullName}
Path: ${repoDir}
Framework: ${frameworkInfo}

⚠️ FILES TO REVIEW (these were missed by all other agents):
${gapFiles.map(f => `- ${f}`).join('\n')}

For each file:
1. Read the file
2. Check for: bugs, security issues, code quality problems, dead code, performance issues
3. Report any findings with the standard format:
   - **Severity**: 🔴 Critical / 🟡 Warning / 🔵 Info
   - **Confidence**: 🔒 CONFIRMED / ⚠️ POTENTIAL / 🔍 NEEDS-VERIFICATION
   - **File:Line**: Description
   - **Fix Suggestion**: Concrete code

If a file has no issues: "✅ ${'{file}'} — no issues found"

For EVERY file you reviewed, output exactly this marker line (one per file):
[REVIEWED] path/to/file.ts | findings: N
- "path/to/file.ts" must be the exact relative path
- "findings: N" is the number of issues found (0 if clean)

Begin with: ## Coverage Gap Analysis
End with a list of ALL [REVIEWED] markers.

OUTPUT INSTRUCTIONS (MANDATORY):
1. Write your COMPLETE report to this file: ${gapOutputFile}
2. Do NOT write files to any other location.
3. Your text response should be a brief summary only — the detailed report goes in the file.`,
      repoDir,
      AGENT_TIMEOUT,
      model
    );

    totalCost += gapResult.cost;

    // Prefer file output
    gapAgentResult = gapResult.success ? gapResult.result : '';
    if (fs.existsSync(gapOutputFile)) {
      const fileContent = fs.readFileSync(gapOutputFile, 'utf8');
      if (fileContent.length > gapAgentResult.length) {
        gapAgentResult = fileContent;
      }
    }

    logAndBroadcast(`  [Scan] ✅ Coverage Gap Agent done (${gapAgentResult.length} chars, $${gapResult.cost.toFixed(2)})`);
  }

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

  // Separate successful and failed agents
  const successfulResults = results.filter(r => r.result.success && (r.result.result || '').length >= MIN_OUTPUT_CHARS);
  const failedResults = results.filter(r => !r.result.success || (r.result.result || '').length < MIN_OUTPUT_CHARS);

  if (failedResults.length > 0) {
    logAndBroadcast(`  [Scan] ⚠️ ${failedResults.length} agents failed and will be excluded from aggregation: ${failedResults.map(r => r.agent.name).join(', ')}`);
  }

  const agentResults = successfulResults.map(r =>
    `### ${r.agent.name}\n${r.result.result}`
  ).join('\n\n---\n\n');

  // Add failed agents note for aggregation
  const failedNote = failedResults.length > 0
    ? `\n\n---\n\n### ⚠️ Agents Not Analyzed (Failed)\nThe following agents failed after ${MAX_RETRIES} attempts and their areas were NOT analyzed:\n${failedResults.map(r => `- **${r.agent.name}** (${r.agent.focus})`).join('\n')}\n\nThese areas require manual review or a re-scan.`
    : '';

  // Add coverage info and gap agent results
  const coverageNote = `\n\n---\n\n### 📊 Automated Coverage Verification\nFile manifest: ${totalFiles} source files\nFiles mentioned in reports: ${coveredFiles.size} (${coveragePercent}%)\nUncovered files: ${uncoveredFiles.length}${uncoveredFiles.length > 0 ? `\n\nUncovered:\n${uncoveredFiles.slice(0, 50).map(f => `- ${f}`).join('\n')}${uncoveredFiles.length > 50 ? `\n... and ${uncoveredFiles.length - 50} more` : ''}` : ''}`;

  const gapNote = gapAgentResult
    ? `\n\n---\n\n### 🔍 Coverage Gap Analysis (additional files reviewed)\n${gapAgentResult}`
    : '';

  // Build the full report (all agents combined with headers)
  const fullReport = `# ${repoFullName} — Full Code Audit Report\nDate: ${new Date().toISOString().split('T')[0]}\nModel: ${modelInfo.name}\nFramework: ${frameworkInfo}\nModules: ${modules.map(m => `${m.name} (${m.lines} lines)`).join(', ')}\n\n` +
    results.map(r =>
      `${'='.repeat(80)}\n## ${r.agent.id}: ${r.agent.name}\nFocus: ${SCAN_AGENTS.find(a => a.id === r.agent.id)?.focus || ''}\nDeep: ${SCAN_AGENTS.find(a => a.id === r.agent.id)?.deep ? 'Yes (sub-agents)' : 'No (holistic)'}\nStatus: ${r.result.success ? 'OK' : 'FAILED'} | ${(r.result.result || '').length} chars | $${r.result.cost.toFixed(2)}\n${'='.repeat(80)}\n\n${r.result.result}`
    ).join('\n\n\n');

  getDb().prepare('UPDATE scans SET full_report = ? WHERE id = ?')
    .run(fullReport, scanId);

  // Agentic aggregation with selected model (1M context support)
  const aggOutputFile = path.join(auditDir, '12-summary-report.md');
  const aggResult = await runClaudeAgentic(
    `You are creating the final Code Audit Report for "${repoFullName}".

Combine the following ${successfulResults.length} agent reports into ONE structured report (${failedResults.length > 0 ? `${failedResults.length} agents failed and are excluded` : 'all agents succeeded'}).

Repository: ${repoFullName}
Framework: ${frameworkInfo}
Modules scanned: ${modules.map(m => m.name).join(', ')}
NOTE: This code may have been partially or fully generated by AI without thorough human review.

⚠️ CRITICAL: Your report MUST include an "Audit Coverage Summary" section at the end. A report WITHOUT the coverage summary is INCOMPLETE.

CONFIDENCE HANDLING:
- 🔒 CONFIRMED = proven issue with concrete evidence (file:line, code snippet, reproducible)
- ⚠️ POTENTIAL = likely issue but needs verification (runtime behavior, configuration-dependent)
- 🔍 NEEDS-VERIFICATION = theoretical, depends on deployment/runtime/usage patterns
- When in doubt between CONFIRMED and POTENTIAL, keep POTENTIAL

🔴 CRITICAL FINDING CROSS-VALIDATION (MANDATORY):
For EVERY 🔴 Critical finding, you MUST verify before including it in the report:
1. **Evidence present?** — Does the agent provide concrete evidence: file:line references, code snippets, and clear impact description? If no evidence → downgrade to 🟡 Warning.
2. **Compensation check done?** — Did the agent check for middleware, framework defaults, base classes, or existing safeguards? If no compensation check → downgrade to ⚠️ POTENTIAL.
3. **Cross-agent consistency** — If Agent A flags a Critical in code area X, but Agent B also analyzed area X and found no issue → downgrade to ⚠️ POTENTIAL (conflicting evidence).
4. **Framework default awareness** — If the finding is about something the framework handles by default (React XSS, ORM SQL injection, Next.js CSRF, Laravel validation) and the agent didn't prove a bypass → downgrade to 🟡 Warning.
5. **Test/dev only** — If the finding is only in test files, seed scripts, mock data, or dev-only code → downgrade to 🔵 Info.
Only Criticals that survive all 5 checks remain 🔴 Critical in the final report.

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

### False Positive Prevention
This audit uses a three-tier confidence system. POTENTIAL and NEEDS-VERIFICATION findings should be verified before action. All 🔴 Critical findings have been cross-validated (see CRITICAL FINDING CROSS-VALIDATION rules).

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

${agentResults}${failedNote}${coverageNote}${gapNote}

OUTPUT INSTRUCTIONS (MANDATORY):
1. Write your COMPLETE aggregated report to this file: ${aggOutputFile}
2. Do NOT write files to any other location.
3. This is the PRIORITIZED SUMMARY — deduplicate, merge similar findings, and cap at 80 total findings.
4. The full unfiltered agent reports are saved separately. This report should be the executive-readable version.
5. Your text response should be a brief summary only — the detailed report goes in the file.`,
    repoDir,
    AGENT_TIMEOUT,
    model
  );

  totalCost += aggResult.cost;
  const duration = Math.round((Date.now() - startTime) / 1000);

  // Prefer file output for aggregation (can be very large)
  let report = aggResult.success ? aggResult.result : agentResults;
  if (fs.existsSync(aggOutputFile)) {
    const fileContent = fs.readFileSync(aggOutputFile, 'utf8');
    if (fileContent.length > report.length) {
      logAndBroadcast(`  [Scan] 📄 Aggregation: using file output (${fileContent.length} chars) over result text (${report.length} chars)`);
      report = fileContent;
    }
  }

  // ── Save final reports to audit folder (already created before Phase 1) ──
  // Agent files were either written by agents directly or we write them now
  for (const r of results) {
    const agentFile = path.join(auditDir, `${r.agent.id}.md`);
    // Only overwrite if agent didn't write a file (or wrote a smaller one)
    if (!fs.existsSync(agentFile) || fs.readFileSync(agentFile, 'utf8').length < (r.result.result || '').length) {
      fs.writeFileSync(agentFile, `# ${r.agent.name}\n\n${r.result.result}`);
    }
  }

  // Save full combined report (all agents)
  fs.writeFileSync(path.join(auditDir, '11-full-report.md'), fullReport);

  // Save aggregated summary report (may already exist from agent file-output)
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
 *
 * Handles multiple output formats:
 * - Table: | **Framework** | Laravel 12 |
 * - List:  - **Framework**: Laravel 12
 * - Bold:  **Framework**: Laravel 12
 */
function extractFrameworkSummary(architectureMap: string): string {
  const lines = architectureMap.split('\n');
  let framework = '';
  let language = '';
  let db = '';

  /**
   * Extract value from a line containing a bold key.
   * Handles: `| **Key** | Value |`, `- **Key**: Value`, `**Key**: Value`
   */
  function extractValue(line: string): string {
    // Table format: | **Key** | Value | — extract cell after the key cell
    if (line.includes('|')) {
      const cells = line.split('|').map(c => c.trim()).filter(Boolean);
      // Return the cell AFTER the one containing **
      for (let i = 0; i < cells.length - 1; i++) {
        if (cells[i].includes('**')) {
          // Check if value is in the same cell (e.g., | **Key**: Value |)
          const keyCell = cells[i];
          if (keyCell.includes(':')) {
            const afterColon = keyCell.split(':').slice(1).join(':');
            const val = afterColon.replace(/\*\*/g, '').replace(/`/g, '').trim();
            if (val) return val;
          }
          // Otherwise, value is in the next cell
          return cells[i + 1].replace(/\*\*/g, '').replace(/`/g, '').trim();
        }
      }
    }
    // List/bold format: remove everything up to and including the key
    return line
      .replace(/^[\s\-*|]*\*\*[^*]+\*\*[:\s|]*/i, '')
      .replace(/\*\*/g, '')
      .replace(/`/g, '')
      .replace(/\|/g, '')
      .trim();
  }

  for (const line of lines) {
    const l = line.toLowerCase();
    // Match **Framework** but NOT **Framework-specific** or similar compounds
    if (!framework && (l.includes('**framework**') || l.match(/\*\*framework\s*\*\*/))) {
      if (!l.includes('framework-') && !l.includes('framework specific')) {
        framework = extractValue(line);
      }
    }
    // Match **PHP**, **Language**, **Python**, **Node**, etc.
    if (!language && (l.includes('**language**') || l.includes('**php**') || l.includes('**python**') || l.includes('**node**'))) {
      language = extractValue(line);
    }
    // Match **Database** but not **Database (dev)** — prefer (prod) or plain, first match wins
    if (!db && (l.includes('**database**') || l.match(/\*\*database\s*\(prod\)\*\*/))) {
      if (!l.includes('(dev)') && !l.includes('(test)')) {
        db = extractValue(line);
      }
    }
  }

  // Clean up extracted values — remove parenthetical version constraints like (^12.0)
  const clean = (s: string) => s.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = [framework, language, db].map(clean).filter(Boolean);
  if (parts.length > 0) return parts.join(' / ');

  // Fallback: scan for common framework names with version numbers
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
