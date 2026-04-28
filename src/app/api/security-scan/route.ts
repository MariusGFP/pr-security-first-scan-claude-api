export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getDb, addCost } from '@/lib/db';
import { runClaudeWithTools, AVAILABLE_MODELS, type ModelKey, getKeyValue } from '@/lib/claude';
import { logAndBroadcast, broadcastScanProgress } from '@/lib/websocket';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const PROMPTS_BASE_DIR = path.join(process.cwd(), 'prompts', 'security-scan');

// ── File collection constants (shared with scan route) ──
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'vendor', 'storage',
  '.idea', '.vscode', '__pycache__', '.cache', 'coverage', '.turbo',
]);

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.php', '.py', '.rb', '.java', '.go',
  '.rs', '.vue', '.svelte', '.cs', '.swift', '.kt', '.scala', '.ex', '.exs',
  '.twig', '.hbs', '.ejs', '.pug',
]);

const CONFIG_EXTENSIONS = new Set([
  '.json', '.yaml', '.yml', '.xml', '.toml',
]);

const ALL_SCANNABLE_EXTENSIONS = new Set([...CODE_EXTENSIONS, ...CONFIG_EXTENSIONS]);

const SKIP_FILES = new Set([
  'package-lock.json', 'composer.lock', 'yarn.lock', 'pnpm-lock.yaml',
  'bun.lockb', 'Gemfile.lock', 'poetry.lock', 'Cargo.lock',
  'phpunit.xml.dist', '.phpunit.result.cache',
]);

/**
 * Collect all source files in a directory recursively.
 * Returns paths relative to baseDir.
 */
function collectSourceFiles(dirPath: string, baseDir: string): string[] {
  const files: string[] = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        files.push(...collectSourceFiles(fullPath, baseDir));
      } else if (ALL_SCANNABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && !SKIP_FILES.has(entry.name)) {
        files.push(path.relative(baseDir, fullPath));
      }
    }
  } catch { /* ignore */ }
  return files;
}

/**
 * Pre-flight checks before starting a security scan.
 * Returns an array of error messages. Empty = all checks passed.
 */
function runPreFlightChecks(repoFullPaths: string[], preset: string): string[] {
  const errors: string[] = [];

  // 1. Check prompt files exist for selected preset
  const promptsDir = getPromptsDir(preset);
  const agents = getAgentsForPreset(preset);
  const archPrompt = path.join(promptsDir, '00-architecture-mapping.md');
  if (!fs.existsSync(archPrompt)) {
    errors.push(`Prompt-Dateien nicht gefunden: ${promptsDir} existiert nicht`);
  } else {
    const missingPrompts = agents
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

  // 3. Check SSH known_hosts for github.com
  const sshDir = path.join(process.env.HOME || '~', '.ssh');
  const knownHostsFile = path.join(sshDir, 'known_hosts');
  let githubKnown = false;
  if (fs.existsSync(knownHostsFile)) {
    const knownHosts = fs.readFileSync(knownHostsFile, 'utf8');
    githubKnown = knownHosts.includes('github.com');
  }
  if (!githubKnown) {
    // Auto-fix: add github.com to known_hosts
    try {
      if (!fs.existsSync(sshDir)) fs.mkdirSync(sshDir, { mode: 0o700, recursive: true });
      const keys = execSync('ssh-keyscan -t ed25519 github.com 2>/dev/null', { timeout: 10000, stdio: 'pipe' }).toString();
      if (keys.trim()) {
        fs.appendFileSync(knownHostsFile, keys);
        logAndBroadcast('  [Security] ✅ GitHub SSH key added to known_hosts');
      } else {
        errors.push('GitHub SSH-Key konnte nicht abgerufen werden. Manuell ausführen: ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts');
      }
    } catch {
      errors.push('GitHub SSH-Key konnte nicht hinzugefügt werden. Manuell ausführen: ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts');
    }
  }

  // 4. Check repo directories exist (git is optional — plain folders are supported for scans)
  for (const rp of repoFullPaths) {
    if (!fs.existsSync(rp)) {
      errors.push(`Repo-Verzeichnis nicht gefunden: ${rp}`);
    }
  }

  // 5. Check ANTHROPIC_API_KEY is set
  const apiKey = getKeyValue('ANTHROPIC_API_KEY') || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    errors.push('ANTHROPIC_API_KEY nicht gesetzt. Unter Settings konfigurieren.');
  }

  return errors;
}

