#!/bin/bash
# Run on server from app root. Serves the app on port 3847 (bind 0.0.0.0 so it's reachable from browser).
set -e
PORT=3847
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
LOG=/tmp/ndb-projects-bin-packing.log

# Free port if something is already bound (e.g. previous run)
free_port() {
  local pids
  # Prefer fuser -k (Linux): one-shot kill of whatever is on the port
  if command -v fuser >/dev/null 2>&1; then
    if fuser "$PORT/tcp" 2>/dev/null; then
      echo "Stopping existing process(es) on port $PORT (fuser -k)"
      fuser -k "$PORT/tcp" 2>/dev/null || true
      sleep 2
    fi
  fi
  # Fallback / extra: lsof to find and kill by PID
  if command -v lsof >/dev/null 2>&1; then
    pids=$(lsof -ti ":$PORT" 2>/dev/null) || true
    if [ -n "$pids" ]; then
      echo "Stopping existing process(es) on port $PORT (PID(s) $pids)"
      for pid in $pids; do kill $pid 2>/dev/null || true; done
      sleep 2
      pids=$(lsof -ti ":$PORT" 2>/dev/null) || true
      if [ -n "$pids" ]; then
        echo "Force-killing process(es) still on port $PORT"
        for pid in $pids; do kill -9 $pid 2>/dev/null || true; done
        sleep 1
      fi
    fi
  fi
  # Ensure port is free before we start
  if command -v lsof >/dev/null 2>&1; then
    pids=$(lsof -ti ":$PORT" 2>/dev/null) || true
    [ -z "$pids" ] || { echo "Port $PORT still in use (PIDs: $pids). Aborting."; exit 1; }
  fi
}
free_port

echo "Starting NDB projects bin-packing on 0.0.0.0:$PORT"
if command -v python3 >/dev/null 2>&1; then
  nohup python3 -c "
import os, sys
from http.server import HTTPServer, SimpleHTTPRequestHandler

class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

os.chdir('$DIR')
HTTPServer(('0.0.0.0', $PORT), NoCacheHandler).serve_forever()
" > "$LOG" 2>&1 &
elif command -v npx >/dev/null 2>&1; then
  nohup npx -y serve "$DIR" -l "$PORT" --no-clipboard -c '\"headers\": [{\"source\": \"**\", \"headers\": [{\"key\": \"Cache-Control\", \"value\": \"no-cache, no-store, must-revalidate\"}]}]' > "$LOG" 2>&1 &
else
  echo "Need python3 or npx (Node) to serve. Install one and re-run."
  exit 1
fi

sleep 2
if command -v lsof >/dev/null 2>&1; then
  if lsof -ti ":$PORT" >/dev/null 2>&1; then
    echo "Server is listening on port $PORT. App: http://ndb-qa.dev.nutanix.com:$PORT"
  else
    echo "Server may have failed to start. Check: $LOG"
    tail -20 "$LOG" 2>/dev/null || true
  fi
fi
