export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getRepoById } from '@/lib/db';
import { getKeyValue } from '@/lib/claude';
import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const execOpts = {
  timeout: 30000,
  env: {
    ...process.env,
    PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}`,
  },
};

interface FreshnessResult {
  path: string;
  name: string;
  upToDate: boolean;
  localCommit: string;
  remoteCommit: string;
  behind: number;
  branch: string;
  error?: string;
}

/**
 * Check freshness for a single repo directory.
 */
function checkFreshness(repoDir: string, repoName: string): FreshnessResult {
  try {
    // Verify it's a git repository
    if (!fs.existsSync(path.join(repoDir, '.git'))) {
      return {
        path: repoDir,
        name: repoName,
        upToDate: true,
        localCommit: '',
        remoteCommit: '',
        behind: 0,
        branch: '',
        error: 'Not a git repository',
      };
    }

    // Update remote URL with token if available
    const ghToken = getKeyValue('GH_TOKEN');
    if (ghToken) {
      try {
        const remoteUrl = execSync('git remote get-url origin', { cwd: repoDir, timeout: 5000, stdio: 'pipe' }).toString().trim();
        if (remoteUrl.includes('github.com') && !remoteUrl.includes(ghToken)) {
          const match = remoteUrl.match(/github\.com[/:](.+?)(?:\.git)?$/);
          if (match && /^[\w\-./]+$/.test(match[1])) {
            spawnSync('git', ['remote', 'set-url', 'origin', `https://${ghToken}@github.com/${match[1]}.git`], {
              cwd: repoDir,
              timeout: 5000,
              stdio: 'pipe',
            });
          }
        }
      } catch {
        console.warn('Failed to update remote URL for authenticated access');
      }
    }

    // Fetch latest from remote
    try {
      execSync('git fetch origin', { ...execOpts, cwd: repoDir, stdio: 'pipe' });
    } catch (fetchErr: any) {
      console.warn(`git fetch failed for ${repoName}:`, fetchErr.stderr?.toString?.() || fetchErr.message);
      // Continue anyway — compare with whatever origin info we have
    }

    let branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoDir, timeout: 5000 }).toString().trim();
    const localCommit = execSync('git rev-parse --short HEAD', { cwd: repoDir, timeout: 5000 }).toString().trim();

    // Detached HEAD — try to find the default branch
    if (branch === 'HEAD') {
      try {
        // Try origin/HEAD -> origin/main etc.
        const defaultRef = execSync('git symbolic-ref refs/remotes/origin/HEAD', { cwd: repoDir, timeout: 5000, stdio: 'pipe' }).toString().trim();
        branch = defaultRef.replace('refs/remotes/origin/', '');
      } catch {
        // Fallback: try 'main', then 'master'
        try {
          execSync('git rev-parse --verify origin/main', { cwd: repoDir, timeout: 5000, stdio: 'pipe' });
          branch = 'main';
        } catch {
          try {
            execSync('git rev-parse --verify origin/master', { cwd: repoDir, timeout: 5000, stdio: 'pipe' });
            branch = 'master';
          } catch {
            // Give up — can't determine branch
          }
        }
      }
    }

    let remoteCommit = '';
    let behind = 0;

    // Validate branch name (must not start with -)
    if (branch !== 'HEAD' && /^[\w][\w\-./]*$/.test(branch)) {
      try {
        remoteCommit = execSync(`git rev-parse --short origin/${branch}`, { cwd: repoDir, timeout: 5000 }).toString().trim();
        const behindStr = execSync(`git rev-list --count HEAD..origin/${branch}`, { cwd: repoDir, timeout: 5000 }).toString().trim();
        behind = parseInt(behindStr, 10) || 0;
      } catch {
        // No remote tracking branch
        remoteCommit = localCommit;
        behind = 0;
      }
    } else {
      // Branch name contains characters not safe for shell execution
      remoteCommit = localCommit;
      behind = 0;
    }

    return {
      path: repoDir,
      name: repoName,
      upToDate: behind === 0,
      localCommit,
      remoteCommit,
      behind,
      branch,
    };
  } catch (e: any) {
    console.warn(`Freshness check failed for ${repoName}:`, e.message);
    return {
      path: repoDir,
      name: repoName,
      upToDate: true, // Assume up-to-date on error to not block scans
      localCommit: '',
      remoteCommit: '',
      behind: 0,
      branch: '',
      error: e.message,
    };
  }
}

/**
 * POST: Check freshness for repos.
 * Body: { repoId: number } (for First Scan)
 *    or { repoPaths: string[] } (for Security Scan)
 */
export async function POST(req: NextRequest) {
  let body: { repoId?: number; repoPaths?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Mode 1: Single repo by ID (First Scan)
  if (body.repoId !== undefined) {
    const repo = getRepoById(body.repoId);
    if (!repo) return NextResponse.json({ error: 'Repo not found' }, { status: 404 });

    const repoDir = repo.local_path.replace(/^~/, process.env.HOME || '~');
    if (!fs.existsSync(repoDir)) {
      return NextResponse.json({ error: 'Repo directory not found' }, { status: 404 });
    }

    const result = checkFreshness(repoDir, repo.name);
    return NextResponse.json({ repos: [result] });
  }

  // Mode 2: Multiple repo paths (Security Scan)
  if (body.repoPaths && Array.isArray(body.repoPaths)) {
    const results: FreshnessResult[] = [];
    for (const repoPath of body.repoPaths) {
      const resolved = repoPath.replace(/^~/, process.env.HOME || '~');
      if (!fs.existsSync(resolved)) {
        results.push({
          path: resolved,
          name: path.basename(resolved),
          upToDate: true,
          localCommit: '',
          remoteCommit: '',
          behind: 0,
          branch: '',
          error: 'Directory not found',
        });
        continue;
      }
      results.push(checkFreshness(resolved, path.basename(resolved)));
    }
    return NextResponse.json({ repos: results });
  }

  return NextResponse.json({ error: 'repoId or repoPaths required' }, { status: 400 });
}