function getAuditsDir(): string {
  const fromKeys = getKeyValue('AUDITS_DIR');
  return fromKeys || path.join(process.env.HOME || '~', 'automation', 'audits');
}

// ── Per-preset agent definitions ──
const SHARED_AGENTS = [
  { id: '01-auth-identity',             name: 'Auth & Identity Flow',      focus: 'JWT/Token security, RBAC, cross-service auth, session management, IDOR' },
  { id: '02-api-security',              name: 'API Security',              focus: 'Input validation, rate limiting, CORS, response filtering, SSRF, mass assignment' },
];
const SHARED_AGENTS_TAIL = [
  { id: '04-secrets-credentials',       name: 'Secrets & Credentials',     focus: 'Hardcoded secrets, env config, git history, credential exposure, secret rotation' },
  { id: '05-cross-repo-attack-surface', name: 'Cross-Repo Attack Surface', focus: 'Trust boundaries, lateral movement, service-to-service auth, shared resources' },
  { id: '06-injection-owasp',           name: 'Injection & OWASP',         focus: 'SQL/NoSQL/Command injection, XSS, SSRF, broken access control, full OWASP Top 10' },
  { id: '07-scheduler-job-safety',      name: 'Scheduler & Job Safety',    focus: 'Idempotency, race conditions, double execution, concurrency control' },
  { id: '08-dependency-supply-chain',   name: 'Dependency & Supply Chain', focus: 'CVEs, typosquatting, outdated packages, license audit' },
];

const CRYPTO_AGENTS = [
  ...SHARED_AGENTS,
  { id: '03-crypto-web3',               name: 'Crypto/Web3 Security',      focus: 'Fireblocks integration, transaction safety, smart contracts, RPC security, DeFi risks' },
  ...SHARED_AGENTS_TAIL,
];

const SAAS_AGENTS = [
  ...SHARED_AGENTS,
  { id: '03-payment-webhook',           name: 'Payment & Webhook Security', focus: 'Payment gateway integrations, webhook signature validation, double-charge prevention, refund security' },
  ...SHARED_AGENTS_TAIL,
  { id: '09-multi-tenant-isolation',    name: 'Multi-Tenant Isolation',     focus: 'Tenant boundary enforcement, cross-tenant data leakage, cache/queue/storage isolation' },
  { id: '10-pii-data-privacy',          name: 'PII & Data Privacy',         focus: 'GDPR/nDSG compliance, PII in logs, data minimization, children data protection, right to deletion' },
  { id: '11-file-upload-storage',       name: 'File Upload & Storage',      focus: 'Upload validation, cloud storage security, SAS/pre-signed URLs, document processing, path traversal' },
];

const GENERIC_AGENTS = [
  ...SHARED_AGENTS,
  ...SHARED_AGENTS_TAIL,
];

// ── Security Scan Presets ──
type AgentDef = { id: string; name: string; focus: string };
const SECURITY_PRESETS: Record<string, { name: string; promptDir: string; agents: AgentDef[] }> = {
  'crypto': { name: 'Crypto / DeFi / Trading', promptDir: 'crypto', agents: CRYPTO_AGENTS },
  'saas':   { name: 'SaaS (Payments, Multi-Tenant, PII)', promptDir: 'saas', agents: SAAS_AGENTS },
  'generic': { name: 'Generic (keine Payments/Crypto)', promptDir: 'generic', agents: GENERIC_AGENTS },
};

function getPromptsDir(preset: string): string {
  const p = SECURITY_PRESETS[preset];
  if (p) {
    const dir = path.join(PROMPTS_BASE_DIR, p.promptDir);
    if (fs.existsSync(dir)) return dir;
  }
  return path.join(PROMPTS_BASE_DIR, 'generic');
}

function getAgentsForPreset(preset: string): AgentDef[] {
  return SECURITY_PRESETS[preset]?.agents || GENERIC_AGENTS;
}

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
  const presets = Object.entries(SECURITY_PRESETS).map(([key, val]) => ({
    key,
    name: val.name,
    agentCount: val.agents.length,
  }));
  return NextResponse.json({ scans, models: Object.entries(AVAILABLE_MODELS).map(([key, val]) => ({ key, ...val })), presets });
}

