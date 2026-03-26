import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { runClaude, calculateCost, PRICING } from './claude';
import { logAndBroadcast, broadcast } from './websocket';
import {
  createReview, updateReview, createReviewAgent, updateReviewAgent,
  getRepoByName, addCost,
} from './db';
import { AGENTS, DEFAULT_THRESHOLDS } from '@/types';
import type { AgentConfig, Thresholds } from '@/types';

// All-in-One: Prompts liegen im Projekt-Ordner
const PROMPTS_DIR = path.join(process.cwd(), 'prompts');
const REPOS_DIR = path.join(process.env.HOME || '~', 'repos');
const LOGS_DIR = path.join(process.env.HOME || '~', 'automation', 'logs');

// Track active reviews to prevent duplicates
const activeReviews = new Map<string, number>();

// ──────────────────────────────────────────────
// Diff Parsing
// ──────────────────────────────────────────────

interface DiffFile {
  filename: string;
  content: string;
  lineCount: number;
}

function parseDiffIntoFiles(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  const parts = diff.split(/^diff --git /m);

  for (const part of parts) {
    if (!part.trim()) continue;
    const lines = part.split('\n');
    const headerMatch = lines[0].match(/a\/(.+?) b\/(.+)/);
    if (!headerMatch) continue;
    files.push({
      filename: headerMatch[2],
      content: lines.join('\n'),
      lineCount: lines.length,
    });
  }
  return files;
}

// ──────────────────────────────────────────────
// Sub-Agent Planning
// ──────────────────────────────────────────────

interface AgentChunk {
  id: number;
  focus: string;
  files: string[];
  diffContent: string;
}

async function planAgentWork(
  agent: AgentConfig,
  diffFiles: DiffFile[],
  diffLineCount: number,
  repoDir: string,
  repoName: string,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): Promise<AgentChunk[]> {
  // Small PRs: single agent
  if (diffLineCount <= thresholds.small) {
    return [{
      id: 1,
      focus: 'Gesamter Diff',
      files: diffFiles.map(f => f.filename),
      diffContent: diffFiles.map(f => f.content).join('\n'),
    }];
  }

  // Static splitting for medium/large
  if (diffLineCount <= thresholds.large) {
    const numChunks = diffLineCount <= thresholds.medium ? 2 : 3;
    const chunkSize = Math.ceil(diffFiles.length / numChunks);
    const chunks: AgentChunk[] = [];

    for (let i = 0; i < diffFiles.length; i += chunkSize) {
      const chunkFiles = diffFiles.slice(i, i + chunkSize);
      chunks.push({
        id: chunks.length + 1,
        focus: chunkFiles.map(f => f.filename).slice(0, 5).join(', ') +
          (chunkFiles.length > 5 ? ` (+${chunkFiles.length - 5})` : ''),
        files: chunkFiles.map(f => f.filename),
        diffContent: chunkFiles.map(f => f.content).join('\n'),
      });
    }
    logAndBroadcast(`    [${agent.id}] ${numChunks} Sub-Agent(s) (statisch, ${diffLineCount} Zeilen)`);
    return chunks;
  }

  // Very large: Claude plans the split
  logAndBroadcast(`    [${agent.id}] Sehr große PR (${diffLineCount} Zeilen) — Claude plant Aufteilung...`);

  const fileList = diffFiles.map(f => `${f.filename} (${f.lineCount} Zeilen)`).join('\n');
  const planResult = await runClaude(
    `Du bist ein Arbeitsplaner für Code-Reviews. Teile die folgenden geänderten Dateien in sinnvolle Gruppen auf für parallele ${agent.name}-Analyse.

Repository: ${repoName}
Review-Fokus: ${agent.focus}

Geänderte Dateien:
${fileList}

Regeln:
- Gruppiere zusammengehörige Dateien (z.B. Controller + zugehöriger Service)
- Maximal 5 Gruppen
- Mindestens 2 Gruppen bei >10 Dateien
- Jede Gruppe sollte thematisch zusammenpassen

Antworte NUR mit JSON, kein anderer Text:
[
  {"id": 1, "focus": "Beschreibung", "files": ["datei1.php", "datei2.php"]},
  {"id": 2, "focus": "Beschreibung", "files": ["datei3.ts"]}
]`,
    repoDir,
    60000
  );

  if (planResult.success) {
    try {
      const jsonMatch = planResult.result.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const plan = JSON.parse(jsonMatch[0]) as { id: number; focus: string; files: string[] }[];
        return plan.map(group => ({
          id: group.id,
          focus: group.focus,
          files: group.files,
          diffContent: group.files
            .map(fname => diffFiles.find(f => f.filename === fname || f.filename.endsWith(fname)))
            .filter(Boolean)
            .map(f => f!.content)
            .join('\n'),
        }));
      }
    } catch {
      logAndBroadcast(`    [${agent.id}] ⚠ Plan-Parsing fehlgeschlagen, nutze Fallback`);
    }
  }

  // Fallback: static 3-way split
  const chunkSize = Math.ceil(diffFiles.length / 3);
  const chunks: AgentChunk[] = [];
  for (let i = 0; i < diffFiles.length; i += chunkSize) {
    const chunkFiles = diffFiles.slice(i, i + chunkSize);
    chunks.push({
      id: chunks.length + 1,
      focus: chunkFiles.map(f => f.filename).slice(0, 3).join(', '),
      files: chunkFiles.map(f => f.filename),
      diffContent: chunkFiles.map(f => f.content).join('\n'),
    });
  }
  return chunks;
}

