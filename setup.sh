#!/bin/bash
# ============================================
# Claude Dashboard — All-in-One Setup
# ============================================
# Dieses Script richtet ALLES ein:
# - Dashboard (Next.js + TypeScript)
# - Cloudflare Tunnel
# - API Keys (~/.keys + ~/.zshrc)
# - 9 Agent-Prompts (im Projekt enthalten)
# - launchd Services (Auto-Start bei Boot)
# - Bestehende Repos registrieren
#
# Nutzung: cd claude-dashboard && bash setup.sh
# ============================================

set -e

# ──────────────────────────────────────────────
# Konfiguration
# ──────────────────────────────────────────────
DASHBOARD_DIR=~/automation/claude-dashboard
REPOS_DIR=~/repos
LOGS_DIR=~/automation/logs
ACTUAL_USER=$(whoami)
HOME_DIR=$(eval echo ~$ACTUAL_USER)

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   Claude Dashboard — All-in-One Setup        ║"
echo "║   Mac Mini M4 Automation Server              ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ──────────────────────────────────────────────
# [1/8] Verzeichnisse
# ──────────────────────────────────────────────
echo "[1/8] Erstelle Verzeichnisse..."
mkdir -p "$DASHBOARD_DIR" "$REPOS_DIR" "$LOGS_DIR"

