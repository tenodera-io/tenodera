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
	@echo "==> Setting up audit log..."
	sudo touch /var/log/tenodera_audit.log
	sudo chown root:root /var/log/tenodera_audit.log
	sudo chmod 622 /var/log/tenodera_audit.log
	@echo ""
	@echo "Done. tenodera-bridge installed at $(BINDIR)/tenodera-bridge"
	@echo "No daemon or service needed — gateway spawns bridge via SSH."

# ── Uninstall ─────────────────────────────────────────────

uninstall:
	@echo "==> Removing tenodera-bridge..."
	-sudo rm -f $(BINDIR)/tenodera-bridge
	@echo "Done."

# ── Packages ──────────────────────────────────────────────

VERSION ?= $(shell . "$$HOME/.cargo/env" 2>/dev/null || true; cargo metadata --no-deps --format-version 1 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['packages'][0]['version'])" 2>/dev/null || echo "0.1.0")

package-deb: build
	@echo "==> Building Debian package (tenodera-bridge v$(VERSION))..."
	@command -v dpkg-deb >/dev/null 2>&1 || { echo "ERROR: dpkg-deb not found — install dpkg"; exit 1; }
	$(eval PKGDIR := /tmp/tenodera-bridge-deb-$(VERSION))
	@rm -rf $(PKGDIR) && mkdir -p $(PKGDIR)/DEBIAN $(PKGDIR)/usr/bin
	@install -m 4755 -o root -g root target/release/tenodera-bridge $(PKGDIR)/usr/bin/
	@printf 'Package: tenodera-bridge\nVersion: $(VERSION)\nArchitecture: amd64\nMaintainer: Tenodera <noreply@tenodera>\nDescription: Tenodera bridge agent for managed hosts\n Installed on managed Linux servers. The Tenodera gateway connects\n to it via SSH to perform system administration tasks.\n' > $(PKGDIR)/DEBIAN/control
	@dpkg-deb --build $(PKGDIR) tenodera-bridge_$(VERSION)_amd64.deb
	@rm -rf $(PKGDIR)
	@echo "✓ Package: tenodera-bridge_$(VERSION)_amd64.deb"

package-rpm: build
	@echo "==> Building RPM package (tenodera-bridge v$(VERSION))..."
	@command -v rpmbuild >/dev/null 2>&1 || { echo "ERROR: rpmbuild not found — install rpm-build"; exit 1; }
	@mkdir -p ~/rpmbuild/{BUILD,RPMS,SOURCES,SPECS,SRPMS}
	@cp ../packaging/tenodera-bridge.spec ~/rpmbuild/SPECS/
	@cp target/release/tenodera-bridge ~/rpmbuild/BUILD/
	@cp -r . ~/rpmbuild/BUILD/bridge
	@rpmbuild -bb --define "version $(VERSION)" --define "_topdir $$HOME/rpmbuild" ~/rpmbuild/SPECS/tenodera-bridge.spec
	@find ~/rpmbuild/RPMS -name "tenodera-bridge-*.rpm" -exec cp {} . \;
	@echo "✓ RPM package built"

# ── Clean ─────────────────────────────────────────────────

clean:
	cargo clean
