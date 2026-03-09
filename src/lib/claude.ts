import Anthropic from '@anthropic-ai/sdk';
import { exec } from 'child_process';
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
export function runClaudeAgentic(
  prompt: string,
  repoDir: string,
  timeoutMs = 600000,
  model: ModelKey = 'sonnet'
): Promise<ClaudeResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const tempFile = path.join(LOGS_DIR, `temp-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);

    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.writeFileSync(tempFile, prompt);

    const modelFlag = model !== 'sonnet' ? ` --model ${AVAILABLE_MODELS[model].id}` : '';
    exec(
      `cat "${tempFile}" | claude -p --dangerously-skip-permissions --output-format json${modelFlag}`,
      {
        cwd: repoDir,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          PATH: `${process.env.HOME}/.npm-global/bin:${process.env.HOME}/.nvm/versions/node/${process.version}/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}`,
        },
      },
      (error, stdout, stderr) => {
        try { fs.unlinkSync(tempFile); } catch { /* ignore */ }

        const durationMs = Date.now() - startTime;

        if (error) {
          const estimatedTokens = Math.ceil(prompt.length / 4);
          resolve({
            success: false,
            result: `Error: ${error.message}`,
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

          resolve({
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
          resolve({
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
  });
}

/**
 * Calculate cost from exact token counts using Sonnet pricing.
 */
export function calculateCost(inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1_000_000) * PRICING.input + (outputTokens / 1_000_000) * PRICING.output;
}
