export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getAllRepos, createRepo, getRepoByName } from '@/lib/db';
import { createWebhook, cloneRepo } from '@/lib/github';
import { logAndBroadcast } from '@/lib/websocket';
import path from 'path';
import fs from 'fs';
import { getKeyValue } from '@/lib/claude';

function getReposDir(): string {
  const configured = getKeyValue('REPOS_DIR');
  if (configured) return configured.replace(/^~/, process.env.HOME || '~');
  return path.join(process.env.HOME || '~', 'repos');
}
const WEBHOOK_URL = 'https://webhook.serendipity.education/api/webhook';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'mac-mini-claude-webhook-2024';

export async function GET() {
  const repos = getAllRepos();
  return NextResponse.json(repos);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { org, name, skipWebhook } = body;

  if (!org || !name) {
    return NextResponse.json({ error: 'org and name required' }, { status: 400 });
  }

  // Check if already exists
  if (getRepoByName(name)) {
    return NextResponse.json({ error: 'Repo already exists' }, { status: 409 });
  }

  const fullName = `${org}/${name}`;
  const localPath = path.join(getReposDir(), name);

  try {
    // 1. Clone if not exists
    if (!fs.existsSync(localPath)) {
      logAndBroadcast(`📥 Klone ${fullName}...`);
      cloneRepo(org, name);
      logAndBroadcast(`✅ ${fullName} geklont nach ${localPath}`);
    }

    // 2. Create webhook (skip if already exists, e.g. ZEHUB)
    let webhookId: number | null = null;
    if (!skipWebhook) {
      logAndBroadcast(`🔗 Erstelle Webhook für ${fullName}...`);
      try {
        webhookId = createWebhook(org, name, WEBHOOK_URL, WEBHOOK_SECRET);
        logAndBroadcast(`✅ Webhook erstellt (ID: ${webhookId})`);
      } catch (e: any) {
        logAndBroadcast(`⚠ Webhook-Erstellung fehlgeschlagen: ${e.message}`);
      }
    } else {
      logAndBroadcast(`⏭ Webhook übersprungen für ${fullName} (skipWebhook=true)`);
    }

    // 3. Add to DB
    const id = createRepo({
      name,
      org,
      full_name: fullName,
      local_path: localPath,
      base_branch: 'main',
      webhook_id: webhookId,
      monitoring_active: true,
      thresholds_json: null,
    });

    logAndBroadcast(`✅ ${fullName} hinzugefügt (ID: ${id})`);

    return NextResponse.json({ id, name, org, full_name: fullName, webhook_id: webhookId });

  } catch (e: any) {
    logAndBroadcast(`❌ Repo hinzufügen fehlgeschlagen: ${e.message}`);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