// ──────────────────────────────────────────────
// Context Loading (replaces agentic file reading)
// ──────────────────────────────────────────────

const MAX_CONTEXT_SIZE = 30000; // chars of context to include

function getRelevantContext(repoDir: string, diffFiles: { filename: string }[]): string {
  const contextParts: string[] = [];
  let currentSize = 0;

  // 1. Always include CLAUDE.md if exists
  const claudeMdPath = path.join(repoDir, 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath)) {
    const content = fs.readFileSync(claudeMdPath, 'utf8').substring(0, 3000);
    contextParts.push(`### CLAUDE.md (Projekt-Kontext)\n\`\`\`\n${content}\n\`\`\``);
    currentSize += content.length;
  }

  // 2. Include package.json for dependency context
  const pkgPath = path.join(repoDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const content = fs.readFileSync(pkgPath, 'utf8').substring(0, 2000);
    contextParts.push(`### package.json\n\`\`\`json\n${content}\n\`\`\``);
    currentSize += content.length;
  }

  // 3. Include full content of changed files (not just the diff)
  for (const diffFile of diffFiles) {
    if (currentSize >= MAX_CONTEXT_SIZE) break;

    const filePath = path.join(repoDir, diffFile.filename);
    if (!fs.existsSync(filePath)) continue;

    try {
      const stat = fs.statSync(filePath);
      // Skip large files (>10KB) and binary files
      if (stat.size > 10000) continue;

      const content = fs.readFileSync(filePath, 'utf8');
      // Skip binary-looking content
      if (content.includes('\0')) continue;

      const remaining = MAX_CONTEXT_SIZE - currentSize;
      const truncated = content.substring(0, remaining);
      contextParts.push(`### ${diffFile.filename} (vollständig)\n\`\`\`\n${truncated}\n\`\`\``);
      currentSize += truncated.length;
    } catch {
      // Skip unreadable files
    }
  }

  return contextParts.join('\n\n');
}

// ──────────────────────────────────────────────
// Run Single Agent with Sub-Agents
// ──────────────────────────────────────────────

interface AgentResult {
  agent: AgentConfig;
  result: string;
  success: boolean;
  duration: number;
  subAgents: number;
  tokens: number;
  cost: number;
  dbAgentId: number;
}