# Kopiere Projekt (falls wir nicht schon im Zielordner sind)
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
if [ "$SCRIPT_DIR" != "$DASHBOARD_DIR" ]; then
    echo "  Kopiere Projekt nach $DASHBOARD_DIR..."
    cp -r "$SCRIPT_DIR"/* "$DASHBOARD_DIR/"
    cp -r "$SCRIPT_DIR"/prompts "$DASHBOARD_DIR/" 2>/dev/null || true
fi
echo "  ✅ Verzeichnisse erstellt"

# ──────────────────────────────────────────────
# [2/8] API Keys einrichten
# ──────────────────────────────────────────────
echo "[2/8] Prüfe API Keys..."

if [ -f ~/.keys ]; then
    source ~/.keys
    echo "  ~/.keys gefunden"
    [ -n "$GH_TOKEN" ] && echo "  ✅ GH_TOKEN vorhanden" || echo "  ⚠ GH_TOKEN fehlt"
    [ -n "$ANTHROPIC_API_KEY" ] && echo "  ✅ ANTHROPIC_API_KEY vorhanden" || echo "  ⚠ ANTHROPIC_API_KEY fehlt"
else
    echo "  ⚠ ~/.keys nicht gefunden — erstelle Vorlage..."
    cat > ~/.keys << 'KEYSEOF'
export GH_TOKEN=""
export ANTHROPIC_API_KEY=""
export WEBHOOK_SECRET="mac-mini-claude-webhook-2024"
KEYSEOF
    chmod 600 ~/.keys
    echo "  ✅ ~/.keys erstellt (bitte Keys eintragen oder über Dashboard-UI)"
fi

# Sicherstellen dass ~/.zshrc existiert und ~/.keys sourced
if [ ! -f ~/.zshrc ]; then
    echo "source ~/.keys" > ~/.zshrc
    echo "  ✅ ~/.zshrc erstellt"
elif ! grep -q "source ~/.keys" ~/.zshrc; then
    echo "source ~/.keys" >> ~/.zshrc
    echo "  ✅ source ~/.keys zu ~/.zshrc hinzugefügt"
fi

# ──────────────────────────────────────────────
# [3/8] Dependencies installieren
# ──────────────────────────────────────────────
echo "[3/8] Installiere Dependencies..."
cd "$DASHBOARD_DIR"
npm install
echo "  ✅ Dependencies installiert"

# ──────────────────────────────────────────────
# [4/8] Build
# ──────────────────────────────────────────────
echo "[4/8] Baue Dashboard..."
npm run build
echo "  ✅ Build erfolgreich"

# ──────────────────────────────────────────────
# [5/8] Cloudflare Tunnel
# ──────────────────────────────────────────────
echo "[5/8] Prüfe Cloudflare Tunnel..."

if command -v cloudflared &> /dev/null; then
    echo "  ✅ cloudflared installiert"
else
    echo "  Installiere cloudflared..."
    brew install cloudflare/cloudflare/cloudflared 2>/dev/null || echo "  ⚠ cloudflared manuell installieren: brew install cloudflare/cloudflare/cloudflared"
fi

if [ -f ~/.cloudflared/config.yml ]; then
    echo "  ✅ Tunnel-Config vorhanden"
    grep "hostname:" ~/.cloudflared/config.yml 2>/dev/null | sed 's/^/  /'
else
    echo "  ⚠ Kein Tunnel konfiguriert"
    echo "  Um einen Tunnel einzurichten:"
    echo "    cloudflared tunnel create claude-webhook"
    echo "    # Dann config.yml erstellen (siehe README)"
fi

# Cloudflare Tunnel launchd Service
cat > ~/Library/LaunchAgents/com.claude.cloudflare-tunnel.plist << TUNNELPLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude.cloudflare-tunnel</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/cloudflared</string>
        <string>tunnel</string>
        <string>run</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${HOME_DIR}/automation/logs/tunnel-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${HOME_DIR}/automation/logs/tunnel-stderr.log</string>
</dict>
</plist>
TUNNELPLIST

echo "  ✅ Cloudflare Tunnel launchd Service erstellt"

# ──────────────────────────────────────────────
# [6/8] Alten Webhook-Server deaktivieren
# ──────────────────────────────────────────────
echo "[6/8] Deaktiviere alten Webhook-Server..."
launchctl unload ~/Library/LaunchAgents/com.claude.webhook-server.plist 2>/dev/null || true
echo "  ✅ Alter Server deaktiviert (falls vorhanden)"

# ──────────────────────────────────────────────
# [7/8] Dashboard launchd Service
# ──────────────────────────────────────────────
echo "[7/8] Erstelle Dashboard launchd Service..."

# Keys für plist sammeln
source ~/.keys 2>/dev/null || true

cat > ~/Library/LaunchAgents/com.claude.dashboard.plist << DASHPLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude.dashboard</string>

    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/npx</string>
        <string>tsx</string>
        <string>server.ts</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${HOME_DIR}/automation/claude-dashboard</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_ENV</key>
        <string>production</string>
        <key>PORT</key>
        <string>3000</string>
        <key>DASHBOARD_DIR</key>
        <string>${HOME_DIR}/automation/claude-dashboard</string>
        <key>GH_TOKEN</key>
        <string>${GH_TOKEN:-}</string>
        <key>ANTHROPIC_API_KEY</key>
        <string>${ANTHROPIC_API_KEY:-}</string>
        <key>WEBHOOK_SECRET</key>
        <string>${WEBHOOK_SECRET:-mac-mini-claude-webhook-2024}</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${HOME_DIR}/automation/logs/dashboard-stdout.log</string>

    <key>StandardErrorPath</key>
    <string>${HOME_DIR}/automation/logs/dashboard-stderr.log</string>
</dict>
</plist>
DASHPLIST

echo "  ✅ Dashboard launchd Service erstellt"

# ──────────────────────────────────────────────
# [8/8] Services starten
# ──────────────────────────────────────────────
echo "[8/8] Starte Services..."

# Tunnel starten (falls Config vorhanden)
if [ -f ~/.cloudflared/config.yml ]; then
    launchctl unload ~/Library/LaunchAgents/com.claude.cloudflare-tunnel.plist 2>/dev/null || true
    launchctl load ~/Library/LaunchAgents/com.claude.cloudflare-tunnel.plist
    echo "  ✅ Cloudflare Tunnel gestartet"
else
    echo "  ⏭ Tunnel übersprungen (keine Config)"
fi

# Dashboard starten
launchctl unload ~/Library/LaunchAgents/com.claude.dashboard.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.claude.dashboard.plist
echo "  ✅ Dashboard gestartet"

# Kurz warten und Health-Check
echo ""
echo "  Warte 5 Sekunden auf Start..."
sleep 5

if curl -s http://localhost:3000/api/health > /dev/null 2>&1; then
    echo "  ✅ Health-Check erfolgreich!"
else
    echo "  ⚠ Dashboard antwortet noch nicht — prüfe Logs:"
    echo "    tail -f ~/automation/logs/dashboard-stderr.log"
fi

# ──────────────────────────────────────────────
# Zusammenfassung
# ──────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   ✅ All-in-One Setup abgeschlossen!         ║"
echo "╠══════════════════════════════════════════════╣"
echo "║                                              ║"
echo "║   Dashboard:  http://localhost:3000           ║"
echo "║   Webhook:    http://localhost:3000/api/webhook║"
echo "║   Health:     http://localhost:3000/api/health ║"
echo "║   WebSocket:  ws://localhost:3000/ws          ║"
echo "║                                              ║"
echo "║   Was ist enthalten:                         ║"
echo "║   ✅ Dashboard (Next.js + TypeScript)         ║"
echo "║   ✅ 9 Agent-Prompts (bearbeitbar im UI)     ║"
echo "║   ✅ Cloudflare Tunnel (launchd)              ║"
echo "║   ✅ API Keys (~/.keys)                       ║"
echo "║   ✅ Webhook-Server (ersetzt alten JS-Server) ║"
echo "║   ✅ Auto-Start bei Mac-Boot                  ║"
echo "║                                              ║"
echo "║   Nächste Schritte:                          ║"
echo "║   1. Dashboard öffnen: http://localhost:3000  ║"
echo "║   2. Repos hinzufügen (oder sie sind schon da)║"
echo "║   3. Erst-Scan starten                       ║"
echo "║                                              ║"
echo "╚══════════════════════════════════════════════╝"
