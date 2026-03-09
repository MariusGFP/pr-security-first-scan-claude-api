/**
 * Custom Next.js server with WebSocket support.
 * This replaces the default `next start` to add WebSocket connections
 * for real-time log streaming and review progress updates.
 */
import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { WebSocketServer, WebSocket } from 'ws';
import { setClients } from './src/lib/websocket';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * System bootstrap: ensure all prerequisites are met before starting.
 * Runs once at server startup — fixes issues automatically where possible.
 */
function bootstrap() {
  const checks: string[] = [];
  const fixes: string[] = [];
  const errors: string[] = [];

  // 1. SSH known_hosts for github.com
  const sshDir = path.join(process.env.HOME || '~', '.ssh');
  const knownHostsFile = path.join(sshDir, 'known_hosts');
  let githubKnown = false;
  if (fs.existsSync(knownHostsFile)) {
    githubKnown = fs.readFileSync(knownHostsFile, 'utf8').includes('github.com');
  }
  if (githubKnown) {
    checks.push('SSH github.com: OK');
  } else {
    try {
      if (!fs.existsSync(sshDir)) fs.mkdirSync(sshDir, { mode: 0o700, recursive: true });
      const keys = execSync('ssh-keyscan -t ed25519,rsa github.com 2>/dev/null', { timeout: 15000 }).toString();
      if (keys.trim()) {
        fs.appendFileSync(knownHostsFile, keys);
        fs.chmodSync(knownHostsFile, 0o644);
        fixes.push('SSH github.com: key added to known_hosts');
      } else {
        errors.push('SSH github.com: ssh-keyscan returned empty');
      }
    } catch (e: any) {
      errors.push(`SSH github.com: failed to add key (${e.message})`);
    }
  }

  // 2. Claude CLI
  try {
    const claudePath = execSync('which claude', { timeout: 5000, stdio: 'pipe' }).toString().trim();
    checks.push(`Claude CLI: ${claudePath}`);
  } catch {
    errors.push('Claude CLI: not found in PATH');
  }

  // 3. Prompt directories
  const promptDirs = ['prompts/security-scan', 'prompts/first-scan'];
  for (const dir of promptDirs) {
    const fullPath = path.join(process.cwd(), dir);
    if (fs.existsSync(fullPath)) {
      const count = fs.readdirSync(fullPath).filter(f => f.endsWith('.md')).length;
      checks.push(`${dir}: ${count} prompts`);
    } else {
      errors.push(`${dir}: directory missing`);
    }
  }

  // 4. Git available
  try {
    execSync('git --version', { timeout: 5000, stdio: 'pipe' });
    checks.push('Git: OK');
  } catch {
    errors.push('Git: not found');
  }

  // Print results
  console.log('\n--- System Bootstrap ---');
  for (const c of checks) console.log(`  ✅ ${c}`);
  for (const f of fixes) console.log(`  🔧 ${f}`);
  for (const e of errors) console.log(`  ❌ ${e}`);
  console.log('------------------------\n');
}

bootstrap();

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
const port = parseInt(process.env.PORT || '3000', 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url!, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Request error:', err);
      res.statusCode = 500;
      res.end('Internal Server Error');
    }
  });

  // WebSocket Server
  const wss = new WebSocketServer({ server, path: '/ws' });
  const clients = new Set<WebSocket>();
  setClients(clients as any);

  wss.on('connection', (ws) => {
    clients.add(ws);
    console.log(`[WS] Client connected (${clients.size} total)`);

    ws.send(JSON.stringify({
      type: 'log',
      data: 'Dashboard verbunden',
      timestamp: new Date().toISOString(),
    }));

    ws.on('close', () => {
      clients.delete(ws);
      console.log(`[WS] Client disconnected (${clients.size} remaining)`);
    });

    ws.on('error', () => {
      clients.delete(ws);
    });
  });

  server.listen(port, hostname, () => {
    console.log(`\n🚀 Claude Dashboard gestartet`);
    console.log(`   URL:       http://localhost:${port}`);
    console.log(`   WebSocket: ws://localhost:${port}/ws`);
    console.log(`   Webhook:   http://localhost:${port}/api/webhook`);
    console.log(`   Health:    http://localhost:${port}/api/health`);
    console.log('');
  });
});
