# Tenodera Bridge — Makefile
#
# Usage:
#   make build     — compile bridge binary
#   make install   — install binary + systemd service
#   make uninstall — remove binary and service
#   make clean     — remove build artifacts

PREFIX  ?= /usr/local
BINDIR  ?= $(PREFIX)/bin
CONFDIR ?= /etc/tenodera
SYSTEMDDIR ?= /etc/systemd/system

BRIDGE_BIN := target/release/tenodera-bridge

.PHONY: all deps build install uninstall clean package-deb package-rpm

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
	@echo "==> Installing tenodera-bridge to $(BINDIR) (setuid root)..."
	sudo install -m 4755 -o root -g root $(BRIDGE_BIN) $(BINDIR)/tenodera-bridge
	@echo "==> Setting up directories..."
	sudo mkdir -p $(CONFDIR)
	sudo chmod 755 $(CONFDIR)
	@echo "==> Setting up audit log..."
	sudo touch /var/log/tenodera_audit.log
	sudo chown root:root /var/log/tenodera_audit.log
	sudo chmod 622 /var/log/tenodera_audit.log
	@echo "==> Installing systemd service..."
	sudo cp systemd/tenodera-bridge.service $(SYSTEMDDIR)/
	sudo systemctl daemon-reload
	@echo ""
	@echo "Done. tenodera-bridge installed at $(BINDIR)/tenodera-bridge"
	@echo ""
	@echo "To start the bridge, configure /etc/tenodera/bridge.env and run:"
	@echo "  sudo systemctl enable --now tenodera-bridge"

# ── Uninstall ─────────────────────────────────────────────

uninstall:
	@echo "==> Removing tenodera-bridge..."
	-sudo systemctl stop tenodera-bridge 2>/dev/null || true
	-sudo systemctl disable tenodera-bridge 2>/dev/null || true
	-sudo rm -f $(SYSTEMDDIR)/tenodera-bridge.service
	-sudo systemctl daemon-reload
	-sudo rm -f $(BINDIR)/tenodera-bridge
	@echo "Done."

# ── Packages ──────────────────────────────────────────────

VERSION ?= $(shell . "$$HOME/.cargo/env" 2>/dev/null || true; cargo metadata --no-deps --format-version 1 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['packages'][0]['version'])" 2>/dev/null || echo "0.1.0")

package-deb: build
	@echo "==> Building Debian package (tenodera-bridge v$(VERSION))..."
	@command -v dpkg-deb >/dev/null 2>&1 || { echo "ERROR: dpkg-deb not found — install dpkg"; exit 1; }
	$(eval PKGDIR := /tmp/tenodera-bridge-deb-$(VERSION))
	@rm -rf $(PKGDIR) && mkdir -p $(PKGDIR)/DEBIAN $(PKGDIR)/usr/bin $(PKGDIR)/lib/systemd/system
	@install -m 4755 -o root -g root target/release/tenodera-bridge $(PKGDIR)/usr/bin/
	@install -m 644 systemd/tenodera-bridge.service $(PKGDIR)/lib/systemd/system/
	@printf 'Package: tenodera-bridge\nVersion: $(VERSION)\nArchitecture: amd64\nMaintainer: Tenodera <noreply@tenodera>\nDescription: Tenodera bridge agent for managed hosts\n Installed on managed Linux servers. Connects outbound to the Tenodera\n gateway — no inbound ports or SSH keys required.\n' > $(PKGDIR)/DEBIAN/control
	@dpkg-deb --build $(PKGDIR) tenodera-bridge_$(VERSION)_amd64.deb
	@rm -rf $(PKGDIR)
	@echo "✓ Package: tenodera-bridge_$(VERSION)_amd64.deb"

package-rpm: build
	@echo "==> Building RPM package (tenodera-bridge v$(VERSION))..."
	@command -v rpmbuild >/dev/null 2>&1 || { echo "ERROR: rpmbuild not found — install rpm-build"; exit 1; }
	@mkdir -p ~/rpmbuild/{BUILD,RPMS,SOURCES,SPECS,SRPMS}
	@cp ../packaging/tenodera-bridge.spec ~/rpmbuild/SPECS/
	@cp target/release/tenodera-bridge ~/rpmbuild/BUILD/
	@rpmbuild -bb --define "version $(VERSION)" --define "_topdir $$HOME/rpmbuild" ~/rpmbuild/SPECS/tenodera-bridge.spec
	@find ~/rpmbuild/RPMS -name "tenodera-bridge-*.rpm" -exec cp {} . \;
	@echo "✓ RPM package built"

# ── Clean ─────────────────────────────────────────────────

clean:
	cargo clean
