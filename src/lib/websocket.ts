import type { WSMessage } from '@/types';

// WebSocket clients — wird vom Custom Server initialisiert
let clients: Set<{ send: (data: string) => void }> = new Set();

export function setClients(c: Set<{ send: (data: string) => void }>) {
  clients = c;
}

export function getClients() {
  return clients;
}

/**
 * Broadcast a message to all connected WebSocket clients
 */
export function broadcast(msg: WSMessage) {
  const data = JSON.stringify(msg);
  for (const client of clients) {
    try {
      client.send(data);
    } catch {
      clients.delete(client);
    }
  }
}

/**
 * Log a message and broadcast it to all WebSocket clients
 */
export function logAndBroadcast(message: string) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}`;
  console.log(line);

  // Also append to file
  const fs = require('fs');
  const path = require('path');
  const logDir = path.join(process.env.HOME || '~', 'automation', 'logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(path.join(logDir, 'webhook.log'), line + '\n');

  broadcast({ type: 'log', data: message, timestamp });
}

/**
 * Broadcast structured scan progress for live UI updates
 */
export function broadcastScanProgress(scanId: number, progress: {
  phase: string;
  agents?: Array<{
    id: string;
    name: string;
    status: string;
    chars?: number;
    cost?: number;
    attempt?: number;
  }>;
  totalCost?: number;
  duration?: number;
}) {
  broadcast({
    type: 'scan-progress',
    data: JSON.stringify({ scanId, ...progress }),
    timestamp: new Date().toISOString(),
  });
}
