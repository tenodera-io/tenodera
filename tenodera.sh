#!/usr/bin/env bash
# Tenodera Panel — installer (gateway + UI + local agent)
# Usage:
#   Install:   curl -sSfL https://raw.githubusercontent.com/tenodera-io/tenodera/main/tenodera.sh | sudo bash
#   Uninstall: sudo bash tenodera.sh --uninstall
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
  fail "This script must be run as root (use: sudo bash tenodera.sh)"
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

  # Remove UI assets, config, data, logs, PAM rules
  rm -rf /usr/share/tenodera
  rm -rf /etc/tenodera
  rm -rf /var/lib/tenodera-gw
  rm -rf /var/lib/tenodera
  rm -f /etc/logrotate.d/tenodera
  rm -f /etc/pam.d/tenodera
  rm -f /var/log/tenodera*

  ok "Tenodera fully removed (panel + agent)."
  exit 0
fi

# ── Install ───────────────────────────────────────────────

REPO="${TENODERA_REPO:-tenodera-io/tenodera}"
BRANCH="${TENODERA_BRANCH:-main}"
WORK_DIR="/tmp/tenodera-install"

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
EXTRACTED=$(ls -d "$WORK_DIR"/*enodera-* 2>/dev/null | head -1 || true)
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
GW_IP=$(hostname -I | awk '{print $1}')
# Every non-loopback IPv4 of the host, so the panel answers on whichever
# interface the operator browses to (a multi-homed host has several IPs).
SITE_ADDRS=$(hostname -I | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | grep -v '^127\.' | paste -sd, - | sed 's/,/, /g')
[ -n "$SITE_ADDRS" ] || SITE_ADDRS=":443"

# ── Reverse proxy (Caddy) — HTTPS on the network; gateway stays on loopback ───
# The gateway binds 127.0.0.1, so install Caddy (latest, from its official repo)
# to serve the panel over HTTPS to the network without exposing plain HTTP.

install_caddy() {
  command -v caddy >/dev/null 2>&1 && return 0
  info "Installing Caddy (latest) for the HTTPS reverse proxy..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg >/dev/null 2>&1 || true
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null || return 1
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      > /etc/apt/sources.list.d/caddy-stable.list 2>/dev/null || return 1
    apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq caddy >/dev/null 2>&1
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q 'dnf-command(copr)' >/dev/null 2>&1 || true
    dnf copr enable -y '@caddy/caddy' >/dev/null 2>&1 || return 1
    dnf install -y -q caddy >/dev/null 2>&1
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm --needed caddy >/dev/null 2>&1
  else
    return 1
  fi
  command -v caddy >/dev/null 2>&1
}

PANEL_URL="http://127.0.0.1:9090  (loopback only — reach via SSH tunnel or a reverse proxy)"
if install_caddy; then
  CADDYFILE=/etc/caddy/Caddyfile
  mkdir -p /etc/caddy
  if [ ! -f "$CADDYFILE" ] || grep -q 'generated by the Tenodera installer' "$CADDYFILE" 2>/dev/null; then
    cat > "$CADDYFILE" <<EOF
# Reverse proxy generated by the Tenodera installer.
# Serves the panel over HTTPS on the network; the gateway stays on 127.0.0.1.
#
# Default: Caddy's internal CA on this host's IP, so browsers warn about an
# untrusted certificate (expected on a LAN — click through). For a real domain
# and certificate, replace the block below, e.g.:
#
#   panel.example.com {
#       reverse_proxy 127.0.0.1:9090         # Let's Encrypt cert, automatic
#       # tls /etc/caddy/certs/panel.crt /etc/caddy/certs/panel.key  # or your own
#   }
#
# Then: sudo systemctl reload caddy .  See DOCS.md -> Reverse proxy.

${SITE_ADDRS} {
    tls internal
    reverse_proxy 127.0.0.1:9090
}
EOF
    ok "Wrote $CADDYFILE — panel served at https://${GW_IP}"
  else
    info "$CADDYFILE already customised — leaving it as-is"
  fi
  systemctl enable --now caddy >/dev/null 2>&1 || true
  systemctl reload caddy >/dev/null 2>&1 || systemctl restart caddy >/dev/null 2>&1 || true
  PANEL_URL="https://${GW_IP}   (Caddy — accept the self-signed cert warning on a LAN)"
else
  info "Could not auto-install Caddy on this distro — the panel stays on loopback."
fi

# ── Start local agent (connects to gateway, will enter pending on first boot) ─

if [ ! -f "${CONF_DIR}/agent.cnf" ]; then
  info "Writing local agent config..."
  cat > "${CONF_DIR}/agent.cnf" <<EOF
TENODERA_GATEWAY_URL=http://127.0.0.1:9090
# Local agent on the panel host — reaches the gateway directly on loopback; leave
# this as-is. (Remote agents instead use the panel's HTTPS address via Caddy, the
# bare host with NO :9090 — see tenodera-agent.sh / README.)
# TENODERA_AGENT_ACCEPT_INSECURE=1
EOF
  chmod 640 "${CONF_DIR}/agent.cnf"
fi

if systemctl is-active --quiet tenodera-agent 2>/dev/null; then
  info "tenodera-agent already running — restarting..."
  systemctl restart tenodera-agent
else
  info "Starting local tenodera-agent..."
  systemctl enable --now tenodera-agent
fi

echo ""
echo "  Panel:   ${PANEL_URL}"
echo "  Proxy:   /etc/caddy/Caddyfile  (edit for your domain/cert — see DOCS.md)"
echo "  Service: systemctl status tenodera"
echo "  Logs:    journalctl -u tenodera -f"
echo ""
echo "  Log in with any PAM user that has sudo privileges."
echo ""
echo "  This host's agent will appear under Hosts → Pending."
echo "  Approve it in the panel to bring it online."
echo ""
echo "  To add remote hosts (they connect to the panel through Caddy over HTTPS;"
echo "  --insecure accepts the default self-signed cert — drop it once you use a real cert):"
echo "  curl -sSfL https://raw.githubusercontent.com/tenodera-io/tenodera/main/tenodera-agent.sh | sudo bash -s -- --gateway https://${GW_IP} --insecure"
echo "  Then approve the host in the panel (Hosts → Pending)."
echo ""
echo "  For unattended installs, generate a bootstrap token in the panel (Hosts → Tokens)"
echo "  and pass it with --token to skip the approval step."
echo ""
