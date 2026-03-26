import Anthropic from '@anthropic-ai/sdk';
import { exec, execSync, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// Sonnet 4.6 pricing (per million tokens)
export const PRICING = {
  input: 3,       // $3 per 1M input tokens
  output: 15,     // $15 per 1M output tokens
  cacheWrite: 3.75, // $3.75 per 1M tokens (25% premium for cache creation)
  cacheRead: 0.30,  // $0.30 per 1M tokens (90% discount for cache hits)
};

const MODEL = 'claude-sonnet-4-6';
const LOGS_DIR = path.join(process.env.HOME || '~', 'automation', 'logs');

export interface ClaudeResult {
  success: boolean;
  result: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

// ──────────────────────────────────────────────
// Direct API (for PR Reviews — cheap, single call)
// ──────────────────────────────────────────────

/**
 * Read any value from ~/.keys by key name.
 */
export function getKeyValue(keyName: string): string {
  try {
    const keysFile = path.join(process.env.HOME || '~', '.keys');
    const content = fs.readFileSync(keysFile, 'utf8');
    const regex = new RegExp(`^export\\s+${keyName}=["']?(.+?)["']?\\s*$`, 'm');
    const match = content.match(regex);
    if (match) return match[1];
  } catch { /* ignore */ }
  return '';
}

function getApiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  return getKeyValue('ANTHROPIC_API_KEY');
}

let _client: Anthropic | null = null;
let _lastKey: string = '';

function getClient(): Anthropic {
  const key = getApiKey();
  if (!key) throw new Error('Anthropic API key not configured. Set it in Settings.');
  if (!_client || key !== _lastKey) {
    _client = new Anthropic({ apiKey: key });
    _lastKey = key;
  }
  return _client;
}

/**
 * Direct API call — single turn, no tool use.
 * Used for PR reviews where diff + context is passed inline.
 *
 * When `cachePrefix` is provided, it becomes the first content block with
 * `cache_control: { type: "ephemeral" }`. Identical prefixes across calls
 * within 5 minutes get cache hits → 90% cheaper input tokens for that block.
 */
export async function runClaude(
  prompt: string,
  _repoDir: string,
  timeoutMs = 300000,
  cachePrefix?: string,
): Promise<ClaudeResult> {
  const startTime = Date.now();

  try {
    const client = getClient();

    // When cachePrefix is provided, structure as content blocks for prompt caching.
    // The prefix (shared context + diff) is cached; the agent-specific prompt is unique.
    const userContent: string | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> =
      cachePrefix
        ? [
            { type: 'text' as const, text: cachePrefix, cache_control: { type: 'ephemeral' as const } },
            { type: 'text' as const, text: prompt },
          ]
        : prompt;

    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 8192,
      messages: [
        { role: 'user', content: userContent as any }
      ],
      betas: ['context-1m-2025-08-07'],
    });

    const durationMs = Date.now() - startTime;
    const usage = response.usage as any;
    const inputTokens = usage.input_tokens;
    const outputTokens = usage.output_tokens;
    const cacheWriteTokens = usage.cache_creation_input_tokens || 0;
    const cacheReadTokens = usage.cache_read_input_tokens || 0;
    const totalTokens = inputTokens + outputTokens;
    const cost = calculateCostWithCache(inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens);

    const result = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    return {
      success: true,
      result,
      durationMs,
      inputTokens,
      outputTokens,
      totalTokens,
      cost,
      cacheWriteTokens,
      cacheReadTokens,
    };
  } catch (error: any) {
    const durationMs = Date.now() - startTime;
    const estimatedTokens = Math.ceil(prompt.length / 4);

    return {
      success: false,
      result: `Error: ${error.message}`,
      durationMs,
      inputTokens: estimatedTokens,
      outputTokens: 0,
      totalTokens: estimatedTokens,
      cost: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    };
  }
}

// ──────────────────────────────────────────────
// Agentic CLI (for Erst-Scans — thorough, multi-turn)
// ──────────────────────────────────────────────

// Concurrency limiter — prevents spawning too many Claude CLI processes at once.
// On a 24GB M4 Mini, each Claude CLI process uses ~500MB-1GB RAM.
// Max 5 concurrent keeps memory usage under control and avoids API rate issues.
const MAX_CONCURRENT_AGENTS = 5;
let _runningAgents = 0;
const _waitQueue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (_runningAgents < MAX_CONCURRENT_AGENTS) {
    _runningAgents++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    _waitQueue.push(() => {
      _runningAgents++;
      resolve();
    });
  });
}

