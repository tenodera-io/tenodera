#!/usr/bin/env bash
# Tenodera Bridge — remote host installer
# Usage: curl -sSfL https://raw.githubusercontent.com/ultherego/Tenodera/main/install-bridge.sh | sudo bash
#
# What it does:
#   1. Installs build dependencies (Rust, system libs)
#   2. Downloads only bridge/ and protocol/ from the repo
#   3. Builds the bridge binary on this host
#   4. Installs to /usr/local/bin/tenodera-bridge
#   5. Cleans up build artifacts

set -euo pipefail

REPO="ultherego/Tenodera"
BRANCH="main"
INSTALL_DIR="/usr/local/bin"
WORK_DIR="/tmp/tenodera-bridge-install"

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
  fail "This script must be run as root (use: curl ... | sudo bash)"
fi

command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || \
  fail "curl or wget is required"

# ── Detect package manager ────────────────────────────────

detect_pm() {
  if command -v apt-get >/dev/null 2>&1; then
    echo "apt"
  elif command -v dnf >/dev/null 2>&1; then
    echo "dnf"
  elif command -v pacman >/dev/null 2>&1; then
    echo "pacman"
  else
    echo "unknown"
  fi
}

PM=$(detect_pm)

# ── Install system dependencies ───────────────────────────

info "Installing system build dependencies..."

case "$PM" in
  apt)
    apt-get update -qq
    apt-get install -y -qq build-essential pkg-config libssl-dev curl tar >/dev/null
    ;;
  dnf)
    dnf install -y -q gcc gcc-c++ make pkg-config openssl-devel curl tar >/dev/null
    ;;
  pacman)
    pacman -Sy --noconfirm --needed base-devel openssl curl tar >/dev/null
    ;;
  *)
    fail "Unsupported package manager. Install manually: gcc, make, pkg-config, libssl-dev, curl, tar"
    ;;
esac

# ── Install Rust (if not present) ─────────────────────────

if command -v rustc >/dev/null 2>&1; then
  info "Rust already installed: $(rustc --version)"
else
  info "Installing Rust toolchain..."
  curl -sSf https://sh.rustup.rs | sh -s -- -y --quiet
  # shellcheck source=/dev/null
  . "$HOME/.cargo/env"
fi

# Ensure cargo is on PATH
export PATH="$HOME/.cargo/bin:$PATH"

# ── Download source ───────────────────────────────────────

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
PROTOCOL_DIR="$EXTRACTED/protocol"

if [ ! -d "$BRIDGE_DIR" ] || [ ! -d "$PROTOCOL_DIR" ]; then
  fail "Source directories not found (bridge/ or protocol/)"
fi

# ── Build ─────────────────────────────────────────────────

info "Building tenodera-bridge (this may take a few minutes)..."

cd "$BRIDGE_DIR"
cargo build --release 2>&1

if [ ! -f "target/release/tenodera-bridge" ]; then
  fail "Build failed — binary not found"
fi

# ── Install ───────────────────────────────────────────────

info "Installing tenodera-bridge to ${INSTALL_DIR}..."

install -m 755 target/release/tenodera-bridge "${INSTALL_DIR}/tenodera-bridge"

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
