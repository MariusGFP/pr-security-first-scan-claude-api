export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getKeyValue } from '@/lib/claude';
import { logAndBroadcast } from '@/lib/websocket';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

function getReposDir(): string {
  const fromKeys = getKeyValue('REPOS_DIR');
  return fromKeys || path.join(process.env.HOME || '~', 'repos');
}

function getGhToken(): string {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const keysFile = path.join(process.env.HOME || '~', '.keys');
    const content = fs.readFileSync(keysFile, 'utf8');
    const match = content.match(/^export\s+GH_TOKEN=["']?(.+?)["']?\s*$/m);
    if (match) return match[1];
  } catch { /* ignore */ }
  return '';
}

const execOptions = {
  stdio: 'pipe' as const,
  timeout: 120000,
  env: { ...process.env, PATH: `${process.env.HOME}/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}` },
};

// Ensure security_scan_repos table exists (with migration for old schema)
function ensureTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS security_scan_repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform_name TEXT NOT NULL,
      local_path TEXT NOT NULL,
      repo_name TEXT NOT NULL,
      branch TEXT DEFAULT 'main',
      source TEXT DEFAULT 'local',
      github_url TEXT,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(platform_name, repo_name)
    );
  `);

  // Migrate: add missing columns if table existed before
  try {
    const cols = db.prepare("PRAGMA table_info(security_scan_repos)").all() as any[];
    const colNames = cols.map((c: any) => c.name);
    if (!colNames.includes('source')) {
      db.exec("ALTER TABLE security_scan_repos ADD COLUMN source TEXT DEFAULT 'local'");
    }
    if (!colNames.includes('github_url')) {
      db.exec("ALTER TABLE security_scan_repos ADD COLUMN github_url TEXT");
    }
  } catch { /* ignore */ }
}

// GET: List all security scan repos, grouped by platform
export async function GET() {
  ensureTable();
  const repos = getDb().prepare('SELECT * FROM security_scan_repos ORDER BY platform_name, repo_name').all();

  // Group by platform
  const platforms: Record<string, any[]> = {};
  for (const repo of repos as any[]) {
    if (!platforms[repo.platform_name]) platforms[repo.platform_name] = [];
    platforms[repo.platform_name].push(repo);
  }

  return NextResponse.json({ repos, platforms });
}

// POST: Add a repo to a platform (local path OR GitHub clone)
export async function POST(req: NextRequest) {
  ensureTable();
  const { platformName, localPath, githubUrl, branch } = await req.json();

  if (!platformName) {
    return NextResponse.json({ error: 'platformName is required' }, { status: 400 });
  }

  if (!localPath && !githubUrl) {
    return NextResponse.json({ error: 'Either localPath or githubUrl is required' }, { status: 400 });
  }

  let resolvedPath: string;
  let repoName: string;
  let source: string;

  // Auto-detect branch from GitHub URL if contains /tree/branch-name
  let detectedBranch: string | null = null;
  if (githubUrl) {
    const branchMatch = githubUrl.match(/\/tree\/([^/?#]+)/);
    if (branchMatch) detectedBranch = branchMatch[1];
  }
  const repoBranch = branch || detectedBranch || 'main';

  if (localPath) {
    // ── Mode 1: Lokaler Pfad ──
    source = 'local';
    resolvedPath = localPath.replace('~', process.env.HOME || '');

    if (!fs.existsSync(resolvedPath)) {
      return NextResponse.json({ error: `Directory not found: ${localPath}` }, { status: 404 });
    }

    repoName = path.basename(resolvedPath);

  } else {
    // ── Mode 2: GitHub Clone ──
    source = 'github';

    // Parse GitHub URL: support multiple formats
    // - https://github.com/org/repo
    // - https://github.com/org/repo/tree/branch
    // - https://github.com/org/repo.git
    // - org/repo
    let org: string;
    let repo: string;

    // Strip .git suffix and /tree/... path
    const cleanUrl = githubUrl.replace(/\.git$/, '').replace(/\/tree\/.*$/, '').trim();

    const urlMatch = cleanUrl.match(/github\.com[/:]([^/]+)\/([^/]+)\/?$/);
    const shortMatch = cleanUrl.match(/^([^/\s]+)\/([^/\s]+)$/);

    if (urlMatch) {
      org = urlMatch[1];
      repo = urlMatch[2];
    } else if (shortMatch) {
      org = shortMatch[1];
      repo = shortMatch[2];
    } else {
      return NextResponse.json({ error: `Invalid GitHub format: ${githubUrl}. Use "org/repo" or full URL.` }, { status: 400 });
    }

    repoName = repo;

    // Clone into repos directory
    const reposDir = getReposDir();
    if (!fs.existsSync(reposDir)) {
      fs.mkdirSync(reposDir, { recursive: true });
    }

    resolvedPath = path.join(reposDir, platformName.toLowerCase().replace(/\s+/g, '-'), repo);

    if (fs.existsSync(resolvedPath)) {
      // Repo already cloned → update remote URL with fresh token, then pull
      logAndBroadcast(`📥 ${repo} already exists, updating...`);
      try {
        const ghToken = getGhToken();
        const ghUser = process.env.GH_USER || 'MariusGFP';
        // Update remote URL with current token (in case it was rotated)
        const freshUrl = ghToken
          ? `https://${ghUser}:${ghToken}@github.com/${org}/${repo}.git`
          : `https://github.com/${org}/${repo}.git`;
        execSync(`git remote set-url origin "${freshUrl}"`, { ...execOptions, cwd: resolvedPath });

        execSync(`git fetch origin && git checkout -f ${repoBranch} && git reset --hard origin/${repoBranch}`, {
          ...execOptions,
          cwd: resolvedPath,
        });
        logAndBroadcast(`✅ ${repo} updated (${repoBranch})`);
      } catch (e: any) {
        logAndBroadcast(`⚠️ Pull failed: ${e.message}`);
      }
    } else {
      // Clone fresh
      logAndBroadcast(`📥 Cloning ${org}/${repo} (Branch: ${repoBranch})...`);
      const parentDir = path.dirname(resolvedPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      try {
        const ghToken = getGhToken();
        const ghUser = process.env.GH_USER || 'MariusGFP';
        const cloneUrl = ghToken
          ? `https://${ghUser}:${ghToken}@github.com/${org}/${repo}.git`
          : `https://github.com/${org}/${repo}.git`;

        execSync(`git clone --branch ${repoBranch} ${cloneUrl} "${resolvedPath}"`, {
          ...execOptions,
          timeout: 300000, // 5 min for large repos
        });
        logAndBroadcast(`✅ ${org}/${repo} cloned to ${resolvedPath}`);
      } catch (e: any) {
        logAndBroadcast(`❌ Clone failed: ${e.message}`);
        return NextResponse.json({ error: `Clone failed: ${e.message}` }, { status: 500 });
      }
    }
  }

  try {
    getDb().prepare(
      'INSERT INTO security_scan_repos (platform_name, local_path, repo_name, branch, source, github_url) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(platformName, resolvedPath, repoName, repoBranch, source, githubUrl || null);
  } catch (e: any) {
    if (e.message?.includes('UNIQUE')) {
      return NextResponse.json({ error: `Repo "${repoName}" already exists for platform "${platformName}"` }, { status: 409 });
    }
    throw e;
  }

  return NextResponse.json({ success: true, repoName, localPath: resolvedPath, source });
}

// DELETE: Remove a repo
export async function DELETE(req: NextRequest) {
  ensureTable();
  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  getDb().prepare('DELETE FROM security_scan_repos WHERE id = ?').run(id);
  return NextResponse.json({ success: true });
}
