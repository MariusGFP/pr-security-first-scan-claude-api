export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { runPRReview } from '@/lib/review-engine';
import { getRepoByName, hasBeenReviewed } from '@/lib/db';
import { logAndBroadcast } from '@/lib/websocket';
import { getPRDetails } from '@/lib/github';
import type { GitHubWebhookPayload } from '@/types';
import path from 'path';

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'mac-mini-claude-webhook-2024';

function verifySignature(payload: string, signature: string | null): boolean {
  if (!signature) return false;
  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
  const digest = 'sha256=' + hmac.update(payload).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = req.headers.get('x-hub-signature-256');

  if (!verifySignature(body, signature)) {
    logAndBroadcast('⚠ Ungültige Webhook-Signatur');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  const event = req.headers.get('x-github-event');
  let payload: GitHubWebhookPayload;

  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }

  // Ping
  if (event === 'ping') {
    logAndBroadcast(`🏓 Ping: ${payload.zen}`);
    return NextResponse.json({ status: 'pong' });
  }

  // Pull Request
  if (event === 'pull_request') {
    const action = payload.action;

    if (!['opened', 'synchronize', 'reopened'].includes(action)) {
      logAndBroadcast(`📬 Ignoriert: ${payload.repository.name}#${payload.pull_request?.number} (${action})`);
      return NextResponse.json({ status: 'ignored', action });
    }

    const repoName = payload.repository.name;
    const pr = payload.pull_request!;
    const prBody = pr.body || '';
    const reviewKey = `${repoName}#${pr.number}`;

    // Check /review in PR body for forced re-review
    const forceReview = prBody.toLowerCase().includes('/review');
    const alreadyReviewed = hasBeenReviewed(repoName, pr.number);

    if (alreadyReviewed && !forceReview) {
      logAndBroadcast(`⏭ PR ${reviewKey} wurde bereits reviewed`);
      return NextResponse.json({ status: 'already_reviewed' });
    }

    if (alreadyReviewed && forceReview) {
      logAndBroadcast(`🔄 Re-Review erzwungen für ${reviewKey} (/review im PR-Body)`);
    }

    logAndBroadcast(`📬 PR-Event: ${payload.repository.full_name}#${pr.number} (${action}): "${pr.title}"`);

    // Start review asynchronously
    runPRReview(repoName, pr.number, pr.title, pr.head.ref, payload.repository.full_name, prBody);

    return NextResponse.json({ status: 'review_started', pr: pr.number });
  }

  // Issue Comment (/review command)
  if (event === 'issue_comment') {
    const commentBody = payload.comment?.body || '';
    const isPR = !!payload.issue?.pull_request;

    if (isPR && commentBody.trim().toLowerCase() === '/review') {
      const repoName = payload.repository.name;
      const prNumber = payload.issue!.number;
      const reviewKey = `${repoName}#${prNumber}`;

      logAndBroadcast(`🔄 /review Kommentar auf ${reviewKey}`);

      const repo = getRepoByName(repoName);
      if (!repo) {
        return NextResponse.json({ error: 'Repo not found' }, { status: 404 });
      }

      try {
        const repoDir = repo.local_path.replace('~', process.env.HOME || '');
        const prData = getPRDetails(repoDir, prNumber);
        runPRReview(repoName, prNumber, prData.title, prData.headRefName, payload.repository.full_name, prData.body);
        return NextResponse.json({ status: 're_review_started', pr: prNumber });
      } catch (e: any) {
        logAndBroadcast(`❌ PR-Details laden fehlgeschlagen: ${e.message}`);
        return NextResponse.json({ error: e.message }, { status: 500 });
      }
    }

    return NextResponse.json({ status: 'ignored', event: 'issue_comment' });
  }

  return NextResponse.json({ status: 'ignored', event });
}
