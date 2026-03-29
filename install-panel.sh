#!/usr/bin/env bash
# Tenodera Panel — installer (gateway + UI + local bridge)
# Usage:
#   Install:   curl -sSfL https://raw.githubusercontent.com/ultherego/Tenodera/main/install-panel.sh | sudo bash
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
echo ""
echo "  Panel:     https://$(hostname -I | awk '{print $1}'):9090"
echo "  Service:   systemctl status tenodera-gateway"
echo "  Logs:      journalctl -u tenodera-gateway -f"
echo "  Config:    /etc/tenodera/gateway.env"
echo ""
echo "  Log in with any PAM user that has sudo privileges."
echo ""
echo "  Install bridge on remote managed hosts:"
echo "  curl -sSfL https://raw.githubusercontent.com/ultherego/Tenodera/main/install-bridge.sh | sudo bash"
echo ""
