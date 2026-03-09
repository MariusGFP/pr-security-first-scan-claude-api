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
