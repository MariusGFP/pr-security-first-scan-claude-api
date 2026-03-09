export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const TUNNEL_CONFIG = path.join(process.env.HOME || '~', '.cloudflared', 'config.yml');
const PLIST_PATH = path.join(process.env.HOME || '~', 'Library', 'LaunchAgents', 'com.claude.cloudflare-tunnel.plist');

const execOpts = {
  stdio: 'pipe' as const,
  timeout: 15000,
  env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' },
};

// GET: Tunnel status
export async function GET() {
  let tunnelRunning = false;
  let tunnelConfig: string | null = null;
  let tunnelId: string | null = null;
  let hostname: string | null = null;

  // Check if cloudflared is running
  try {
    const ps = execSync('pgrep -x cloudflared', execOpts).toString().trim();
    tunnelRunning = !!ps;
  } catch { tunnelRunning = false; }

  // Read tunnel config
  try {
    if (fs.existsSync(TUNNEL_CONFIG)) {
      tunnelConfig = fs.readFileSync(TUNNEL_CONFIG, 'utf8');
      const idMatch = tunnelConfig.match(/tunnel:\s*(.+)/);
      const hostMatch = tunnelConfig.match(/hostname:\s*(.+)/);
      if (idMatch) tunnelId = idMatch[1].trim();
      if (hostMatch) hostname = hostMatch[1].trim();
    }
  } catch { /* ignore */ }

  // Check launchd status
  let launchdLoaded = false;
  try {
    const list = execSync('launchctl list', execOpts).toString();
    launchdLoaded = list.includes('com.claude.cloudflare-tunnel');
  } catch { /* ignore */ }

  return NextResponse.json({
    running: tunnelRunning,
    tunnelId,
    hostname,
    launchdLoaded,
    configPath: TUNNEL_CONFIG,
    configExists: fs.existsSync(TUNNEL_CONFIG),
  });
}

// POST: Control tunnel (start/stop/restart)
export async function POST(req: NextRequest) {
  const { action } = await req.json();

  try {
    switch (action) {
      case 'start':
        execSync(`launchctl load "${PLIST_PATH}"`, execOpts);
        return NextResponse.json({ status: 'started' });

      case 'stop':
        execSync(`launchctl unload "${PLIST_PATH}"`, execOpts);
        return NextResponse.json({ status: 'stopped' });

      case 'restart':
        try { execSync(`launchctl unload "${PLIST_PATH}"`, execOpts); } catch { /* ignore */ }
        execSync(`launchctl load "${PLIST_PATH}"`, execOpts);
        return NextResponse.json({ status: 'restarted' });

      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