export async function POST(req: NextRequest) {
  ensureTable();
  const { platformName, reposDir, repoPaths, model, preset } = await req.json();
  const selectedModel: ModelKey = (model && model in AVAILABLE_MODELS) ? model : 'opus';
  const selectedPreset: string = (preset && preset in SECURITY_PRESETS) ? preset : 'generic';

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

  // Pre-flight checks
  const preFlightErrors = runPreFlightChecks(repoFullPaths, selectedPreset);
  if (preFlightErrors.length > 0) {
    return NextResponse.json({
      error: 'Pre-Flight-Check fehlgeschlagen',
      details: preFlightErrors,
    }, { status: 400 });
  }

  const modelInfo = AVAILABLE_MODELS[selectedModel];
  const agents = getAgentsForPreset(selectedPreset);
  const presetName = SECURITY_PRESETS[selectedPreset]?.name || 'Generic';
  const displayDir = repoPaths ? `[${repos.length} Repos]` : reposDir;
  const result = getDb().prepare(
    `INSERT INTO security_scans (platform_name, repos_dir, status, model, total_agents) VALUES (?, ?, 'running', ?, ?)`
  ).run(platformName, displayDir, selectedModel, agents.length);
  const scanId = result.lastInsertRowid as number;

  logAndBroadcast(`🔒 Security Scan started for "${platformName}" (${repos.length} Repos, ${modelInfo.name}, ${presetName}, ${agents.length} Agents)`);
  logAndBroadcast(`   Repos: ${repos.join(', ')}`);

  // Run async — pass full paths for explicit repos
  runSecurityScan(scanId, platformName, resolvedDir, repos, selectedModel, repoFullPaths, selectedPreset).catch(e => {
    const errMsg = e instanceof Error ? e.message : String(e);
    const errStack = e instanceof Error ? e.stack : '';
    logAndBroadcast(`❌ Security Scan failed: ${errMsg}`);
    if (errStack) console.error(`[Security Scan] Stack trace for scan ${scanId}:\n${errStack}`);
    getDb().prepare('UPDATE security_scans SET status = ? WHERE id = ?').run('failed', scanId);
  });

  return NextResponse.json({ scanId, status: 'started', repos, model: selectedModel });
}

// Safety limits
const MAX_SCAN_DURATION_MS = 45 * 60 * 1000; // 45 minutes max for entire scan
const AGENT_TIMEOUT_MS = 600000;   // 10 min per individual agent (down from 15)

