# Claude Dashboard

TypeScript + Next.js Dashboard für den Mac Mini M4 Automation Server.
Ersetzt den bisherigen `webhook-server.js` und `smart-scan.sh`.

## Setup auf dem Mac Mini

```bash
# 1. In den Ordner wechseln
cd ~/automation/claude-dashboard

# 2. Setup-Script ausführen (installiert, baut, startet)
bash setup.sh
```

Oder manuell:

```bash
cd ~/automation/claude-dashboard
npm install
npm run build
npx tsx server.ts
```

## Features

- **Dashboard:** Live-Status, Kosten-Tracking, Review-History
- **Repos:** Hinzufügen, Erst-Scan, Webhook-Management
- **Reviews:** Detail-Ansicht mit Agent-Status und vollständigem Report
- **Logs:** Live-Viewer mit Filter
- **Settings:** Übersicht aller Konfigurationen

## Architektur

```
GitHub PR Event
  → Cloudflare Tunnel (webhook.serendipity.education)
  → Next.js API Route (/api/webhook)
  → Review Engine (9 Agents parallel, dynamische Sub-Agents)
  → Aggregation → PR-Kommentar auf GitHub
  → SQLite Logging (Kosten, Findings, History)
  → WebSocket Broadcast (Live-UI-Updates)
```

## Ports

- `3000` — Dashboard + Webhook (ersetzt den alten webhook-server.js)
- `/ws` — WebSocket für Live-Updates
