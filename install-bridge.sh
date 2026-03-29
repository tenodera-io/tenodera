#!/usr/bin/env bash
# Tenodera Bridge — remote host installer
# Usage:
#   Install:   curl -sSfL https://raw.githubusercontent.com/ultherego/Tenodera/main/install-bridge.sh | sudo bash
#   Uninstall: sudo bash install-bridge.sh --uninstall
#
# Install:
#   1. Downloads bridge/ and protocol/ source from GitHub
#   2. Runs `make all` (installs deps, builds, installs)
#   3. Cleans up build artifacts
#
# Uninstall:
#   Removes /usr/local/bin/tenodera-bridge

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
  fail "This script must be run as root (use: sudo bash install-bridge.sh)"
fi

# ── Uninstall ─────────────────────────────────────────────

if [ "${1:-}" = "--uninstall" ]; then
  info "Removing tenodera-bridge..."
  rm -f "${INSTALL_DIR}/tenodera-bridge"
  if [ ! -f "${INSTALL_DIR}/tenodera-bridge" ]; then
    ok "tenodera-bridge removed successfully."
  else
    fail "Failed to remove tenodera-bridge"
  fi
  exit 0
fi

# ── Install ───────────────────────────────────────────────

REPO="ultherego/Tenodera"
BRANCH="main"
WORK_DIR="/tmp/tenodera-bridge-install"

command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || \
  fail "curl or wget is required"

info "Downloading bridge and protocol source..."

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

BRIDGE_DIR="$EXTRACTED/bridge"

if [ ! -d "$BRIDGE_DIR" ] || [ ! -d "$EXTRACTED/protocol" ]; then
  fail "Source directories not found (bridge/ or protocol/)"
fi

# ── Build & Install via Makefile ──────────────────────────

info "Building and installing tenodera-bridge (this may take a few minutes)..."

cd "$BRIDGE_DIR"
make all 2>&1

# ── Verify ────────────────────────────────────────────────

if command -v tenodera-bridge >/dev/null 2>&1; then
  ok "tenodera-bridge installed successfully at ${INSTALL_DIR}/tenodera-bridge"
else
  fail "Installation failed — binary not found in PATH"
fi

# ── Cleanup ───────────────────────────────────────────────

info "Cleaning up build artifacts..."
rm -rf "$WORK_DIR"

ok "Done! The gateway can now connect to this host via SSH."
echo ""
echo "  No daemon or service needed."
echo "  The gateway spawns tenodera-bridge automatically over SSH."
echo ""
