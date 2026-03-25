# Tenodera Bridge — Makefile
# Standalone build for tenodera-bridge binary.
# Install this on every managed host (no daemon, no open ports).
#
# Usage:
#   make build     — compile bridge binary
#   make install   — install binary to /usr/local/bin
#   make uninstall — remove binary
#   make clean     — remove build artifacts

PREFIX  ?= /usr/local
BINDIR  ?= $(PREFIX)/bin

BRIDGE_BIN := target/release/tenodera-bridge

.PHONY: all deps build install uninstall clean

all: deps build install

# ── Dependencies ──────────────────────────────────────────

deps:
	@echo "==> Installing build dependencies..."
	@if command -v apt-get >/dev/null 2>&1; then \
		sudo apt-get update && sudo apt-get install -y build-essential pkg-config curl; \
	elif command -v dnf >/dev/null 2>&1; then \
		sudo dnf install -y gcc make pkg-config curl; \
	elif command -v pacman >/dev/null 2>&1; then \
		sudo pacman -Sy --needed --noconfirm base-devel pkg-config curl; \
	else \
		echo "ERROR: Unsupported package manager. Install manually: gcc, make, pkg-config, curl"; \
		exit 1; \
	fi
	@if ! command -v cargo >/dev/null 2>&1; then \
		echo "==> Installing Rust..."; \
		curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y; \
	else \
		echo "==> Rust already installed: $$(rustc --version)"; \
	fi

# ── Build ─────────────────────────────────────────────────

build:
	@echo "==> Building tenodera-bridge..."
	. "$$HOME/.cargo/env" 2>/dev/null || true; cargo build --release

$(BRIDGE_BIN):
	$(MAKE) build

# ── Install ───────────────────────────────────────────────

install: $(BRIDGE_BIN)
	@echo "==> Installing tenodera-bridge to $(BINDIR)..."
	sudo install -m 755 $(BRIDGE_BIN) $(BINDIR)/tenodera-bridge
	@echo ""
	@echo "Done. tenodera-bridge installed at $(BINDIR)/tenodera-bridge"
	@echo "No daemon or service needed — gateway spawns bridge via SSH."

# ── Uninstall ─────────────────────────────────────────────

uninstall:
	@echo "==> Removing tenodera-bridge..."
	-sudo rm -f $(BINDIR)/tenodera-bridge
	@echo "Done."

# ── Clean ─────────────────────────────────────────────────

clean:
	cargo clean