async function runSecurityScan(
  scanId: number, platformName: string, reposDir: string, repos: string[], model: ModelKey, repoFullPaths?: string[], preset: string = 'generic'
) {
  const SCAN_AGENTS = getAgentsForPreset(preset);
  const promptsDir = getPromptsDir(preset);
  const presetName = SECURITY_PRESETS[preset]?.name || 'Generic';
  const startTime = Date.now();
  let totalCost = 0;
  let aborted = false;
  const modelInfo = AVAILABLE_MODELS[model];

  // Build repo info for prompts
  const repoPathsList = repoFullPaths
    ? repoFullPaths.map((fp, i) => `- ${repos[i]}: ${fp}`).join('\n')
    : repos.map(r => `- ${r}: ${path.join(reposDir, r)}`).join('\n');
  const workingDir = repoFullPaths ? path.dirname(repoFullPaths[0]) : reposDir;

  // Build initial agent status list
  const agentStatus: Array<{ id: string; name: string; status: string; chars?: number; cost?: number; attempt?: number }> =
    SCAN_AGENTS.map(a => ({ id: a.id, name: a.name, status: 'pending' }));

  // ── Phase Pre: Update repos to latest origin state ──
  // Mirrors PR-Review behavior (review-engine.ts) so the scan always runs against fresh code.
  // Failures are logged but do not abort the scan — fall back to local state.
  logAndBroadcast(`  [Security] Updating repos to latest origin state...`);
  const pathsToUpdate = repoFullPaths ?? repos.map(r => path.join(reposDir, r));
  for (let i = 0; i < pathsToUpdate.length; i++) {
    const repoPath = pathsToUpdate[i];
    const repoName = repos[i];
    if (!fs.existsSync(path.join(repoPath, '.git'))) {
      logAndBroadcast(`    ⏭ ${repoName}: not a git repo, skipped`);
      continue;
    }
    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: repoPath, stdio: 'pipe', timeout: 10000,
      }).toString().trim();
      execSync('git fetch origin', { cwd: repoPath, stdio: 'pipe', timeout: 60000 });
      execSync(`git reset --hard origin/${branch}`, { cwd: repoPath, stdio: 'pipe', timeout: 30000 });
      logAndBroadcast(`    ✅ ${repoName}: updated (${branch})`);
    } catch (e: any) {
      const errMsg = (e.stderr?.toString() || e.message || 'unknown error').split('\n')[0];
      logAndBroadcast(`    ⚠️ ${repoName}: update failed — ${errMsg}`);
    }
  }

  // ── Phase 0: Architecture Mapping ──
  logAndBroadcast(`  [Security] Phase 0: Architecture Mapping (${modelInfo.name})...`);
  broadcastScanProgress(scanId, { phase: 'mapping', agents: agentStatus });

  const mappingPromptFile = path.join(promptsDir, '00-architecture-mapping.md');
  let mappingPrompt = fs.existsSync(mappingPromptFile) ? fs.readFileSync(mappingPromptFile, 'utf8') : '';
  mappingPrompt = mappingPrompt
    .replace(/\{\{PLATFORM_NAME\}\}/g, platformName)
    .replace(/\{\{REPOS_DIR\}\}/g, workingDir);

  const auditsBaseDir = getAuditsDir(); // Shared allowed write dir for all agent calls
  const mappingOutputFile = path.join(auditsBaseDir, 'security-audits', `_mapping-${scanId}.md`);
  const mappingResult = await runClaudeWithTools(
    `${mappingPrompt}\n\nRepos (Name: Path):\n${repoPathsList}\n\nNavigate to the listed paths to analyze each repo.

OUTPUT INSTRUCTIONS (MANDATORY):
1. Write your COMPLETE architecture map to this file: ${mappingOutputFile}
2. Do NOT write files to any other location.
3. Your text response should be a brief summary only — the detailed map goes in the file.`,
    workingDir,
    AGENT_TIMEOUT_MS,
    model,
    undefined, // no cache prefix
    [auditsBaseDir]
  );

  totalCost += mappingResult.cost;

  // Prefer file output over result text
  let architectureMap = mappingResult.success ? mappingResult.result : 'Architecture mapping failed — proceed without context.';
  if (fs.existsSync(mappingOutputFile)) {
    const fileContent = fs.readFileSync(mappingOutputFile, 'utf8');
    if (fileContent.length > architectureMap.length) {
      logAndBroadcast(`  [Security] 📄 Architecture Mapping: using file output (${fileContent.length} chars) over result text (${architectureMap.length} chars)`);
      architectureMap = fileContent;
    }
    try { fs.unlinkSync(mappingOutputFile); } catch { /* ignore */ }
  }
  logAndBroadcast(`  [Security] ✅ Architecture Mapping done ($${mappingResult.cost.toFixed(2)})`);

  // Save architecture map to DB
  getDb().prepare('UPDATE security_scans SET architecture_map = ? WHERE id = ?').run(architectureMap, scanId);

  // ── Create audit directory BEFORE agents run (so agents can write files there) ──
  const platformSlug = platformName.toLowerCase().replace(/\s+/g, '-');
  const platformAuditsDir = path.join(getAuditsDir(), 'security-audits', platformSlug);
  if (!fs.existsSync(platformAuditsDir)) fs.mkdirSync(platformAuditsDir, { recursive: true });

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

  // Save architecture map to audit dir
  fs.writeFileSync(path.join(auditDir, '00-architecture-map.md'), architectureMap);
  logAndBroadcast(`  [Security] 📁 Audit folder: ${auditDir}`);

  // ── Phase 0.5: File Manifest (collect all source files across all repos) ──
  const allSourceFiles = new Set<string>();
  const perRepoFiles = new Map<string, string[]>();

  for (let i = 0; i < repos.length; i++) {
    const repoPath = repoFullPaths ? repoFullPaths[i] : path.join(reposDir, repos[i]);
    const repoFiles = collectSourceFiles(repoPath, repoPath).map(f => `${repos[i]}/${f}`);
    perRepoFiles.set(repos[i], repoFiles);
    for (const f of repoFiles) allSourceFiles.add(f);
  }

  const totalFiles = allSourceFiles.size;
  const manifestContent = Array.from(perRepoFiles.entries())
    .map(([repo, files]) => `## Repo: ${repo} (${files.length} files)\n${files.map(f => `- ${f}`).join('\n')}`)
    .join('\n\n');
  fs.writeFileSync(path.join(auditDir, '00-file-manifest.md'), `# File Manifest\nTotal: ${totalFiles} source files across ${repos.length} repos\n\n${manifestContent}`);
  logAndBroadcast(`  [Security] 📋 File Manifest: ${totalFiles} source files across ${repos.length} repos`);

  // Build file manifest block for agent prompts
  const MAX_INLINE_FILES = 300;
  const allFilesList = Array.from(allSourceFiles);
  let fileManifestBlock: string;
  if (totalFiles <= MAX_INLINE_FILES) {
    fileManifestBlock = `\n📋 FILE MANIFEST (${totalFiles} files — you MUST review ALL of these):\n${allFilesList.map(f => `- ${f}`).join('\n')}`;
  } else {
    fileManifestBlock = `\n📋 FILE MANIFEST (${totalFiles} files — you MUST review ALL of these):\nFirst ${MAX_INLINE_FILES} files listed here, full list in: ${path.join(auditDir, '00-file-manifest.md')}\n${allFilesList.slice(0, MAX_INLINE_FILES).map(f => `- ${f}`).join('\n')}\n... and ${totalFiles - MAX_INLINE_FILES} more (see manifest file)`;
  }

  // ── Build shared cache prefix for prompt caching across all security agents ──
  const scanCachePrefix = [
    `## Architecture Map`,
    architectureMap.substring(0, 15000),
    ``,
    `## Platform Context`,
    `Platform: ${platformName}`,
    `Working Directory: ${workingDir}`,
    `Repos (Name: Path):`,
    repoPathsList,
    ``,
    `## File Manifest (${totalFiles} source files across ${repos.length} repos)`,
    manifestContent,
  ].join('\n');
  logAndBroadcast(`  [Security] Cache-Prefix: ${Math.round(scanCachePrefix.length / 1024)}KB (shared across all agents for prompt caching)`);

  // ── Phase 1: 8 Security Agents parallel ──
  logAndBroadcast(`  [Security] Phase 1: ${SCAN_AGENTS.length} Security Agents parallel (${modelInfo.name}, ${presetName})...`);
  agentStatus.forEach(a => a.status = 'running' as any);
  broadcastScanProgress(scanId, { phase: 'agents', agents: agentStatus });

  const MAX_RETRIES = 3;
  const MIN_OUTPUT_CHARS = 500;
  const RETRY_DELAY_MS = 30000; // 30s delay between retries

  const agentPromises = SCAN_AGENTS.map(async (agent, idx) => {
    const promptFile = path.join(promptsDir, `${agent.id}.md`);
    let basePrompt = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : '';
    basePrompt = basePrompt
      .replace(/\{\{PLATFORM_NAME\}\}/g, platformName)
      .replace(/\{\{REPOS_DIR\}\}/g, workingDir)
      .replace(/\{\{ARCHITECTURE_MAP\}\}/g, '[See Architecture Map in shared context above]');

    const outputFile = path.join(auditDir, `${agent.id}.md`);
    const fullPrompt = `${basePrompt}\n\nRepos (Name: Path):\n${repoPathsList}\n\nYou have full access to ALL files. Navigate to the paths listed above to analyze each repo.
${fileManifestBlock}

Read EVERY file from the manifest above — start with the directory structure then dive into each file.

End with a MANDATORY Coverage Report:
### Coverage Report
For EVERY file you reviewed, output exactly this marker line (one per file):
[REVIEWED] repo-name/path/to/file.ts | findings: N
- The path must be the exact relative path from the manifest (repo-name/path/to/file.ts)
- "findings: N" is the number of issues found (0 if clean)

**Files reviewed**: X / ${totalFiles}
**Files NOT reviewed**: [list — MUST be empty for a complete audit]

OUTPUT INSTRUCTIONS (MANDATORY):
1. Write your COMPLETE report to this file: ${outputFile}
2. Do NOT write files to any other location. No docs/, no Desktop/, no other folders.
3. The file must contain your FULL detailed analysis with all findings, not just a summary.
4. Your text response should be a brief summary only — the detailed report goes in the file.`;

    agentStatus[idx] = { ...agentStatus[idx], status: 'running' };
    broadcastScanProgress(scanId, { phase: 'agents', agents: agentStatus, totalCost });

    // Check safety limits before starting
    if (aborted) {
      agentStatus[idx] = { ...agentStatus[idx], status: 'skipped' };
      return { agent, result: { success: false, result: 'Skipped: scan aborted', durationMs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, cacheWriteTokens: 0, cacheReadTokens: 0 } };
    }

    let result = await runClaudeWithTools(fullPrompt, workingDir, AGENT_TIMEOUT_MS, model, scanCachePrefix, [auditsBaseDir]);
    totalCost += result.cost;

    // Check time limit after each agent
    if (Date.now() - startTime > MAX_SCAN_DURATION_MS) {
      logAndBroadcast(`  [Security] 🛑 TIME LIMIT reached (${Math.round((Date.now() - startTime) / 60000)}min). Remaining agents will be skipped.`);
      aborted = true;
    }

    // Auto-retry on failure or suspiciously short output
    let attempt = 1;
    while (!aborted && attempt < MAX_RETRIES && (!result.success || (result.result || '').length < MIN_OUTPUT_CHARS)) {
      attempt++;
      const reason = !result.success ? `FAILED: ${(result.result || '').substring(0, 200)}` : `short output: ${(result.result || '').length} chars`;
      logAndBroadcast(`  [Security] 🔄 ${agent.name} retry ${attempt}/${MAX_RETRIES} (${reason})`);
      agentStatus[idx] = { ...agentStatus[idx], status: 'retrying', attempt };
      broadcastScanProgress(scanId, { phase: 'agents', agents: agentStatus, totalCost });
      // Delay before retry to avoid rate limits
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      result = await runClaudeWithTools(fullPrompt, workingDir, AGENT_TIMEOUT_MS, model, scanCachePrefix, [auditsBaseDir]);
      totalCost += result.cost;

      // Re-check limits after each retry
      if (Date.now() - startTime > MAX_SCAN_DURATION_MS) {
        logAndBroadcast(`  [Security] 🛑 Time limit reached during retry. Stopping retries for ${agent.name}.`);
        aborted = true;
      }
    }

    // Check if agent wrote a file (preferred) — use file content over result text
    if (fs.existsSync(outputFile)) {
      const fileContent = fs.readFileSync(outputFile, 'utf8');
      if (fileContent.length > (result.result || '').length) {
        if (!result.success) {
          logAndBroadcast(`  [Security] 📄 ${agent.name}: recovered from failure via file output (${fileContent.length} chars)`);
        }
        result = { ...result, result: fileContent, success: true };
      }
    }

    const outputLen = (result.result || '').length;
    if (!result.success) {
      logAndBroadcast(`  [Security] ❌ ${agent.name} FAILED after ${attempt} attempts: ${(result.result || '').substring(0, 200)}`);
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

  // Second pass: recover files written by killed sub-agents (race condition safety)
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r.result.success || (r.result.result || '').length < MIN_OUTPUT_CHARS) {
      const outputFile = path.join(auditDir, `${r.agent.id}.md`);
      if (fs.existsSync(outputFile)) {
        const fileContent = fs.readFileSync(outputFile, 'utf8');
        if (fileContent.length >= MIN_OUTPUT_CHARS) {
          logAndBroadcast(`  [Security] 📄 ${r.agent.name}: late file recovery (${fileContent.length} chars)`);
          results[i] = { ...r, result: { ...r.result, result: fileContent, success: true } };
          agentStatus[i] = { ...agentStatus[i], status: 'done', chars: fileContent.length };
        }
      }
    }
  }

  // ── Phase 1.5: Coverage Verification ──
  // Parse [REVIEWED] markers from agent reports for reliable coverage tracking
  const allReportText = results
    .filter(r => r.result.success)
    .map(r => r.result.result || '')
    .join('\n');

  const coveredFiles = new Set<string>();

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
  let reviewMatch;
  while ((reviewMatch = reviewedPattern.exec(allReportText))) {
    const reviewedPath = reviewMatch[1].trim();
    if (allSourceFiles.has(reviewedPath)) {
      coveredFiles.add(reviewedPath);
    }
  }

  // Fallback: for agents that didn't use markers, check text mentions
  if (coveredFiles.size < allSourceFiles.size * 0.5) {
    const basenameCounts = new Map<string, number>();
    for (const file of allSourceFiles) {
      const bn = path.basename(file);
      basenameCounts.set(bn, (basenameCounts.get(bn) || 0) + 1);
    }

    for (const file of allSourceFiles) {
      if (coveredFiles.has(file)) continue;
      if (allReportText.includes(file)) {
        coveredFiles.add(file);
        continue;
      }
      const basename = path.basename(file);
      if (basenameCounts.get(basename) === 1 && allReportText.includes(basename)) {
        coveredFiles.add(file);
      }
    }
  }

  const uncoveredFiles: string[] = [];
  for (const file of allSourceFiles) {
    if (!coveredFiles.has(file)) uncoveredFiles.push(file);
  }

  const coveredCodeFiles = codeFiles.filter(f => coveredFiles.has(f));
  const uncoveredCodeFiles = codeFiles.filter(f => !coveredFiles.has(f));
  const coveragePercent = codeFiles.length > 0 ? Math.round((coveredCodeFiles.length / codeFiles.length) * 100) : 100;
  logAndBroadcast(`  [Security] 📊 Coverage Check: ${coveredCodeFiles.length}/${codeFiles.length} code files mentioned in reports (${coveragePercent}%) + ${configFiles.length} config files`);

  if (uncoveredCodeFiles.length > 0) {
    logAndBroadcast(`  [Security] ⚠️ ${uncoveredCodeFiles.length} code files NOT mentioned in any agent report`);
  }

  // Save coverage report
  const coverageReport = `# Coverage Verification Report\n\nDate: ${new Date().toISOString()}\nTotal files: ${totalFiles} (${codeFiles.length} code + ${configFiles.length} config)\nCode files covered: ${coveredCodeFiles.length}/${codeFiles.length} (${coveragePercent}%)\nUncovered code files: ${uncoveredCodeFiles.length}\n\n## Uncovered Code Files\n${uncoveredCodeFiles.length > 0 ? uncoveredCodeFiles.map(f => `- ${f}`).join('\n') : '✅ All code files covered!'}\n\n## Config Files (not counted for coverage %)\n${configFiles.map(f => `- ${f} ${coveredFiles.has(f) ? '✅' : '—'}`).join('\n')}\n`;
  fs.writeFileSync(path.join(auditDir, '00-coverage-verification.md'), coverageReport);

  // ── Phase 1.6: Coverage Gap Agent (if significant gaps exist) ──
  let gapAgentResult = '';
  if (!aborted && uncoveredCodeFiles.length > 0 && coveragePercent < 90) {
    const MAX_GAP_FILES = 100;
    const gapFiles = uncoveredCodeFiles.slice(0, MAX_GAP_FILES);
    logAndBroadcast(`  [Security] 🔍 Running Coverage Gap Agent for ${gapFiles.length} uncovered code files...`);
    broadcastScanProgress(scanId, { phase: 'coverage-gap', agents: agentStatus, totalCost });

    const gapOutputFile = path.join(auditDir, '00-coverage-gaps.md');
    const gapResult = await runClaudeWithTools(
      `You are a Coverage Gap Agent for the security audit of "${platformName}".

The main security agents MISSED the following ${gapFiles.length} files. Your job is to review them for security issues.

Repos (Name: Path):
${repoPathsList}

⚠️ FILES TO REVIEW (these were missed by all other agents):
${gapFiles.map(f => `- ${f}`).join('\n')}

For each file:
1. Read the file
2. Check for: authentication issues, injection vulnerabilities, secrets exposure, IDOR, access control, OWASP Top 10
3. Report any findings with the standard format:
   - **Severity**: 🔴 Critical / 🟡 Warning / 🔵 Info
   - **Confidence**: 🔒 CONFIRMED / ⚠️ POTENTIAL / 🔍 NEEDS-VERIFICATION
   - **File:Line**: Description
   - **Fix Suggestion**: Concrete code

If a file has no issues: "✅ ${'{file}'} — no issues found"

For EVERY file you reviewed, output exactly this marker line (one per file):
[REVIEWED] repo-name/path/to/file.ts | findings: N
- The path must be the exact relative path
- "findings: N" is the number of issues found (0 if clean)

Begin with: ## Coverage Gap Analysis
End with a list of ALL [REVIEWED] markers.

OUTPUT INSTRUCTIONS (MANDATORY):
1. Write your COMPLETE report to this file: ${gapOutputFile}
2. Do NOT write files to any other location.
3. Your text response should be a brief summary only — the detailed report goes in the file.`,
      workingDir,
      AGENT_TIMEOUT_MS,
      model,
      undefined, // no cache prefix
      [auditsBaseDir]
    );

    totalCost += gapResult.cost;

    gapAgentResult = gapResult.success ? gapResult.result : '';
    if (fs.existsSync(gapOutputFile)) {
      const fileContent = fs.readFileSync(gapOutputFile, 'utf8');
      if (fileContent.length > gapAgentResult.length) {
        gapAgentResult = fileContent;
      }
    }

    logAndBroadcast(`  [Security] ✅ Coverage Gap Agent done (${gapAgentResult.length} chars, $${gapResult.cost.toFixed(2)})`);
  }

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

  // Separate successful and failed agents
  const successfulResults = results.filter(r => r.result.success && (r.result.result || '').length >= MIN_OUTPUT_CHARS);
  const failedResults = results.filter(r => !r.result.success || (r.result.result || '').length < MIN_OUTPUT_CHARS);

  if (failedResults.length > 0) {
    logAndBroadcast(`  [Security] ⚠️ ${failedResults.length} agents failed and will be excluded from aggregation: ${failedResults.map(r => r.agent.name).join(', ')}`);
  }

  const agentResults = successfulResults.map(r =>
    `### ${r.agent.name}\n${r.result.result}`
  ).join('\n\n---\n\n');

  // Add failed agents note for aggregation
  const failedNote = failedResults.length > 0
    ? `\n\n---\n\n### ⚠️ Agents Not Analyzed (Failed)\nThe following agents failed after ${MAX_RETRIES} attempts and their areas were NOT analyzed:\n${failedResults.map(r => `- **${r.agent.name}** (${r.agent.focus})`).join('\n')}\n\nThese areas require manual review or a re-scan.`
    : '';

  // Build the full report (all agents combined with headers)
  const fullReport = `# ${platformName} — Full Security Audit Report\nDate: ${new Date().toISOString().split('T')[0]}\nModel: ${modelInfo.name}\nRepos: ${repos.join(', ')}\n\n` +
    results.map(r =>
      `${'='.repeat(80)}\n## ${r.agent.id}: ${r.agent.name}\nFocus: ${SCAN_AGENTS.find(a => a.id === r.agent.id)?.focus || ''}\nStatus: ${r.result.success ? 'OK' : 'FAILED'} | ${(r.result.result || '').length} chars | $${r.result.cost.toFixed(2)}\n${'='.repeat(80)}\n\n${r.result.result}`
    ).join('\n\n\n');

  // Save full report to DB
  getDb().prepare('UPDATE security_scans SET full_report = ? WHERE id = ?')
    .run(fullReport, scanId);

  const aggOutputFile = path.join(auditDir, '10-summary-report.md');
  const aggResult = await runClaudeWithTools(
    `You are creating the final Security Audit Report for the "${platformName}" platform.

Combine the following ${successfulResults.length} security agent reports into ONE structured report (${failedResults.length > 0 ? `${failedResults.length} agents failed and are excluded` : 'all agents succeeded'}).

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

🔴 CRITICAL FINDING CROSS-VALIDATION (MANDATORY):
For EVERY 🔴 Critical finding, you MUST verify before including it in the report:
1. **Exploit Path present?** — Does the agent provide a concrete path: input → vulnerable code → impact with file:line references? If no exploit path → downgrade to 🟡 Warning.
2. **Compensation check done?** — Did the agent check for middleware, framework defaults, base classes, or gateway-level protections? If no compensation check → downgrade to ⚠️ POTENTIAL.
3. **Cross-agent consistency** — If Agent A flags a Critical in code area X, but Agent B also analyzed area X and found no issue → downgrade to ⚠️ POTENTIAL (conflicting evidence).
4. **Framework default awareness** — If the finding is about something the framework handles by default (React XSS, ORM SQL injection, Rails CSRF) and the agent didn't prove a bypass → downgrade to 🟡 Warning.
5. **Test/dev only** — If the finding is only in test files, seed scripts, or dev code → downgrade to 🔵 Info.
Only Criticals that survive all 5 checks remain 🔴 Critical in the final report.

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
${SCAN_AGENTS.map(a => `| ${a.id} ${a.name} | ... | ... | ...% | ✅ / ⚠️ Missing |`).join('\n')}

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

${agentResults}${failedNote}

OUTPUT INSTRUCTIONS (MANDATORY):
1. Write your COMPLETE aggregated report to this file: ${aggOutputFile}
2. Do NOT write files to any other location.
3. The file must contain your PRIORITIZED SUMMARY — deduplicate, merge similar findings, and cap at 100 total findings.
4. Your text response should be a brief summary only — the detailed report goes in the file.`,
    workingDir,
    600000,
    model,
    undefined, // no cache prefix
    [auditsBaseDir]
  );

  totalCost += aggResult.cost;
  const duration = Math.round((Date.now() - startTime) / 1000);

  // Prefer file output for aggregation (can be very large)
  let report = aggResult.success ? aggResult.result : agentResults;
  if (fs.existsSync(aggOutputFile)) {
    const fileContent = fs.readFileSync(aggOutputFile, 'utf8');
    if (fileContent.length > report.length) {
      logAndBroadcast(`  [Security] ✅ Aggregation done (${fileContent.length} chars, $${aggResult.cost.toFixed(2)})`);
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
  fs.writeFileSync(path.join(auditDir, '09-full-report.md'), fullReport);

  // Save aggregated summary report (may already exist from agent file-output)
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
