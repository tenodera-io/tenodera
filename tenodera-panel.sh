#!/usr/bin/env bash
# Tenodera Panel — installer (gateway + UI + local agent)
# Usage:
#   Install:   curl -sSfL https://raw.githubusercontent.com/ultherego/Tenodera/main/tenodera-panel.sh | sudo bash
#   Uninstall: sudo bash tenodera-panel.sh --uninstall
#
# Install:
#   1. Downloads panel/, protocol/, and agent/ source from GitHub
#   2. Runs `make all` for panel (installs deps, builds gateway + UI, installs)
#   3. Runs `make all` for agent (builds + installs local agent)
#   4. Cleans up build artifacts
#
# Uninstall:
#   Runs `make uninstall` for both panel and agent

set -euo pipefail

INSTALL_DIR="/usr/local/bin"

# ── Colors ─────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}==>${NC} $*"; }
ok()    { echo -e "${GREEN}✓${NC}  $*"; }
fail()  { echo -e "${RED}ERROR:${NC} $*" >&2; exit 1; }
step()  { echo -e "\n${BLUE}[$1]${NC} $2"; }

# Strip per-crate cargo progress lines; warnings, errors, and "Finished" pass through.
cargo_quiet() {
  grep -Ev \
    "^   (Compiling|Fresh|Checking|Blocking|Running) |\
^    (Updating|Downloaded?) |\
^     Locking |\
^      Adding "
}

# ── Preflight checks ──────────────────────────────────────

if [ "$(id -u)" -ne 0 ]; then
  fail "This script must be run as root (use: sudo bash tenodera-panel.sh)"
fi

# ── Uninstall ─────────────────────────────────────────────

if [ "${1:-}" = "--uninstall" ]; then
  info "Uninstalling Tenodera (panel + agent)..."

  # Stop and remove services
  systemctl stop tenodera 2>/dev/null || true
  systemctl disable tenodera 2>/dev/null || true
  rm -f /etc/systemd/system/tenodera.service
  rm -rf /etc/systemd/system/tenodera.service.d
  systemctl stop tenodera-agent 2>/dev/null || true
  systemctl disable tenodera-agent 2>/dev/null || true
  rm -f /etc/systemd/system/tenodera-agent.service
  systemctl daemon-reload

  # Kill any running processes
  pkill -f tenodera-gateway 2>/dev/null || true
  pkill -f tenodera-agent 2>/dev/null || true

  # Remove all binaries (gateway + pam helper + agent)
  rm -f "${INSTALL_DIR}/tenodera-gateway"
  rm -f "${INSTALL_DIR}/tenodera-pam-helper"
  rm -f "${INSTALL_DIR}/tenodera-agent"

  # Remove UI assets, config, logs, PAM and sudoers rules
  rm -rf /usr/share/tenodera
  rm -rf /etc/tenodera
  rm -f /etc/logrotate.d/tenodera
  rm -f /etc/pam.d/tenodera
  rm -f /var/log/tenodera*

  ok "Tenodera fully removed (panel + agent)."
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
AGENT_DIR="$EXTRACTED/agent"

if [ ! -d "$PANEL_DIR" ] || [ ! -d "$AGENT_DIR" ] || [ ! -d "$EXTRACTED/protocol" ]; then
  fail "Source directories not found (panel/, agent/, or protocol/)"
fi

# ── Build & Install Panel ─────────────────────────────────

step "1/2" "Building Tenodera Panel"
echo "       system deps  →  Rust backend (~2-4 min)  →  frontend (~30 sec)  →  install"

cd "$PANEL_DIR"
make all 2>&1 | cargo_quiet

# ── Build & Install Agent ─────────────────────────────────

step "2/2" "Building local agent"
echo "       system deps  →  Rust agent (~2-4 min)  →  install"

cd "$AGENT_DIR"
make all 2>&1 | cargo_quiet

# ── Verify ────────────────────────────────────────────────

ERRORS=0

for BIN in tenodera-gateway tenodera-pam-helper tenodera-agent; do
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

CONF_DIR="/etc/tenodera"

# ── Configure and start local agent ──────────────────────────────────────────
# The agent connects to the local gateway over plain HTTP and auto-registers.
# To enable HTTPS: generate a cert (cd panel && sudo make tls-selfsigned),
# then update /etc/tenodera/tenodera.cnf and /etc/tenodera/agent.cnf.

if [ ! -f "${CONF_DIR}/agent.cnf" ]; then
  info "Writing agent config..."
  cat > "${CONF_DIR}/agent.cnf" <<EOF
TENODERA_GATEWAY_URL=http://127.0.0.1:9090
# Uncomment if you switch gateway to HTTPS with a self-signed cert:
# TENODERA_AGENT_ACCEPT_INSECURE=1
EOF
  chmod 640 "${CONF_DIR}/agent.cnf"
fi

if systemctl is-active --quiet tenodera-agent 2>/dev/null; then
  info "tenodera-agent already running — restarting to pick up new config"
  systemctl restart tenodera-agent
else
  info "Starting tenodera-agent on this host..."
  systemctl enable --now tenodera-agent
fi

echo ""
echo "  Panel:     http://$(hostname -I | awk '{print $1}'):9090"
echo "  Service:   systemctl status tenodera"
echo "  Logs:      journalctl -u tenodera -f"
echo "  Config:    /etc/tenodera/tenodera.cnf"
echo ""
echo "  Log in with any PAM user that has sudo privileges."
echo "  This host will appear in the UI as soon as the agent connects (a few seconds)."
echo ""
echo "  Install agent on remote managed hosts:"
echo "  curl -sSfL https://raw.githubusercontent.com/ultherego/Tenodera/main/tenodera-agent.sh | sudo bash -s -- --gateway http://HOST:9090"
echo ""
