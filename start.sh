#!/bin/bash
# Wrapper script for Claude Dashboard with auto-restart on update.
# Usage: ./start.sh
# Exit code 42 = restart after update, anything else = stop.

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

while true; do
  echo "🚀 Starting Claude Dashboard..."
  npm start
  EXIT_CODE=$?

  if [ "$EXIT_CODE" -eq 42 ]; then
    echo ""
    echo "🔄 Update complete — restarting server..."
    echo ""
    sleep 1
  else
    echo ""
    echo "⛔ Server exited with code $EXIT_CODE — stopping."
    exit $EXIT_CODE
  fi
done
