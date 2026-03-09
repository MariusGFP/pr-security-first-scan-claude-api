export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getKeyValue } from '@/lib/claude';
import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * POST: Pull latest changes for a repo by path.
 * Body: { repoPath: string }
 * Used by Security Scan freshness check (repos identified by path, not DB ID).
 */
export async function POST(req: NextRequest) {
  let repoPath: string;
  try {
    const body = await req.json();
    repoPath = body.repoPath;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!repoPath || typeof repoPath !== 'string') {
    return NextResponse.json({ error: 'repoPath required' }, { status: 400 });
  }

  const resolved = repoPath.replace(/^~/, process.env.HOME || '~');
  if (!fs.existsSync(resolved)) {
    return NextResponse.json({ error: 'Directory not found' }, { status: 404 });
  }

  // Verify it's actually a git repository
  if (!fs.existsSync(path.join(resolved, '.git'))) {
    return NextResponse.json({ error: 'Not a git repository' }, { status: 400 });
  }

  try {
    // Update remote URL with token if needed
    const ghToken = getKeyValue('GH_TOKEN');
    if (ghToken) {
      try {
        const remoteUrl = execSync('git remote get-url origin', { cwd: resolved, timeout: 5000, stdio: 'pipe' }).toString().trim();
        if (remoteUrl.includes('github.com') && !remoteUrl.includes(ghToken)) {
          const match = remoteUrl.match(/github\.com[/:](.+?)(?:\.git)?$/);
          if (match && /^[\w\-./]+$/.test(match[1])) {
            spawnSync('git', ['remote', 'set-url', 'origin', `https://${ghToken}@github.com/${match[1]}.git`], {
              cwd: resolved,
              timeout: 5000,
              stdio: 'pipe',
            });
          }
        }
      } catch {
        console.warn('Failed to update remote URL for authenticated access');
      }
    }

    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: resolved, timeout: 5000 }).toString().trim();

    // Validate branch name contains only safe characters and doesn't start with -
    if (!/^[\w][\w\-./]*$/.test(branch)) {
      return NextResponse.json({ error: 'Invalid branch name' }, { status: 400 });
    }

    const execEnv = {
      ...process.env,
      PATH: `${process.env.PATH || ''}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
    };

    execSync('git fetch origin', { cwd: resolved, timeout: 30000, env: execEnv });
    execSync(`git checkout -f -- ${branch}`, { cwd: resolved, timeout: 10000, env: execEnv });
    execSync(`git reset --hard origin/${branch}`, { cwd: resolved, timeout: 30000, env: execEnv });

    const commit = execSync('git log --oneline -1', { cwd: resolved, timeout: 5000 }).toString().trim();

    return NextResponse.json({ success: true, branch, commit });
  } catch (e: any) {
    console.error('Pull failed for repo:', resolved, e);
    return NextResponse.json({ error: 'Failed to pull repository' }, { status: 500 });
  }
}
