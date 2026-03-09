export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const KEYS_FILE = path.join(process.env.HOME || '~', '.keys');

interface Keys {
  GH_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  WEBHOOK_SECRET: string;
  AUDITS_DIR: string;
  REPOS_DIR: string;
}

const DEFAULT_AUDITS_DIR = path.join(process.env.HOME || '~', 'automation', 'audits');
const DEFAULT_REPOS_DIR = path.join(process.env.HOME || '~', 'repos');

function readKeys(): Keys {
  const keys: Keys = { GH_TOKEN: '', ANTHROPIC_API_KEY: '', WEBHOOK_SECRET: '', AUDITS_DIR: '', REPOS_DIR: '' };
  try {
    if (fs.existsSync(KEYS_FILE)) {
      const content = fs.readFileSync(KEYS_FILE, 'utf8');
      for (const line of content.split('\n')) {
        const match = line.match(/^export\s+(\w+)=["']?(.+?)["']?\s*$/);
        if (match) {
          const [, key, value] = match;
          if (key in keys) (keys as any)[key] = value;
        }
      }
    }
  } catch { /* ignore */ }
  return keys;
}

function writeKeys(keys: Keys) {
  const lines = [
    `export GH_TOKEN="${keys.GH_TOKEN}"`,
    `export ANTHROPIC_API_KEY="${keys.ANTHROPIC_API_KEY}"`,
    `export WEBHOOK_SECRET="${keys.WEBHOOK_SECRET || 'mac-mini-claude-webhook-2024'}"`,
    `export AUDITS_DIR="${keys.AUDITS_DIR || DEFAULT_AUDITS_DIR}"`,
    `export REPOS_DIR="${keys.REPOS_DIR || DEFAULT_REPOS_DIR}"`,
  ];
  fs.writeFileSync(KEYS_FILE, lines.join('\n') + '\n', { mode: 0o600 });
}

// GET: Read keys (masked)
export async function GET() {
  const keys = readKeys();
  return NextResponse.json({
    GH_TOKEN: keys.GH_TOKEN ? `${keys.GH_TOKEN.slice(0, 8)}...${keys.GH_TOKEN.slice(-4)}` : '',
    ANTHROPIC_API_KEY: keys.ANTHROPIC_API_KEY ? `${keys.ANTHROPIC_API_KEY.slice(0, 8)}...${keys.ANTHROPIC_API_KEY.slice(-4)}` : '',
    WEBHOOK_SECRET: keys.WEBHOOK_SECRET ? '••••••••' : '',
    AUDITS_DIR: keys.AUDITS_DIR || DEFAULT_AUDITS_DIR,
    REPOS_DIR: keys.REPOS_DIR || DEFAULT_REPOS_DIR,
    hasGhToken: !!keys.GH_TOKEN,
    hasAnthropicKey: !!keys.ANTHROPIC_API_KEY,
    hasWebhookSecret: !!keys.WEBHOOK_SECRET,
  });
}

// POST: Update keys
export async function POST(req: NextRequest) {
  const body = await req.json();
  const current = readKeys();

  // Only update provided fields (don't overwrite with empty)
  if (body.GH_TOKEN) current.GH_TOKEN = body.GH_TOKEN;
  if (body.ANTHROPIC_API_KEY) current.ANTHROPIC_API_KEY = body.ANTHROPIC_API_KEY;
  if (body.WEBHOOK_SECRET) current.WEBHOOK_SECRET = body.WEBHOOK_SECRET;
  if (body.AUDITS_DIR !== undefined) current.AUDITS_DIR = body.AUDITS_DIR;
  if (body.REPOS_DIR !== undefined) current.REPOS_DIR = body.REPOS_DIR;

  writeKeys(current);

  return NextResponse.json({ status: 'updated' });
}
