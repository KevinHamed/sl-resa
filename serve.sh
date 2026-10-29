#!/usr/bin/env bash
# Serve the app on your local network so your iPhone (same Wi-Fi) can open it.
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8080}"
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo "Open on your iPhone:  http://${IP:-<this-computer-ip>}:${PORT}"
echo "Then Share → Add to Home Screen. Ctrl+C to stop."
exec python3 -m http.server "$PORT" --bind 0.0.0.0
