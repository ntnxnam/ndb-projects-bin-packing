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
  # Prefer 0.0.0.0 so the server is reachable from other machines (Python 3.8+ has --bind)
  if python3 -m http.server --help 2>&1 | grep -q bind; then
    nohup python3 -m http.server "$PORT" --bind 0.0.0.0 --directory "$DIR" > "$LOG" 2>&1 &
  else
    cd "$DIR" && nohup python3 -m http.server "$PORT" > "$LOG" 2>&1 &
  fi
elif command -v npx >/dev/null 2>&1; then
  nohup npx -y serve "$DIR" -l "$PORT" > "$LOG" 2>&1 &
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
