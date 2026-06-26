#!/usr/bin/env bash
# Tenodera Panel — installer (gateway + UI + local bridge)
# Usage:
#   Install:   curl -sSfL https://raw.githubusercontent.com/ultherego/Tenodera/main/install-panel.sh -o /tmp/install-panel.sh && sudo bash /tmp/install-panel.sh
#   Uninstall: sudo bash install-panel.sh --uninstall
#
# Install:
#   1. Downloads panel/, protocol/, and bridge/ source from GitHub
#   2. Runs `make all` for panel (installs deps, builds gateway + UI, installs)
#   3. Runs `make all` for bridge (builds + installs local bridge)
#   4. Cleans up build artifacts
#
# Uninstall:
#   Runs `make uninstall` for both panel and bridge

set -euo pipefail

INSTALL_DIR="/usr/local/bin"

# ── Colors ─────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}==>${NC} $*"; }
ok()    { echo -e "${GREEN}==>${NC} $*"; }
fail()  { echo -e "${RED}ERROR:${NC} $*" >&2; exit 1; }

# ── Preflight checks ──────────────────────────────────────

if [ "$(id -u)" -ne 0 ]; then
  fail "This script must be run as root (use: sudo bash install-panel.sh)"
fi

# ── Uninstall ─────────────────────────────────────────────

if [ "${1:-}" = "--uninstall" ]; then
  info "Uninstalling Tenodera (panel + bridge)..."

  # Stop and remove services
  systemctl stop tenodera-gateway 2>/dev/null || true
  systemctl disable tenodera-gateway 2>/dev/null || true
  rm -f /etc/systemd/system/tenodera-gateway.service
  rm -rf /etc/systemd/system/tenodera-gateway.service.d
  systemctl daemon-reload

  # Kill any running processes
  pkill -f tenodera-gateway 2>/dev/null || true
  pkill -f tenodera-bridge 2>/dev/null || true

  # Remove all binaries (gateway + pam helper + bridge)
  rm -f "${INSTALL_DIR}/tenodera-gateway"
  rm -f "${INSTALL_DIR}/tenodera-pam-helper"
  rm -f "${INSTALL_DIR}/tenodera-bridge"

  # Remove UI assets, config, logs
  rm -rf /usr/share/tenodera
  rm -rf /etc/tenodera
  rm -f /etc/logrotate.d/tenodera
  rm -f /var/log/tenodera*

  ok "Tenodera fully removed (panel + bridge)."
  exit 0
fi

# ── Install ───────────────────────────────────────────────

REPO="ultherego/Tenodera"
BRANCH="main"
WORK_DIR="/tmp/tenodera-panel-install"

command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || \
  fail "curl or wget is required"

# make is needed for the Makefiles
command -v make >/dev/null 2>&1 || {
  info "Installing make..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq && apt-get install -y -qq make >/dev/null
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q make >/dev/null
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm --needed make >/dev/null
  else
    fail "Install 'make' manually before running this script"
  fi
}

info "Downloading Tenodera source..."

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"

TARBALL_URL="https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz"

if command -v curl >/dev/null 2>&1; then
  curl -sSfL "$TARBALL_URL" | tar xz -C "$WORK_DIR"
elif command -v wget >/dev/null 2>&1; then
  wget -qO- "$TARBALL_URL" | tar xz -C "$WORK_DIR"
fi

# GitHub tarballs extract as REPO-BRANCH/
EXTRACTED=$(ls -d "$WORK_DIR"/Tenodera-* 2>/dev/null | head -1)
if [ -z "$EXTRACTED" ]; then
  fail "Failed to extract source archive"
fi

PANEL_DIR="$EXTRACTED/panel"
BRIDGE_DIR="$EXTRACTED/bridge"

if [ ! -d "$PANEL_DIR" ] || [ ! -d "$BRIDGE_DIR" ] || [ ! -d "$EXTRACTED/protocol" ]; then
  fail "Source directories not found (panel/, bridge/, or protocol/)"
fi

# ── Build & Install Panel ─────────────────────────────────

