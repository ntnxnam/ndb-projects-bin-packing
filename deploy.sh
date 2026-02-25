#!/bin/bash
# Run this from the repo root. It does everything: ensure server dir, zip, upload, backup, unzip, start on port 3847.
# Uses SSH connection multiplexing so you only enter your password once.
set -e
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT"
DATE=$(date +%Y%m%d)
ZIP_NAME="ndb-projects-bin-packing-${DATE}.zip"
# Deploy to the host that serves http://ndb-qa.dev.nutanix.com (change if that URL points elsewhere)
REMOTE_USER="${DEPLOY_USER:-santhosh.s}"
REMOTE_HOST="${DEPLOY_HOST:-ndb-qa.dev.nutanix.com}"
REMOTE="$REMOTE_USER@$REMOTE_HOST"
# Prefer /var/www/html (needs: sudo mkdir -p ... && sudo chown $USER ...); fallback to home if no permission
REMOTE_DIR_WWW="/var/www/html/ndb-projects-bin-packing"
REMOTE_DIR_HOME="/home/$REMOTE_USER/ndb-projects-bin-packing"
SSH_SOCKET="/tmp/ndb-deploy-$$"

# Reuse one SSH connection so we only get one password prompt
SSH_OPTS=(-o "ControlMaster=auto" -o "ControlPath=$SSH_SOCKET" -o "ControlPersist=60")
cleanup() { ssh -O exit -o "ControlPath=$SSH_SOCKET" "$REMOTE" 2>/dev/null || true; rm -f "$SSH_SOCKET"; }
trap cleanup EXIT

echo "=== Opening SSH connection (enter password once) ==="
ssh "${SSH_OPTS[@]}" -f -N "$REMOTE"

echo "=== Ensuring deploy directory exists on server ==="
if ssh "${SSH_OPTS[@]}" "$REMOTE" "mkdir -p $REMOTE_DIR_WWW" 2>/dev/null; then
  REMOTE_DIR="$REMOTE_DIR_WWW"
else
  echo ">>> $REMOTE_DIR_WWW not writable (Permission denied), using $REMOTE_DIR_HOME"
  ssh "${SSH_OPTS[@]}" "$REMOTE" "mkdir -p $REMOTE_DIR_HOME"
  REMOTE_DIR="$REMOTE_DIR_HOME"
fi

echo "=== Creating $ZIP_NAME (excluding .git and zips) ==="
zip -r "$ZIP_NAME" . -x "*.git*" -x "*.zip"

echo "=== Uploading to $REMOTE:$REMOTE_DIR/ ==="
scp -o "ControlPath=$SSH_SOCKET" "$ZIP_NAME" "$REMOTE:$REMOTE_DIR/"

echo "=== On server: backup, unzip, start (port 3847) ==="
ssh "${SSH_OPTS[@]}" "$REMOTE" "cd $REMOTE_DIR && \
  mv $ZIP_NAME ../ 2>/dev/null || true && \
  mkdir -p ../ndb-projects-bin-packing_old_$DATE && \
  mv * ../ndb-projects-bin-packing_old_$DATE/ 2>/dev/null || true && \
  mv ../$ZIP_NAME . 2>/dev/null || true && \
  unzip -o $ZIP_NAME -d . && \
  sh manage-production.sh"

echo "=== Waiting for server to bind to port 3847 ==="
sleep 3

echo "=== Check on server: is app listening? ==="
ssh "${SSH_OPTS[@]}" "$REMOTE" "echo '--- lsof :3847 ---'; lsof -i :3847 2>/dev/null || echo 'nothing on 3847'; echo '--- curl localhost:3847 ---'; curl -s -o /dev/null -w 'HTTP %{http_code}\n' http://localhost:3847/ 2>/dev/null || echo 'curl failed'; echo '--- last log lines ---'; tail -12 /tmp/ndb-projects-bin-packing.log 2>/dev/null || echo 'no log'"

echo "=== Check from your machine: is port 3847 reachable? ==="
if nc -zv -w 5 "$REMOTE_HOST" 3847 2>&1; then
  echo ""
  echo ">>> Port 3847 is open. Open http://ndb-qa.dev.nutanix.com:3847 in your browser."
else
  echo ""
  echo ">>> Port 3847 not reachable from here (firewall may block it). If the server check above shows HTTP 200, the app is running; ask IT to open port 3847 to $REMOTE_HOST."
fi

echo ""
echo "=== Done. App URL: http://ndb-qa.dev.nutanix.com:3847 ==="
