# Tenodera Agent — Makefile
#
# Usage:
#   make build     — compile agent binary
#   make install   — install binary + systemd service
#   make uninstall — remove binary and service
#   make clean     — remove build artifacts

PREFIX      ?= /usr/local
BINDIR      ?= $(PREFIX)/bin
CONFDIR     ?= /etc/tenodera
SYSTEMDDIR  ?= /etc/systemd/system
GATEWAY_URL ?= http://127.0.0.1:9090

AGENT_BIN := target/release/tenodera-agent

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
	@echo "==> Building tenodera-agent..."
	. "$$HOME/.cargo/env" 2>/dev/null || true; cargo build --release

$(AGENT_BIN):
	$(MAKE) build

# ── Install ───────────────────────────────────────────────

install: $(AGENT_BIN)
	@echo "==> Installing tenodera-agent to $(BINDIR)..."
	sudo install -m 0755 -o root -g root $(AGENT_BIN) $(BINDIR)/tenodera-agent
	@echo "==> Setting up directories..."
	sudo mkdir -p $(CONFDIR)
	sudo chmod 755 $(CONFDIR)
	@echo "==> Setting up audit log..."
	sudo touch /var/log/tenodera_audit.log
	sudo chown root:root /var/log/tenodera_audit.log
	sudo chmod 622 /var/log/tenodera_audit.log
	@echo "==> Installing systemd service..."
	sudo cp systemd/tenodera-agent.service $(SYSTEMDDIR)/
	sudo systemctl daemon-reload
	@if [ ! -f $(CONFDIR)/agent.cnf ]; then \
		printf 'TENODERA_GATEWAY_URL=$(GATEWAY_URL)\n# Uncomment if gateway uses a self-signed TLS cert:\n# TENODERA_AGENT_ACCEPT_INSECURE=1\n\n# Optional bootstrap token — skip pending-state approval on first connect.\n# Generate one in the panel under Hosts → Tokens.\n# TENODERA_BOOTSTRAP_TOKEN=<token>\n' \
			| sudo tee $(CONFDIR)/agent.cnf > /dev/null; \
		sudo chmod 640 $(CONFDIR)/agent.cnf; \
		echo "    Created $(CONFDIR)/agent.cnf ($(GATEWAY_URL))"; \
	else \
		echo "    $(CONFDIR)/agent.cnf already exists — skipping (preserving your config)"; \
	fi
	sudo systemctl enable --now tenodera-agent
	@echo ""
	@echo "✓ tenodera-agent installed and running"
	@echo "  Config:  $(CONFDIR)/agent.cnf"
	@echo "  Logs:    journalctl -u tenodera-agent -f"
	@echo "  Gateway: $(GATEWAY_URL)"
	@echo ""
	@echo "  The agent is connecting to $(GATEWAY_URL)."
	@echo "  On first connect it will enter the pending state — approve it in the panel under Hosts → Pending."
	@echo "  To skip approval, generate a bootstrap token in Hosts → Tokens and add it to agent.cnf."

# ── Uninstall ─────────────────────────────────────────────

uninstall:
	@echo "==> Removing tenodera-agent..."
	-sudo systemctl stop tenodera-agent 2>/dev/null || true
	-sudo systemctl disable tenodera-agent 2>/dev/null || true
	-sudo rm -f $(SYSTEMDDIR)/tenodera-agent.service
	-sudo systemctl daemon-reload
	-sudo rm -f $(BINDIR)/tenodera-agent
	-sudo rm -f $(CONFDIR)/agent.cnf
	-sudo rmdir $(CONFDIR) 2>/dev/null || true
	-sudo rm -rf /var/lib/tenodera
	-sudo rm -f /var/log/tenodera_audit.log
	@echo "Done."

# ── Packages ──────────────────────────────────────────────

VERSION ?= $(shell . "$$HOME/.cargo/env" 2>/dev/null || true; cargo metadata --no-deps --format-version 1 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['packages'][0]['version'])" 2>/dev/null || echo "0.1.0")

# Debian architecture of the build host (amd64 / arm64). Override for cross-builds.
DEB_ARCH ?= $(shell dpkg --print-architecture 2>/dev/null || echo amd64)

package-deb: build
	@echo "==> Building Debian package (tenodera-agent v$(VERSION), $(DEB_ARCH))..."
	@command -v dpkg-deb >/dev/null 2>&1 || { echo "ERROR: dpkg-deb not found — install dpkg"; exit 1; }
	$(eval PKGDIR := /tmp/tenodera-agent-deb-$(VERSION))
	@rm -rf $(PKGDIR) && mkdir -p $(PKGDIR)/DEBIAN $(PKGDIR)/usr/bin $(PKGDIR)/lib/systemd/system
	@install -m 0755 -o root -g root target/release/tenodera-agent $(PKGDIR)/usr/bin/
	@install -m 644 systemd/tenodera-agent.service $(PKGDIR)/lib/systemd/system/
	@printf 'Package: tenodera-agent\nVersion: $(VERSION)\nArchitecture: $(DEB_ARCH)\nDepends: libc6\nMaintainer: Tenodera <noreply@tenodera>\nDescription: Tenodera agent for managed hosts\n Installed on managed Linux servers. Connects outbound to the Tenodera\n gateway — no inbound ports or SSH keys required.\n' > $(PKGDIR)/DEBIAN/control
	@dpkg-deb --build $(PKGDIR) tenodera-agent_$(VERSION)_$(DEB_ARCH).deb
	@rm -rf $(PKGDIR)
	@echo "✓ Package: tenodera-agent_$(VERSION)_$(DEB_ARCH).deb"

package-rpm: build
	@echo "==> Building RPM package (tenodera-agent v$(VERSION))..."
	@command -v rpmbuild >/dev/null 2>&1 || { echo "ERROR: rpmbuild not found — install rpm-build"; exit 1; }
	@mkdir -p ~/rpmbuild/{BUILD,RPMS,SOURCES,SPECS,SRPMS}
	@cp ../packaging/tenodera-agent.spec ~/rpmbuild/SPECS/
	@cp target/release/tenodera-agent ~/rpmbuild/BUILD/
	@mkdir -p ~/rpmbuild/BUILD/agent/systemd
	@cp systemd/tenodera-agent.service ~/rpmbuild/BUILD/agent/systemd/
	@# RPM Version forbids '-'; map a pre-release tag (0.1.0-rc1) to 0.1.0~rc1
	@rpmbuild -bb --nodeps --define "version $(subst -,~,$(VERSION))" --define "_topdir $$HOME/rpmbuild" ~/rpmbuild/SPECS/tenodera-agent.spec
	@find ~/rpmbuild/RPMS -name "tenodera-agent-*.rpm" -exec cp {} . \;
	@echo "✓ RPM package built"

# ── Clean ─────────────────────────────────────────────────

clean:
	cargo clean
