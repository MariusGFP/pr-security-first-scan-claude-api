export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getRepoById, updateRepo } from '@/lib/db';
import { getKeyValue } from '@/lib/claude';
import { logAndBroadcast } from '@/lib/websocket';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Resolve the actual repo directory:
 * 1. Try the DB local_path
 * 2. Try REPOS_DIR/{repoName}
 * 3. Try REPOS_DIR/{org}/{repoName}
 * If found in a different location, update the DB.
 */
function resolveRepoDir(repo: { id: number; name: string; org: string; local_path: string }): string | null {
  const dbPath = repo.local_path.replace('~', process.env.HOME || '');
  if (fs.existsSync(dbPath)) return dbPath;

  // Try REPOS_DIR from settings
  const reposDir = getKeyValue('REPOS_DIR') || path.join(process.env.HOME || '~', 'repos');
  const candidates = [
    path.join(reposDir, repo.name),
    path.join(reposDir, repo.org, repo.name),
    path.join(reposDir, 'github', repo.name),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.existsSync(path.join(candidate, '.git'))) {
      // Found it — update DB with the correct path
      updateRepo(repo.id, { local_path: candidate } as any);
      logAndBroadcast(`  [Repos] Updated path for ${repo.name}: ${candidate}`);
      return candidate;
    }
  }

  return null;
}

export async function POST(req: NextRequest) {
  const { repoId } = await req.json();

  const repo = getRepoById(repoId);
  if (!repo) return NextResponse.json({ error: 'Repo not found' }, { status: 404 });

  const repoDir = resolveRepoDir(repo);
  if (!repoDir) {
    const reposDir = getKeyValue('REPOS_DIR') || path.join(process.env.HOME || '~', 'repos');
    return NextResponse.json({
      error: `Repo directory not found. Checked: ${repo.local_path}, ${reposDir}/${repo.name}. Update the repo path or re-clone.`
    }, { status: 404 });
  }

  try {
    logAndBroadcast(`📥 Git Pull for ${repo.full_name}...`);

    // Update remote URL with fresh token before pulling
    const ghToken = getKeyValue('GH_TOKEN');
    if (ghToken) {
      try {
        execSync(
          `git remote set-url origin https://${ghToken}@github.com/${repo.full_name}.git`,
          { cwd: repoDir, timeout: 10000 }
        );
      } catch { /* ignore — may not be a github repo */ }
    }

    const output = execSync(
      `git fetch origin && git checkout -f ${repo.base_branch} && git reset --hard origin/${repo.base_branch}`,
      {
        cwd: repoDir,
        timeout: 60000,
        env: {
          ...process.env,
          PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
        },
      }
    ).toString().trim();

    logAndBroadcast(`✅ Git Pull for ${repo.full_name} successful: ${output.substring(0, 200)}`);

    // Get current commit info
    const commit = execSync('git log --oneline -1', { cwd: repoDir }).toString().trim();
    const branch = execSync('git branch --show-current', { cwd: repoDir }).toString().trim();

    return NextResponse.json({
      success: true,
      repo: repo.full_name,
      branch,
      commit,
      output: output.substring(0, 500),
    });
  } catch (error: any) {
    const msg = error.message || 'Unknown error';
    logAndBroadcast(`❌ Git Pull for ${repo.full_name} failed: ${msg.substring(0, 200)}`);
    return NextResponse.json({ error: msg.substring(0, 500) }, { status: 500 });
  }
}