function releaseSlot(): void {
  _runningAgents--;
  if (_waitQueue.length > 0) {
    const next = _waitQueue.shift()!;
    next();
  }
}

/** Current number of running / queued agents (for diagnostics) */
export function getAgentConcurrency(): { running: number; queued: number } {
  return { running: _runningAgents, queued: _waitQueue.length };
}

interface ClaudeCliJsonResponse {
  type: string;
  subtype: string;
  cost_usd: number;
  duration_ms: number;
  is_error: boolean;
  num_turns: number;
  result: string;
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

// Available models for selection (latest generation, all with 1M beta)
export const AVAILABLE_MODELS = {
  'sonnet': { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6', context: '1M (beta)', costPer1MInput: 3, costPer1MOutput: 15 },
  'opus': { id: 'claude-opus-4-6', name: 'Opus 4.6', context: '1M (beta)', costPer1MInput: 5, costPer1MOutput: 25 },
} as const;

export type ModelKey = keyof typeof AVAILABLE_MODELS;

/**
 * Agentic CLI mode — Claude can read files, navigate code, use tools.
 * Used for Erst-Scans where Claude needs to explore the full codebase.
 * More expensive but much more thorough for large repos.
 */
export async function runClaudeAgentic(
  prompt: string,
  repoDir: string,
  timeoutMs = 600000,
  model: ModelKey = 'sonnet'
): Promise<ClaudeResult> {
  // Wait for a concurrency slot before spawning the CLI process
  await acquireSlot();

  return new Promise((resolve) => {
    const startTime = Date.now();
    const tempFile = path.join(LOGS_DIR, `temp-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);

    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.writeFileSync(tempFile, prompt);

    const done = (result: ClaudeResult) => {
      releaseSlot();
      resolve(result);
    };

    const modelFlag = model !== 'sonnet' ? ` --model ${AVAILABLE_MODELS[model].id}` : '';
    const child = exec(
      `cat "${tempFile}" | claude -p --dangerously-skip-permissions --output-format json${modelFlag}`,
      {
        cwd: repoDir,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        killSignal: 'SIGKILL', // Hard kill — SIGTERM may be ignored
        env: {
          ...process.env,
          PATH: `${process.env.HOME}/.npm-global/bin:${process.env.HOME}/.nvm/versions/node/${process.version}/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}`,
        },
      },
      (error, stdout, stderr) => {
        try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
        clearTimeout(hardKillTimer);

        const durationMs = Date.now() - startTime;

        // Log stderr for debugging agent failures
        if (stderr && stderr.trim()) {
          console.error(`[Claude CLI stderr] (${repoDir}): ${stderr.trim().substring(0, 500)}`);
        }

        if (error) {
          const estimatedTokens = Math.ceil(prompt.length / 4);
          const errDetail = stderr?.trim() ? `${error.message} | stderr: ${stderr.trim().substring(0, 300)}` : error.message;
          done({
            success: false,
            result: `Error: ${errDetail}`,
            durationMs,
            inputTokens: estimatedTokens,
            outputTokens: 0,
            totalTokens: estimatedTokens,
            cost: 0,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
          });
          return;
        }

        try {
          const json: ClaudeCliJsonResponse = JSON.parse(stdout);
          const inputTokens = json.usage.input_tokens || 0;
          const outputTokens = json.usage.output_tokens || 0;
          const totalTokens = inputTokens + outputTokens;
          // total_cost_usd includes ALL turns (tool use, reasoning, etc.)
          const cost = json.total_cost_usd || json.cost_usd || calculateCost(inputTokens, outputTokens);

          done({
            success: !json.is_error,
            result: json.result || '',
            durationMs,
            inputTokens,
            outputTokens,
            totalTokens,
            cost,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
          });
        } catch {
          // JSON parse failed — fallback
          const estimatedInput = Math.ceil(prompt.length / 4);
          const estimatedOutput = Math.ceil((stdout?.length || 0) / 4);
          done({
            success: true,
            result: stdout.trim(),
            durationMs,
            inputTokens: estimatedInput,
            outputTokens: estimatedOutput,
            totalTokens: estimatedInput + estimatedOutput,
            cost: calculateCost(estimatedInput, estimatedOutput),
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
          });
        }
      }
    );

    // Hard kill safety net: if exec timeout fails to kill, force-kill the process tree
    const hardKillTimer = setTimeout(() => {
      if (child.pid) {
        console.error(`[Claude CLI] Hard kill after ${timeoutMs + 30000}ms for PID ${child.pid}`);
        try {
          // Kill entire process group (claude spawns child processes)
          execSync(`kill -9 -${child.pid} 2>/dev/null || kill -9 ${child.pid} 2>/dev/null`, { stdio: 'pipe' });
        } catch { /* process may already be dead */ }
      }
    }, timeoutMs + 30000); // 30s grace period after exec timeout
    hardKillTimer.unref(); // Don't prevent Node.js from exiting
  });
}

/**
 * Calculate cost from exact token counts using Sonnet pricing (no cache).
 */
export function calculateCost(inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1_000_000) * PRICING.input + (outputTokens / 1_000_000) * PRICING.output;
}

/**
 * Calculate cost with prompt caching awareness.
 * - input_tokens: non-cached input tokens
 * - cacheWriteTokens: tokens written to cache (25% premium)
 * - cacheReadTokens: tokens read from cache (90% discount)
 */
export function calculateCostWithCache(
  inputTokens: number,
  outputTokens: number,
  cacheWriteTokens: number,
  cacheReadTokens: number,
): number {
  const uncachedInput = inputTokens - cacheWriteTokens - cacheReadTokens;
  return (
    (Math.max(0, uncachedInput) / 1_000_000) * PRICING.input +
    (cacheWriteTokens / 1_000_000) * PRICING.cacheWrite +
    (cacheReadTokens / 1_000_000) * PRICING.cacheRead +
    (outputTokens / 1_000_000) * PRICING.output
  );
}

/**
 * Calculate cost with model-specific pricing + cache awareness.
 */
function calculateCostForModel(
  inputTokens: number,
  outputTokens: number,
  cacheWriteTokens: number,
  cacheReadTokens: number,
  model: ModelKey,
): number {
  const m = AVAILABLE_MODELS[model];
  const uncachedInput = Math.max(0, inputTokens - cacheWriteTokens - cacheReadTokens);
  return (
    (uncachedInput / 1_000_000) * m.costPer1MInput +
    (cacheWriteTokens / 1_000_000) * (m.costPer1MInput * 1.25) +
    (cacheReadTokens / 1_000_000) * (m.costPer1MInput * 0.10) +
    (outputTokens / 1_000_000) * m.costPer1MOutput
  );
}

// ──────────────────────────────────────────────
// Direct API with Tools (for Scans — cached, multi-turn)
// Replaces CLI-based runClaudeAgentic with direct API calls.
// Benefits: prompt caching, multi-turn conversation caching,
//           no SIGKILL race conditions, full cost visibility.
// ──────────────────────────────────────────────

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'vendor', '.next', 'dist', 'build',
  '.nuxt', '.output', 'coverage', '.cache', '__pycache__',
  '.idea', '.vscode', 'storage', '.terraform',
]);

const MAX_FILE_READ_SIZE = 100_000; // 100KB per file read
const MAX_LIST_ENTRIES = 2000;
const MAX_GREP_MATCHES = 100;
const MAX_TURNS = 200; // Safety limit for multi-turn loop

// Tool definitions — cached across all agents (cache_control on last tool)
const SCAN_TOOLS: any[] = [
  {
    name: 'read_file',
    description: 'Read the complete contents of a file. Returns the file text. Use this to analyze source code, config files, etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string' as const, description: 'File path (absolute or relative to working directory)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and subdirectories. Returns one entry per line. Use to discover project structure.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string' as const, description: 'Directory path (absolute or relative to working directory)' },
        recursive: { type: 'boolean' as const, description: 'If true, list all files recursively (skips node_modules, .git, vendor, dist). Default: false.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_files',
    description: 'Search for a text/regex pattern across files using grep. Returns matching lines with file paths and line numbers. Max 100 results.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string' as const, description: 'Search pattern (basic regex supported)' },
        path: { type: 'string' as const, description: 'Directory to search in (default: working directory)' },
        include: { type: 'string' as const, description: 'File glob pattern to filter (e.g. "*.ts", "*.php")' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file. Creates parent directories if needed. Use this to write your analysis report.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string' as const, description: 'File path (absolute or relative to working directory)' },
        content: { type: 'string' as const, description: 'Content to write to the file' },
      },
      required: ['path', 'content'],
    },
    cache_control: { type: 'ephemeral' as const }, // Cache all tool definitions
  },
];

/**
 * Execute a scan tool call locally.
 */
function isPathAllowed(resolved: string, allowedDirs: string[]): boolean {
  const norm = path.resolve(resolved);
  return allowedDirs.some(d => {
    const normDir = path.resolve(d);
    return norm === normDir || norm.startsWith(normDir + path.sep);
  });
}

function executeScanTool(
  name: string,
  input: Record<string, any>,
  workingDir: string,
  allowedDirs: string[],
): { content: string; isError: boolean } {
  try {
    const rawPath = input.path || '.';
    const resolvedPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(workingDir, rawPath);

    // Security: prevent path traversal — all paths must stay within allowed directories
    if (!isPathAllowed(resolvedPath, allowedDirs)) {
      return { content: `Error: Access denied (path outside allowed directories): ${rawPath}`, isError: true };
    }

    switch (name) {
      case 'read_file': {
        if (!fs.existsSync(resolvedPath)) {
          return { content: `Error: File not found: ${rawPath}`, isError: true };
        }
        const stat = fs.statSync(resolvedPath);
        if (stat.isDirectory()) {
          return { content: `Error: ${rawPath} is a directory, not a file. Use list_directory instead.`, isError: true };
        }
        if (stat.size > MAX_FILE_READ_SIZE) {
          // Read first + last chunks for large files
          const fd = fs.openSync(resolvedPath, 'r');
          const headBuf = Buffer.alloc(Math.min(50000, stat.size));
          fs.readSync(fd, headBuf, 0, headBuf.length, 0);
          fs.closeSync(fd);
          const head = headBuf.toString('utf8');
          if (head.includes('\0')) return { content: 'Error: Binary file, cannot read as text.', isError: true };
          return { content: `${head}\n\n... [truncated — file is ${stat.size} bytes, showing first 50KB] ...`, isError: false };
        }
        const content = fs.readFileSync(resolvedPath, 'utf8');
        if (content.includes('\0')) return { content: 'Error: Binary file, cannot read as text.', isError: true };
        return { content, isError: false };
      }

      case 'list_directory': {
        if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
          return { content: `Error: Not a directory: ${rawPath}`, isError: true };
        }
        if (input.recursive) {
          const results: string[] = [];
          const walk = (dir: string) => {
            if (results.length >= MAX_LIST_ENTRIES) return;
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const entry of entries) {
              if (results.length >= MAX_LIST_ENTRIES) return;
              const fullPath = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
                  results.push(path.relative(resolvedPath, fullPath) + '/');
                  walk(fullPath);
                }
              } else {
                results.push(path.relative(resolvedPath, fullPath));
              }
            }
          };
          walk(resolvedPath);
          const truncNote = results.length >= MAX_LIST_ENTRIES ? `\n... (truncated at ${MAX_LIST_ENTRIES} entries)` : '';
          return { content: results.join('\n') + truncNote, isError: false };
        } else {
          const entries = fs.readdirSync(resolvedPath, { withFileTypes: true });
          const lines = entries.map(e => e.isDirectory() ? e.name + '/' : e.name);
          return { content: lines.join('\n'), isError: false };
        }
      }

      case 'search_files': {
        if (input.pattern && input.pattern.length > 500) {
          return { content: 'Error: Search pattern too long (max 500 chars)', isError: true };
        }
        const searchDir = input.path
          ? (path.isAbsolute(input.path) ? input.path : path.resolve(workingDir, input.path))
          : workingDir;
        try {
          const args = ['-rn', '--color=never'];
          // Skip common large/binary directories
          for (const skip of SKIP_DIRS) {
            args.push(`--exclude-dir=${skip}`);
          }
          if (input.include) args.push(`--include=${input.include}`);
          args.push('--', input.pattern, searchDir);
          const result = execFileSync('grep', args, {
            maxBuffer: 2 * 1024 * 1024,
            timeout: 30000,
          });
          const lines = result.toString().split('\n').filter(Boolean);
          if (lines.length > MAX_GREP_MATCHES) {
            return {
              content: lines.slice(0, MAX_GREP_MATCHES).join('\n') + `\n... (${lines.length - MAX_GREP_MATCHES} more matches truncated)`,
              isError: false,
            };
          }
          return { content: lines.join('\n') || 'No matches found.', isError: false };
        } catch (err: any) {
          if (err.status === 1) return { content: 'No matches found.', isError: false }; // grep exit 1 = no match
          return { content: `Search error: ${err.message}`, isError: true };
        }
      }

      case 'write_file': {
        const dir = path.dirname(resolvedPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(resolvedPath, input.content);
        return { content: `File written: ${rawPath} (${input.content.length} chars)`, isError: false };
      }

      default:
        return { content: `Unknown tool: ${name}`, isError: true };
    }
  } catch (err: any) {
    return { content: `Tool error: ${err.message}`, isError: true };
  }
}

/**
 * Direct API with tool use — multi-turn agent loop with prompt caching.
 * Replaces CLI-based runClaudeAgentic for scans.
 *
 * Benefits over CLI mode:
 * - Prompt caching: shared context (arch map, file manifest) cached across agents → 90% cheaper
 * - Multi-turn caching: conversation history cached between turns → huge savings for file-heavy agents
 * - No SIGKILL race conditions: tool calls complete atomically
 * - Full cost visibility: exact cache hit/miss stats per agent
 */
export async function runClaudeWithTools(
  prompt: string,
  workingDir: string,
  timeoutMs = 600000,
  model: ModelKey = 'sonnet',
  cachePrefix?: string,
  extraAllowedDirs?: string[],
): Promise<ClaudeResult> {
  await acquireSlot();

  const startTime = Date.now();
  const modelId = AVAILABLE_MODELS[model].id;
  const allowedDirs = [workingDir, ...(extraAllowedDirs || [])];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheWriteTokens = 0;
  let totalCacheReadTokens = 0;

  const makeResult = (success: boolean, result: string): ClaudeResult => ({
    success,
    result,
    durationMs: Date.now() - startTime,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
    cost: calculateCostForModel(totalInputTokens, totalOutputTokens, totalCacheWriteTokens, totalCacheReadTokens, model),
    cacheWriteTokens: totalCacheWriteTokens,
    cacheReadTokens: totalCacheReadTokens,
  });

  try {
    const client = getClient();

    // Build initial user message with optional cache prefix
    const userContent: any = cachePrefix
      ? [
          { type: 'text', text: cachePrefix, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: prompt },
        ]
      : prompt;

    const messages: any[] = [{ role: 'user', content: userContent }];

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      // Check timeout before each API call
      if (Date.now() - startTime > timeoutMs) {
        releaseSlot();
        return makeResult(false, 'Error: Timeout exceeded');
      }

      const response = await client.beta.messages.create({
        model: modelId,
        max_tokens: 16384,
        messages,
        tools: SCAN_TOOLS,
        betas: ['context-1m-2025-08-07'],
      });

      // Track token usage
      const usage = response.usage as any;
      totalInputTokens += usage.input_tokens || 0;
      totalOutputTokens += usage.output_tokens || 0;
      totalCacheWriteTokens += usage.cache_creation_input_tokens || 0;
      totalCacheReadTokens += usage.cache_read_input_tokens || 0;

      // Add assistant response to conversation
      messages.push({ role: 'assistant', content: response.content });

      // Check if done (no tool calls)
      const toolUseBlocks = response.content.filter((b: any) => b.type === 'tool_use');
      if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
        const result = response.content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n');
        releaseSlot();
        return makeResult(true, result);
      }

      // Execute all tool calls
      const toolResults: any[] = [];
      for (const block of toolUseBlocks) {
        const tb = block as any;
        const toolResult = executeScanTool(tb.name, tb.input as Record<string, any>, workingDir, allowedDirs);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tb.id,
          content: toolResult.content,
          is_error: toolResult.isError,
        });
      }

      // Add cache_control to last tool result → caches entire conversation history
      // so next turn only pays for new content (90% savings on accumulated context)
      if (toolResults.length > 0) {
        toolResults[toolResults.length - 1].cache_control = { type: 'ephemeral' };
      }

      messages.push({ role: 'user', content: toolResults });
    }

    // Exceeded MAX_TURNS
    releaseSlot();
    const partialResult = messages
      .filter((m: any) => m.role === 'assistant')
      .flatMap((m: any) => m.content)
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n');
    return makeResult(true, partialResult || 'Max turns reached');

  } catch (error: any) {
    releaseSlot();
    return makeResult(false, `Error: ${error.message}`);
  }
}
