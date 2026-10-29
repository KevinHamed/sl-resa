#!/usr/bin/env bash
# Serve the app on your local network so your iPhone (same Wi-Fi) can open it.
# Needs timetable files in data/: unzip SL's GTFS feed into gtfs/ and run
#   node tools/build-data.mjs gtfs data
set -euo pipefail
cd "$(dirname "$0")"
[ -f data/index.json ] || echo "Warning: no data/ yet, searches will fail (see comment in serve.sh)."
PORT="${PORT:-8080}"
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo "Open on your iPhone:  http://${IP:-<this-computer-ip>}:${PORT}"
echo "Then Share → Add to Home Screen. Ctrl+C to stop."
exec python3 -m http.server "$PORT" --bind 0.0.0.0
