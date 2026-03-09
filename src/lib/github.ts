import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

function getReposDir(): string {
  try {
    const keysFile = path.join(process.env.HOME || '~', '.keys');
    const content = fs.readFileSync(keysFile, 'utf8');
    const match = content.match(/^export\s+REPOS_DIR=["']?(.+?)["']?\s*$/m);
    if (match) return match[1].replace(/^~/, process.env.HOME || '~');
  } catch { /* ignore */ }
  return path.join(process.env.HOME || '~', 'repos');
}

function getGhToken(): string {
  try {
    const keysFile = path.join(process.env.HOME || '~', '.keys');
    const content = fs.readFileSync(keysFile, 'utf8');
    const match = content.match(/^export\s+GH_TOKEN=["']?(.+?)["']?\s*$/m);
    if (match) return match[1];
  } catch { /* ignore */ }
  return process.env.GH_TOKEN || '';
}

const execOptions = {
  stdio: 'pipe' as const,
  timeout: 30000,
  env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' },
};

/**
 * Create a GitHub webhook for a repository
 */
export function createWebhook(org: string, repo: string, webhookUrl: string, secret: string): number {
  const result = execSync(
    `gh api repos/${org}/${repo}/hooks --method POST --input - <<'EOF'
{
  "name": "web",
  "active": true,
  "events": ["pull_request", "issue_comment"],
  "config": {
    "url": "${webhookUrl}",
    "content_type": "json",
    "secret": "${secret}",
    "insecure_ssl": "0"
  }
}
EOF`,
    execOptions
  ).toString();

  const parsed = JSON.parse(result);
  return parsed.id;
}

/**
 * Delete a GitHub webhook
 */
export function deleteWebhook(org: string, repo: string, hookId: number) {
  execSync(`gh api repos/${org}/${repo}/hooks/${hookId} --method DELETE`, execOptions);
}

/**
 * Check if a webhook exists and is active
 */
export function getWebhookStatus(org: string, repo: string, hookId: number): { active: boolean; events: string[] } | null {
  try {
    const result = execSync(
      `gh api repos/${org}/${repo}/hooks/${hookId} --jq '{active, events}'`,
      execOptions
    ).toString();
    return JSON.parse(result);
  } catch {
    return null;
  }
}

/**
 * Clone a repository
 */
export function cloneRepo(org: string, repo: string): string {
  const localPath = path.join(getReposDir(), repo);
  const ghToken = getGhToken();
  const ghUser = 'MariusGFP';

  execSync(`git clone https://${ghUser}:${ghToken}@github.com/${org}/${repo}.git "${localPath}"`, {
    ...execOptions,
    timeout: 120000,
  });

  return localPath;
}

/**
 * Get PR details from GitHub
 */
export function getPRDetails(repoDir: string, prNumber: number): { title: string; headRefName: string; body: string } {
  const result = execSync(
    `gh pr view ${prNumber} --json title,headRefName,body`,
    { ...execOptions, cwd: repoDir }
  ).toString();
  return JSON.parse(result);
}

/**
 * List open PRs for a repo
 */
export function listOpenPRs(org: string, repo: string): { number: number; title: string; author: string }[] {
  try {
    const result = execSync(
      `gh pr list --repo ${org}/${repo} --json number,title,author --limit 20`,
      execOptions
    ).toString();
    return JSON.parse(result);
  } catch {
    return [];
  }
}