info "Building and installing Tenodera Panel (this may take several minutes)..."

cd "$PANEL_DIR"
make all 2>&1

# ── Build & Install Bridge ────────────────────────────────

info "Building and installing local bridge..."

cd "$BRIDGE_DIR"
make all 2>&1

# ── Verify ────────────────────────────────────────────────

ERRORS=0

for BIN in tenodera-gateway tenodera-pam-helper tenodera-bridge; do
  if [ -f "${INSTALL_DIR}/${BIN}" ]; then
    ok "${BIN} installed at ${INSTALL_DIR}/${BIN}"
  else
    echo -e "${RED}ERROR:${NC} ${BIN} not found" >&2
    ERRORS=$((ERRORS + 1))
  fi
done

if [ "$ERRORS" -gt 0 ]; then
  fail "Installation completed with errors"
fi

# ── Cleanup ───────────────────────────────────────────────

info "Cleaning up build artifacts..."
rm -rf "$WORK_DIR"

ok "Tenodera installed successfully!"

# ── Register local host automatically ────────────────────────────────────────
# So the panel host is immediately visible in the UI without manual steps.

CONF_DIR="/etc/tenodera"
HOSTS_JSON="${CONF_DIR}/hosts.json"

if python3 -c "import json,sys; d=json.load(open('${HOSTS_JSON}')); sys.exit(0 if any(h.get('is_local') for h in d.get('hosts',[])) else 1)" 2>/dev/null; then
  info "Local host already registered in ${HOSTS_JSON}"
else
  info "Registering this host as local panel host..."

  LOCAL_ID=$(python3 -c "import uuid; print(uuid.uuid4())" 2>/dev/null || uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)
  LOCAL_TOKEN=$(python3 -c "import uuid; print(uuid.uuid4())" 2>/dev/null || uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)
  LOCAL_NAME=$(hostname -s 2>/dev/null || echo "panel-host")
  LOCAL_TS=$(date -u +"%Y-%m-%dT%H:%M:%S+00:00")

  # Add entry to hosts.json (create if missing)
  if [ ! -f "$HOSTS_JSON" ]; then
    echo '{"hosts":[]}' > "$HOSTS_JSON"
  fi

  python3 - <<PYEOF
import json, datetime
with open('${HOSTS_JSON}') as f:
    d = json.load(f)
d['hosts'].insert(0, {
    'id': '${LOCAL_ID}',
    'name': '${LOCAL_NAME}',
    'token': '${LOCAL_TOKEN}',
    'added_at': '${LOCAL_TS}',
    'is_local': True
})
with open('${HOSTS_JSON}', 'w') as f:
    json.dump(d, f, indent=2)
PYEOF

  # Configure bridge to connect to local gateway
  cat > "${CONF_DIR}/bridge.env" <<EOF
TENODERA_GATEWAY_URL=http://127.0.0.1:9090
TENODERA_BRIDGE_TOKEN=${LOCAL_TOKEN}
EOF
  chmod 640 "${CONF_DIR}/bridge.env"

  ok "Local host registered (id=${LOCAL_ID})"
fi

# Start bridge on this host if not already running
if systemctl is-active --quiet tenodera-bridge 2>/dev/null; then
  info "tenodera-bridge already running — restarting to pick up new config"
  systemctl restart tenodera-bridge
else
  info "Starting tenodera-bridge on this host..."
  systemctl enable --now tenodera-bridge
fi

echo ""
echo "  Panel:     https://$(hostname -I | awk '{print $1}'):9090"
echo "  Service:   systemctl status tenodera-gateway"
echo "  Logs:      journalctl -u tenodera-gateway -f"
echo "  Config:    /etc/tenodera/gateway.env"
echo ""
echo "  Log in with any PAM user that has sudo privileges."
echo "  This host is pre-registered — you'll see it immediately in the UI."
echo ""
echo "  Install bridge on remote managed hosts:"
echo "  curl -sSfL https://raw.githubusercontent.com/ultherego/Tenodera/main/install-bridge.sh | sudo bash -s -- --gateway https://HOST:9090 --token TOKEN"
echo ""