async function runAgentWithSubAgents(
  agent: AgentConfig,
  diff: string,
  diffFiles: DiffFile[],
  diffLineCount: number,
  repoDir: string,
  repoName: string,
  prNumber: number,
  prTitle: string,
  prBody: string,
  reviewId: number,
  thresholds: Thresholds,
  mdContext: string = '',
  cachePrefix?: string,
): Promise<AgentResult> {
  const startTime = Date.now();
  const dbAgentId = createReviewAgent({
    review_id: reviewId,
    agent_id: agent.id,
    agent_name: agent.name,
  });

  updateReviewAgent(dbAgentId, { status: 'running' });
  broadcast({ type: 'agent_update', data: { reviewId, agentId: agent.id, status: 'running' } });

  // Load prompt template
  const promptFile = path.join(PROMPTS_DIR, 'pr-review', `${agent.id}.md`);
  let basePrompt = '';
  if (fs.existsSync(promptFile)) {
    basePrompt = fs.readFileSync(promptFile, 'utf8');
    const claudeMdPath = path.join(repoDir, 'CLAUDE.md');
    const claudeMd = fs.existsSync(claudeMdPath)
      ? fs.readFileSync(claudeMdPath, 'utf8').substring(0, 2000)
      : '';
    basePrompt = basePrompt
      .replace(/\{\{TECH_STACK\}\}/g, claudeMd)
      .replace(/\{\{REPO_NAME\}\}/g, repoName)
      .replace(/\{\{PR_NUMBER\}\}/g, String(prNumber))
      .replace(/\{\{PR_TITLE\}\}/g, prTitle)
      .replace(/\{\{PR_BODY\}\}/g, prBody || '');
  }

  const chunks = await planAgentWork(agent, diffFiles, diffLineCount, repoDir, repoName, thresholds);
  const subAgentCount = chunks.length;

  logAndBroadcast(`    [${agent.id}] ${subAgentCount} Sub-Agent(s) geplant`);
  broadcast({ type: 'agent_update', data: { reviewId, agentId: agent.id, status: 'running', subAgents: subAgentCount } });

  let totalTokens = 0;
  let totalCacheWriteTokens = 0;
  let totalCacheReadTokens = 0;

  if (subAgentCount === 1) {
    // Single agent: shared context + diff is in cachePrefix (identical for all 10 agents).
    // Only the agent-specific prompt is unique per agent → not cached.
    const agentPrompt = `${basePrompt}

Du bist der ${agent.name}-Agent. Dein Fokus: ${agent.focus}

Analysiere den Code-Diff oben. Gib NUR Findings aus die zu deinem Fachgebiet (${agent.name}) gehören.
Falls keine Issues: "✅ Keine ${agent.name} Issues gefunden."`;

    const claudeResult = await runClaude(agentPrompt, repoDir, 300000, cachePrefix);

    totalTokens = claudeResult.totalTokens;
    totalCacheWriteTokens = claudeResult.cacheWriteTokens;
    totalCacheReadTokens = claudeResult.cacheReadTokens;
    const duration = Math.round((Date.now() - startTime) / 1000);

    if (claudeResult.cacheReadTokens > 0) {
      logAndBroadcast(`    [${agent.id}] Cache HIT: ${claudeResult.cacheReadTokens} tokens from cache`);
    }

    updateReviewAgent(dbAgentId, {
      status: claudeResult.success ? 'completed' : 'failed',
      sub_agent_count: 1,
      duration_seconds: duration,
      result: claudeResult.result,
    });

    return { agent, result: claudeResult.result, success: claudeResult.success, duration, subAgents: 1, tokens: totalTokens, cost: claudeResult.cost, dbAgentId };
  }

  // Multiple sub-agents in parallel.
  // For sub-agents, each chunk has different diff content, so we build a
  // per-agent cache prefix: shared repo context + agent base prompt.
  // The chunk-specific diff goes in the non-cached part.
  const subPromises = chunks.map(chunk => {
    const chunkContext = getRelevantContext(repoDir, chunk.files.map(f => ({ filename: f, content: '' })));

    // Sub-agent cache prefix: shared repo context (without diff, since diff varies per chunk)
    let subCachePrefix: string | undefined;
    if (cachePrefix) {
      const diffHeadingIdx = cachePrefix.indexOf('## Diff der Code-Änderungen:');
      subCachePrefix = diffHeadingIdx !== -1
        ? cachePrefix.substring(0, diffHeadingIdx).trim()
        : cachePrefix; // Fallback: use full prefix if heading not found
    }

    const subPrompt = `${basePrompt}

Du bist Sub-Agent ${chunk.id}/${subAgentCount} des ${agent.name}-Agents.
Dein Fokus: ${agent.focus}
Dein Teilbereich: ${chunk.focus}
Dateien: ${chunk.files.join(', ')}

## Diff der Code-Änderungen:
\`\`\`diff
${chunk.diffContent.substring(0, 80000)}
\`\`\`

${chunkContext ? `## Relevanter Kontext (bestehende Dateien):\n${chunkContext}\n` : ''}

Analysiere den Code-Diff oben. Gib NUR Findings aus die zu ${agent.name} gehören.
Falls keine Issues: "✅ Keine ${agent.name} Issues in ${chunk.focus} gefunden."`;

    return runClaude(subPrompt, repoDir, 300000, subCachePrefix);
  });

  const subResults = await Promise.all(subPromises);
  totalTokens = subResults.reduce((sum, r) => sum + r.totalTokens, 0);
  totalCacheWriteTokens = subResults.reduce((sum, r) => sum + r.cacheWriteTokens, 0);
  totalCacheReadTokens = subResults.reduce((sum, r) => sum + r.cacheReadTokens, 0);
  let totalCost = subResults.reduce((sum, r) => sum + r.cost, 0);

  if (totalCacheReadTokens > 0) {
    logAndBroadcast(`    [${agent.id}] Cache HIT: ${totalCacheReadTokens} tokens from cache across ${subAgentCount} sub-agents`);
  }

  const mergedResults = subResults
    .map((r, i) => `#### Teil ${i + 1}: ${chunks[i].focus}\n${r.result}`)
    .join('\n\n');

  let finalResult = mergedResults;
  if (subAgentCount > 2) {
    logAndBroadcast(`    [${agent.id}] Aggregiere ${subAgentCount} Sub-Agent-Ergebnisse...`);
    const aggResult = await runClaude(
      `Fasse die folgenden ${subAgentCount} Teil-Reports des ${agent.name}-Reviews zusammen.
Entferne Duplikate. Behalte alle einzigartigen Findings. Sortiere nach Severity.

${mergedResults}

Ausgabe: Ein zusammengefasster ${agent.name}-Report mit allen Findings, ohne Duplikate.`,
      repoDir,
      120000
    );
    totalTokens += aggResult.totalTokens;
    totalCost += aggResult.cost;
    if (aggResult.success) finalResult = aggResult.result;
  }

  const duration = Math.round((Date.now() - startTime) / 1000);

  updateReviewAgent(dbAgentId, {
    status: subResults.every(r => r.success) ? 'completed' : 'failed',
    sub_agent_count: subAgentCount,
    duration_seconds: duration,
    result: finalResult,
  });

  logAndBroadcast(`    [${agent.id}] ✅ Fertig (${subAgentCount} Sub-Agents, ${duration}s, $${totalCost.toFixed(4)})`);
  broadcast({ type: 'agent_update', data: { reviewId, agentId: agent.id, status: 'completed', subAgents: subAgentCount } });

  return { agent, result: finalResult, success: subResults.every(r => r.success), duration, subAgents: subAgentCount, tokens: totalTokens, cost: totalCost, dbAgentId };
}

// ──────────────────────────────────────────────
// Main Review Flow
// ──────────────────────────────────────────────

export async function runPRReview(
  repoName: string,
  prNumber: number,
  prTitle: string,
  prBranch: string,
  fullRepoName: string,
  prBody: string,
) {
  const reviewKey = `${repoName}#${prNumber}`;

  // Already running?
  if (activeReviews.has(reviewKey)) {
    logAndBroadcast(`⏭ Review für ${reviewKey} läuft bereits`);
    return;
  }

  // Already reviewed?
  const repo = getRepoByName(repoName);
  if (!repo) {
    logAndBroadcast(`❌ Repo ${repoName} nicht in der Datenbank`);
    return;
  }

  // Parse thresholds from repo config
  const thresholds: Thresholds = repo.thresholds_json
    ? JSON.parse(repo.thresholds_json)
    : DEFAULT_THRESHOLDS;

  const repoDir = repo.local_path.replace('~', process.env.HOME || '');

  if (!fs.existsSync(repoDir)) {
    logAndBroadcast(`❌ Repo-Verzeichnis nicht gefunden: ${repoDir}`);
    return;
  }

  // Create review in DB
  const reviewId = createReview({
    repo_id: repo.id,
    pr_number: prNumber,
    pr_title: prTitle,
    pr_branch: prBranch,
    pr_body: prBody,
  });

  activeReviews.set(reviewKey, reviewId);
  broadcast({ type: 'review_started', data: { reviewId, repo: repoName, pr: prNumber } });

  try {
    logAndBroadcast(`▶ Starte Smart-Review für ${reviewKey}: "${prTitle}"`);

    // Fetch & Checkout
    logAndBroadcast(`  [${reviewKey}] Fetch & Checkout: ${prBranch}`);
    execSync(`git fetch origin && git checkout -f ${prBranch} && git reset --hard origin/${prBranch}`, {
      cwd: repoDir,
      stdio: 'pipe',
      timeout: 60000,
    });

    // Get diff
    let diff = '';
    try {
      diff = execSync(`git diff origin/${repo.base_branch}...HEAD`, {
        cwd: repoDir,
        stdio: 'pipe',
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
      }).toString();
    } catch (e: any) {
      logAndBroadcast(`  [${reviewKey}] ⚠ Diff Fehler: ${e.message}`);
    }

    if (!diff.trim()) {
      logAndBroadcast(`  [${reviewKey}] ⚠ Leerer Diff`);
      updateReview(reviewId, { status: 'completed', aggregated_result: 'Leerer Diff — keine Änderungen gefunden.' });
      activeReviews.delete(reviewKey);
      return;
    }

    const allDiffFiles = parseDiffIntoFiles(diff);

    // Separate .md files from code files — .md files become context, not reviewed
    const mdExtensions = ['.md', '.mdx', '.markdown'];
    const mdFiles = allDiffFiles.filter(f => mdExtensions.some(ext => f.filename.toLowerCase().endsWith(ext)));
    const codeDiffFiles = allDiffFiles.filter(f => !mdExtensions.some(ext => f.filename.toLowerCase().endsWith(ext)));

    // Build .md context string
    const mdContext = mdFiles.length > 0
      ? mdFiles.map(f => `### ${f.filename} (aus der PR)\n\`\`\`markdown\n${f.content.substring(0, 10000)}\n\`\`\``).join('\n\n')
      : '';

    // Rebuild code-only diff
    const codeDiff = codeDiffFiles.map(f => `diff --git ${f.content}`).join('\n');
    const diffLineCount = codeDiff.split('\n').length;

    if (mdFiles.length > 0) {
      logAndBroadcast(`  [${reviewKey}] ${mdFiles.length} .md-Datei(en) als Kontext separiert: ${mdFiles.map(f => f.filename).join(', ')}`);
    }

    updateReview(reviewId, { diff_lines: diffLineCount, diff_files: codeDiffFiles.length });
    logAndBroadcast(`  [${reviewKey}] Diff: ${diffLineCount} Zeilen Code, ${codeDiffFiles.length} Code-Dateien, ${mdFiles.length} Doku-Dateien`);

    // ── Smart PR Skipping: skip irrelevant agents based on changed file types ──
    const codeExts = codeDiffFiles.map(f => path.extname(f.filename).toLowerCase());
    const uniqueExts = new Set(codeExts);

    const isDepsOnly = codeDiffFiles.length > 0 && codeDiffFiles.every(f => {
      const bn = path.basename(f.filename).toLowerCase();
      return bn === 'package.json' || bn === 'package-lock.json' || bn === 'yarn.lock'
        || bn === 'pnpm-lock.yaml' || bn === 'composer.json' || bn === 'composer.lock'
        || bn === 'requirements.txt' || bn === 'poetry.lock' || bn === 'gemfile.lock'
        || bn === 'go.sum' || bn === 'go.mod';
    });

    const isStyleOnly = codeDiffFiles.length > 0 && [...uniqueExts].every(ext =>
      ['.css', '.scss', '.sass', '.less', '.styl', '.pcss'].includes(ext)
    );

    const isTestOnly = codeDiffFiles.length > 0 && codeDiffFiles.every(f => {
      const bn = f.filename.toLowerCase();
      return bn.includes('.test.') || bn.includes('.spec.') || bn.includes('__tests__')
        || bn.includes('__mocks__') || bn.startsWith('test/') || bn.startsWith('tests/');
    });

    // Config-only: only match known low-risk config files.
    // Excludes CI/CD workflows, Kubernetes manifests, and other security-sensitive YAML.
    const LOW_RISK_CONFIG = new Set([
      'tsconfig.json', 'tailwind.config.js', 'tailwind.config.ts',
      'postcss.config.js', 'postcss.config.mjs', 'vite.config.ts', 'vite.config.js',
      'next.config.js', 'next.config.mjs', 'next.config.ts',
      'eslint.config.js', 'eslint.config.mjs', '.eslintrc.json', '.eslintrc.js',
      '.prettierrc', '.prettierrc.json', '.prettierrc.js',
      '.gitignore', '.gitattributes', '.editorconfig', '.browserslistrc',
      '.nvmrc', '.node-version', '.npmrc', '.yarnrc.yml',
    ]);
    const CONFIG_EXTENSIONS = new Set(['.config.js', '.config.ts', '.config.mjs']);

    const isConfigOnly = codeDiffFiles.length > 0 && codeDiffFiles.every(f => {
      const bn = path.basename(f.filename).toLowerCase();
      const fp = f.filename.toLowerCase();
      // Reject CI/CD, workflows, k8s, and .env files — these need full review
      if (fp.includes('.github/') || fp.includes('.gitlab-ci') || fp.includes('k8s/')
        || fp.includes('kubernetes/') || bn.startsWith('.env')) {
        return false;
      }
      return LOW_RISK_CONFIG.has(bn)
        || CONFIG_EXTENSIONS.has(path.extname(bn))
        || bn === 'dockerfile' || bn === 'docker-compose.yml';
    });

    // No code files at all (doc-only PR) — already handled: codeDiffFiles is empty
    if (codeDiffFiles.length === 0 && mdFiles.length > 0) {
      logAndBroadcast(`  [${reviewKey}] 📝 Nur Doku-Änderungen — Auto-Approve (kein API-Call)`);
      const docResult = '✅ Nur Dokumentations-Änderungen — keine Code-Review nötig.';
      updateReview(reviewId, {
        status: 'completed',
        total_sub_agents: 0,
        duration_seconds: 0,
        findings_critical: 0, findings_warning: 0, findings_info: 0,
        aggregated_result: docResult,
        estimated_cost: 0,
        completed_at: new Date().toISOString(),
      });
      const commentBody = `## 🤖 Claude Code Review — PR #${prNumber}\n\n${docResult}\n\n---\n*0 Agents · Doc-only PR · $0.00 · Mac Mini M4*`;
      const tempCommentFile = path.join(LOGS_DIR, `temp-comment-${prNumber}.txt`);
      fs.writeFileSync(tempCommentFile, commentBody);
      execSync(`gh pr comment ${prNumber} --body-file "${tempCommentFile}"`, {
        cwd: repoDir, stdio: 'pipe', timeout: 30000,
        env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' },
      });
      try { fs.unlinkSync(tempCommentFile); } catch { /* ignore */ }
      activeReviews.delete(reviewKey);
      broadcast({ type: 'review_completed', data: { reviewId, duration: 0, findings: { critical: 0, warning: 0, info: 0 } } });
      return;
    }

    // Select relevant agents based on PR content
    let selectedAgents = AGENTS;
    let skipReason = '';

    if (isDepsOnly) {
      selectedAgents = AGENTS.filter(a => a.id === '03-security' || a.id === '09-dependency-check');
      skipReason = 'Deps-only PR';
    } else if (isStyleOnly) {
      selectedAgents = AGENTS.filter(a => a.id === '01-code-quality' || a.id === '06-behavioral-impact');
      skipReason = 'Style-only PR';
    } else if (isTestOnly) {
      selectedAgents = AGENTS.filter(a => a.id === '01-code-quality' || a.id === '02-bug-analysis' || a.id === '08-test-coverage');
      skipReason = 'Test-only PR';
    } else if (isConfigOnly) {
      selectedAgents = AGENTS.filter(a => a.id === '03-security' || a.id === '04-best-practices');
      skipReason = 'Config-only PR';
    }

    // Fallback: if filtering removed all agents (e.g., IDs changed), run all
    if (selectedAgents.length === 0) {
      selectedAgents = AGENTS;
      skipReason = '';
      logAndBroadcast(`  [${reviewKey}] ⚠ Agent-Filter ergab 0 Agents, Fallback auf alle`);
    }

    if (selectedAgents.length < AGENTS.length) {
      logAndBroadcast(`  [${reviewKey}] ⚡ Smart Skip: ${skipReason} → ${selectedAgents.length}/${AGENTS.length} Agents (${selectedAgents.map(a => a.name).join(', ')})`);
    }

    // Build shared cache prefix — identical for all agents, cached after first call.
    // Subsequent agents get 90% cheaper input tokens for this block.
    const sharedContextFiles = getRelevantContext(repoDir, codeDiffFiles);
    const sharedCachePrefix = [
      `## Relevanter Kontext (bestehende Dateien):`,
      sharedContextFiles,
      '',
      `## PR-Information:`,
      `Repository: ${repoName}`,
      `PR #${prNumber}: ${prTitle}`,
      prBody ? `\nBeschreibung vom Ersteller:\n${prBody}` : '',
      mdContext ? `\n## Dokumentation/Specs aus der PR (als Kontext — NICHT reviewen):\n${mdContext}\n\nDie obigen .md-Dateien sind Teil der PR und geben dir Kontext über Intent und Architektur der Änderungen. Nutze sie um zu verstehen WAS der Entwickler erreichen wollte. Reviewe aber NUR den Code-Diff unten.` : '',
      '',
      `## Diff der Code-Änderungen:`,
      '```diff',
      codeDiff.substring(0, 80000),
      '```',
    ].filter(Boolean).join('\n');

    logAndBroadcast(`  [${reviewKey}] Cache-Prefix: ${Math.round(sharedCachePrefix.length / 1024)}KB (wird über alle Agents geteilt)`);

    // Run selected agents in parallel (only on code, .md as context)
    const startTime = Date.now();
    const agentPromises = selectedAgents.map(agent =>
      runAgentWithSubAgents(agent, codeDiff, codeDiffFiles, diffLineCount, repoDir, repoName, prNumber, prTitle, prBody, reviewId, thresholds, mdContext, sharedCachePrefix)
    );

    const results = await Promise.all(agentPromises);
    const totalDuration = Math.round((Date.now() - startTime) / 1000);
    const totalSubAgents = results.reduce((sum, r) => sum + r.subAgents, 0);
    const totalTokens = results.reduce((sum, r) => sum + r.tokens, 0);
    let totalCost = results.reduce((sum, r) => sum + r.cost, 0);

    // Calculate cache savings for logging
    const cachePrefixTokens = Math.ceil(sharedCachePrefix.length / 4); // rough estimate
    const cacheHitAgents = results.length - 1; // first agent writes cache, rest read
    const savedTokens = cacheHitAgents * cachePrefixTokens;
    const savedCost = (savedTokens / 1_000_000) * (PRICING.input - PRICING.cacheRead);
    logAndBroadcast(`  [${reviewKey}] Alle Agents fertig (${totalDuration}s, ${totalSubAgents} Sub-Agents). Cache-Ersparnis: ~$${savedCost.toFixed(3)} (~${savedTokens.toLocaleString()} Tokens).`);

    // ── Clean PR Auto-Approve: skip aggregation if all agents found no issues ──
    const allClean = results.every(r =>
      r.success && r.result.includes('✅') && !r.result.match(/🔴|🟡/)
    );

    let aggregatedResult: string;
    let finalTokens = totalTokens;

    if (allClean) {
      logAndBroadcast(`  [${reviewKey}] ✅ Alle ${selectedAgents.length} Agents clean — Auto-Approve (kein Aggregation-Call)`);
      aggregatedResult = `✅ **Sieht gut aus!** ${selectedAgents.length}/${selectedAgents.length} Agents haben keine Issues gefunden.${skipReason ? `\n\n*${skipReason} — nur relevante Agents wurden ausgeführt.*` : ''}`;
    } else {
      logAndBroadcast(`  [${reviewKey}] Aggregation...`);

      const agentResults = results.map(r =>
        `### ${r.agent.name} (${r.subAgents} Sub-Agent${r.subAgents > 1 ? 's' : ''}, ${r.duration}s)\n${r.result}`
      ).join('\n\n---\n\n');

      const aggregationPromptFile = path.join(PROMPTS_DIR, 'aggregation.md');
      const aggregationBase = fs.existsSync(aggregationPromptFile)
        ? fs.readFileSync(aggregationPromptFile, 'utf8')
        : '';

      const aggResult = await runClaude(
        `${aggregationBase}

Fasse die folgenden ${selectedAgents.length} Agent-Reports zu EINEM gebündelten PR-Review zusammen.

Repository: ${repoName}
PR #${prNumber}: ${prTitle}
Diff-Größe: ${diffLineCount} Zeilen, ${codeDiffFiles.length} Dateien
Eingesetzte Agents: ${totalSubAgents}

REGELN:
1. Executive Summary ganz oben: X 🔴, Y 🟡, Z 🔵
2. Duplikate entfernen
3. Nach Severity sortieren: Kritisch → Warnung → Hinweis
4. Pro Finding: Datei:Zeile, Beschreibung, Fix-Vorschlag
5. Maximum 30 Findings
6. KEIN Meta-Kommentar zu den Agents

Ergebnisse:

${agentResults}`,
        repoDir
      );

      aggregatedResult = aggResult.success ? aggResult.result : `## Agent-Ergebnisse (ungefiltert)\n\n${agentResults}`;
      totalCost += aggResult.cost;
      finalTokens += aggResult.totalTokens;
    }

    // Count findings from aggregated result
    const criticalCount = (aggregatedResult.match(/🔴/g) || []).length;
    const warningCount = (aggregatedResult.match(/🟡/g) || []).length;
    const infoCount = (aggregatedResult.match(/🔵/g) || []).length;

    // Post PR comment
    logAndBroadcast(`  [${reviewKey}] Poste Review-Kommentar...`);

    const successCount = results.filter(r => r.success).length;

    const commentBody = `## 🤖 Claude Code Review — PR #${prNumber}

${aggregatedResult}

---
*${totalSubAgents} Agents (${selectedAgents.length} Kategorien) · ${successCount}/${selectedAgents.length} erfolgreich · ${totalDuration}s · $${totalCost.toFixed(2)} · Mac Mini M4*`;

    const tempCommentFile = path.join(LOGS_DIR, `temp-comment-${prNumber}.txt`);
    fs.writeFileSync(tempCommentFile, commentBody);

    execSync(`gh pr comment ${prNumber} --body-file "${tempCommentFile}"`, {
      cwd: repoDir,
      stdio: 'pipe',
      timeout: 30000,
      env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' },
    });

    try { fs.unlinkSync(tempCommentFile); } catch { /* ignore */ }

    // Update review in DB
    updateReview(reviewId, {
      status: 'completed',
      total_sub_agents: totalSubAgents,
      duration_seconds: totalDuration,
      findings_critical: criticalCount,
      findings_warning: warningCount,
      findings_info: infoCount,
      aggregated_result: aggregatedResult,
      estimated_cost: totalCost,
      completed_at: new Date().toISOString(),
    });

    // Track cost
    addCost({
      type: 'review',
      reference_id: reviewId,
      repo_id: repo.id,
      estimated_tokens: finalTokens,
      estimated_cost: totalCost,
    });

    logAndBroadcast(`✅ Smart-Review für ${reviewKey} gepostet (${totalDuration}s, ${totalSubAgents} Sub-Agents, $${totalCost.toFixed(2)})`);

    broadcast({
      type: 'review_completed',
      data: { reviewId, duration: totalDuration, findings: { critical: criticalCount, warning: warningCount, info: infoCount } },
    });

    // Back to base branch
    execSync(`git checkout ${repo.base_branch} && git pull --rebase`, {
      cwd: repoDir,
      stdio: 'pipe',
      timeout: 30000,
    });

  } catch (error: any) {
    logAndBroadcast(`❌ Review für ${reviewKey} fehlgeschlagen: ${error.message}`);
    updateReview(reviewId, { status: 'failed', aggregated_result: `Error: ${error.message}` });
    broadcast({ type: 'review_failed', data: { reviewId, error: error.message } });

    try {
      const repoDir2 = repo.local_path.replace('~', process.env.HOME || '');
      execSync(`git checkout ${repo.base_branch}`, { cwd: repoDir2, stdio: 'pipe', timeout: 10000 });
    } catch { /* ignore */ }

  } finally {
    activeReviews.delete(reviewKey);
  }
}

export function getActiveReviews() {
  return Array.from(activeReviews.entries()).map(([key, reviewId]) => ({ key, reviewId }));
}
