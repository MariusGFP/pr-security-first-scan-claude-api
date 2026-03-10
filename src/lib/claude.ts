import Anthropic from '@anthropic-ai/sdk';
import { exec, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// Sonnet 4.6 pricing (per million tokens)
const PRICING = {
  input: 3,    // $3 per 1M input tokens
  output: 15,  // $15 per 1M output tokens
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
 * ~70% cheaper than agentic mode.
 */
export async function runClaude(
  prompt: string,
  _repoDir: string,
  timeoutMs = 300000
): Promise<ClaudeResult> {
  const startTime = Date.now();

  try {
    const client = getClient();

    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 8192,
      messages: [
        { role: 'user', content: prompt }
      ],
      betas: ['context-1m-2025-08-07'],
    });

    const durationMs = Date.now() - startTime;
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const totalTokens = inputTokens + outputTokens;
    const cost = calculateCost(inputTokens, outputTokens);

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
 * Calculate cost from exact token counts using Sonnet pricing.
 */
export function calculateCost(inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1_000_000) * PRICING.input + (outputTokens / 1_000_000) * PRICING.output;
}
