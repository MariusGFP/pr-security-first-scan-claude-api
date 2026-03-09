export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import os from 'os';

const execOpts = {
  stdio: 'pipe' as const,
  timeout: 10000,
  env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' },
};

// GET: System status overview
export async function GET() {
  // Dashboard process
  const dashboardUptime = process.uptime();

  // Cloudflare tunnel
  let tunnelRunning = false;
  try {
    execSync('pgrep -x cloudflared', execOpts);
    tunnelRunning = true;
  } catch { tunnelRunning = false; }

  // Claude CLI available
  let claudeAvailable = false;
  let claudeVersion = '';
  try {
    claudeVersion = execSync('claude --version', execOpts).toString().trim();
    claudeAvailable = true;
  } catch { /* ignore */ }

  // gh CLI available
  let ghAvailable = false;
  try {
    execSync('gh auth status', execOpts);
    ghAvailable = true;
  } catch { /* ignore */ }

  // System info
  const systemInfo = {
    platform: os.platform(),
    arch: os.arch(),
    cpus: os.cpus().length,
    totalMemory: Math.round(os.totalmem() / 1024 / 1024 / 1024) + ' GB',
    freeMemory: Math.round(os.freemem() / 1024 / 1024 / 1024 * 10) / 10 + ' GB',
    hostname: os.hostname(),
    nodeVersion: process.version,
  };

  // launchd services
  let services: { name: string; loaded: boolean }[] = [];
  try {
    const list = execSync('launchctl list', execOpts).toString();
    services = [
      { name: 'com.claude.dashboard', loaded: list.includes('com.claude.dashboard') },
      { name: 'com.claude.cloudflare-tunnel', loaded: list.includes('com.claude.cloudflare-tunnel') },
      { name: 'com.claude.webhook-server', loaded: list.includes('com.claude.webhook-server') },
    ];
  } catch { /* ignore */ }

  return NextResponse.json({
    dashboard: {
      uptime: dashboardUptime,
      uptimeFormatted: formatUptime(dashboardUptime),
    },
    tunnel: { running: tunnelRunning },
    claude: { available: claudeAvailable, version: claudeVersion },
    gh: { available: ghAvailable },
    system: systemInfo,
    services,
  });
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
