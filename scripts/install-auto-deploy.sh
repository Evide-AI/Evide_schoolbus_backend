#!/usr/bin/env bash
# One-time setup, run ON THE SERVER:  bash scripts/install-auto-deploy.sh
# Installs a systemd timer that runs scripts/deploy.sh one minute after boot
# and then every 2 minutes, so a push to the `production` branch goes live by
# itself. Remove it with:  sudo systemctl disable --now evide-auto-deploy.timer
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="${SUDO_USER:-$(id -un)}"

if ! id -nG "$RUN_USER" | tr ' ' '\n' | grep -qx docker; then
  echo "User $RUN_USER is not in the 'docker' group. Run:  sudo usermod -aG docker $RUN_USER"
  echo "then log out, log in again, and re-run this script."
  exit 1
fi
if [ ! -d "$APP_DIR/.git" ]; then
  echo "$APP_DIR is not a git clone. See DEPLOY-AUTOMATION.md, step 3."
  exit 1
fi

if ! git -C "$APP_DIR" ls-remote origin HEAD >/dev/null 2>&1; then
  echo "This server cannot read the GitHub repository yet."
  echo "Set up the deploy key first: DEPLOY-AUTOMATION.md, step 2."
  exit 1
fi

sudo tee /etc/systemd/system/evide-auto-deploy.service >/dev/null <<UNIT
[Unit]
Description=Install the latest School Bus backend from the production branch
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=oneshot
User=$RUN_USER
WorkingDirectory=$APP_DIR
ExecStart=/bin/bash $APP_DIR/scripts/deploy.sh
TimeoutStartSec=1200
UNIT

sudo tee /etc/systemd/system/evide-auto-deploy.timer >/dev/null <<UNIT
[Unit]
Description=Check for a new School Bus backend version

[Timer]
OnBootSec=60
OnUnitInactiveSec=120
AccuracySec=10

[Install]
WantedBy=timers.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now evide-auto-deploy.timer
echo
echo "Done. It checks the production branch every 2 minutes."
echo "See what it did:   journalctl -u evide-auto-deploy -n 50 --no-pager"
echo "Next run time:     systemctl list-timers evide-auto-deploy.timer"
