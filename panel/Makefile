# Tenodera Panel — Makefile
# Builds and installs the gateway + UI only.
# Bridge is a separate project — see ../bridge/
#
# Usage:
#   sudo apt-get install make  (Debian) / sudo dnf install make (Fedora) / already included (Arch)
#   make all       — deps + build + install (full setup)
#   make deps      — install build dependencies (Rust + Node.js + system libs)
#   make build     — compile backend + frontend
#   make install   — install binaries, UI, systemd services
#   make uninstall — remove binaries, services, config, UI, logs
#   make clean     — remove build artifacts

PREFIX      ?= /usr/local
BINDIR      ?= $(PREFIX)/bin
UIDIR       ?= /usr/share/tenodera/ui
CONFDIR     ?= /etc/tenodera
SYSTEMDDIR  ?= /etc/systemd/system

GATEWAY_BIN    := target/release/tenodera-gateway
PAM_HELPER_BIN := target/release/tenodera-pam-helper

.PHONY: all deps deps-rust deps-node deps-system build build-backend build-frontend install uninstall clean tls-selfsigned package-deb package-rpm

all: deps build install

# ── Dependencies ──────────────────────────────────────────

deps: deps-system deps-rust deps-node

deps-system:
	@echo "==> Installing system build dependencies..."
	@if command -v apt-get >/dev/null 2>&1; then \
		sudo apt-get update && sudo apt-get install -y build-essential pkg-config libssl-dev libpam0g-dev libclang-dev curl jq; \
	elif command -v dnf >/dev/null 2>&1; then \
		sudo dnf install -y gcc make pkg-config openssl-devel pam-devel clang-devel curl jq; \
	elif command -v pacman >/dev/null 2>&1; then \
		sudo pacman -Sy --needed --noconfirm base-devel openssl pam clang pkg-config curl jq; \
	else \
		echo "ERROR: Unsupported package manager. Install manually: gcc, make, pkg-config, openssl-dev, pam-dev, curl"; \
		exit 1; \
	fi

deps-rust:
	@if ! command -v cargo >/dev/null 2>&1; then \
		echo "==> Installing Rust..."; \
		curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y; \
	else \
		echo "==> Rust already installed: $$(rustc --version)"; \
	fi

deps-node:
	@if ! command -v node >/dev/null 2>&1; then \
		echo "==> Installing Node.js..."; \
		if command -v apt-get >/dev/null 2>&1; then \
			curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && \
			sudo apt-get install -y nodejs; \
		elif command -v dnf >/dev/null 2>&1; then \
			curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo -E bash - && \
			sudo dnf install -y nodejs; \
		elif command -v pacman >/dev/null 2>&1; then \
			sudo pacman -Sy --needed --noconfirm nodejs npm; \
		else \
			echo "ERROR: Install Node.js >= 18 manually"; \
			exit 1; \
		fi; \
	else \
		echo "==> Node.js already installed: $$(node --version)"; \
	fi

# ── Build ─────────────────────────────────────────────────

build: build-backend build-frontend

build-backend:
	@echo "==> Building backend (gateway + pam-helper)..."
	. "$$HOME/.cargo/env" 2>/dev/null || true; cargo build --release

build-frontend:
	@echo "==> Building frontend..."
	cd ui && npm ci && npm run build

# ── Install ───────────────────────────────────────────────

install: $(GATEWAY_BIN) $(PAM_HELPER_BIN) ui/dist/index.html
	@echo "==> Creating tenodera-gw service account..."
	@if ! id -u tenodera-gw >/dev/null 2>&1; then \
		sudo useradd -r -s /sbin/nologin -M -d /nonexistent -c "Tenodera Gateway" tenodera-gw; \
		echo "    Created user tenodera-gw"; \
	else \
		echo "    User tenodera-gw already exists — skipping"; \
	fi
	@echo "==> Installing gateway binary..."
	sudo install -m 755 -o root -g tenodera-gw $(GATEWAY_BIN) $(BINDIR)/tenodera-gateway
	@echo "==> Installing PAM helper (setuid root, group tenodera-gw)..."
	sudo install -m 4750 -o root -g tenodera-gw $(PAM_HELPER_BIN) $(BINDIR)/tenodera-pam-helper
	@echo "==> Installing UI..."
	sudo mkdir -p $(UIDIR)
	sudo cp -r ui/dist/* $(UIDIR)/
	@echo "==> Setting up directories..."
	sudo mkdir -p $(CONFDIR)/tls
	sudo chown root:tenodera-gw $(CONFDIR)
	sudo chmod 750 $(CONFDIR)
	sudo chown root:tenodera-gw $(CONFDIR)/tls
	sudo chmod 750 $(CONFDIR)/tls
	@if [ ! -f $(CONFDIR)/hosts.json ]; then \
		echo '{"hosts":[]}' | sudo tee $(CONFDIR)/hosts.json > /dev/null; \
		sudo chown tenodera-gw:tenodera-gw $(CONFDIR)/hosts.json; \
		sudo chmod 640 $(CONFDIR)/hosts.json; \
		echo "    Created $(CONFDIR)/hosts.json"; \
	else \
		sudo chown tenodera-gw:tenodera-gw $(CONFDIR)/hosts.json; \
		sudo chmod 640 $(CONFDIR)/hosts.json; \
		echo "    $(CONFDIR)/hosts.json already exists — skipping"; \
	fi
	@if [ ! -f $(CONFDIR)/gateway.env ]; then \
		printf '# Tenodera Gateway Configuration\n# See: systemctl cat tenodera-gateway\n\n# Bind address and port\nTENODERA_BIND_ADDR=0.0.0.0\nTENODERA_BIND_PORT=9090\n\n# Path to bridge binary\nTENODERA_BRIDGE_BIN=/usr/local/bin/tenodera-bridge\n\n# Path to built UI assets\nTENODERA_UI_DIR=/usr/share/tenodera/ui\n\n# TLS — optional. Uncomment and set cert/key paths to enable HTTPS.\n# Generate a self-signed cert: sudo make tls-selfsigned\n#TENODERA_TLS_CERT=/etc/tenodera/tls/cert.pem\n#TENODERA_TLS_KEY=/etc/tenodera/tls/key.pem\n\n# HTTP mode (plain, no TLS) — enabled by default.\n# Comment out after configuring TLS above to switch to HTTPS.\nTENODERA_ALLOW_UNENCRYPTED=1\n\n# Log level (trace, debug, info, warn, error)\nRUST_LOG=info\n' \
			| sudo tee $(CONFDIR)/gateway.env > /dev/null; \
		sudo chown root:tenodera-gw $(CONFDIR)/gateway.env; \
		sudo chmod 640 $(CONFDIR)/gateway.env; \
		echo "    Created $(CONFDIR)/gateway.env (HTTP mode — configure TLS for production)"; \
	else \
		sudo chown root:tenodera-gw $(CONFDIR)/gateway.env; \
		sudo chmod 640 $(CONFDIR)/gateway.env; \
		echo "    $(CONFDIR)/gateway.env already exists — skipping (preserving your config)"; \
	fi
	@echo "==> Installing PAM service config..."
	@if [ -f /etc/pam.d/common-auth ]; then \
		printf '#%%PAM-1.0\n# Tenodera gateway authentication\nauth    include common-auth\naccount include common-account\n' \
			| sudo tee /etc/pam.d/tenodera > /dev/null; \
	else \
		sudo install -m 644 pam.d/tenodera /etc/pam.d/tenodera; \
	fi
	@echo "==> Setting up audit log..."
	sudo touch /var/log/tenodera_audit.log
	sudo chown root:root /var/log/tenodera_audit.log
	sudo chmod 622 /var/log/tenodera_audit.log
	@echo "==> Installing systemd services..."
	sudo cp systemd/tenodera-gateway.service $(SYSTEMDDIR)/
	sudo systemctl daemon-reload
	sudo systemctl enable --now tenodera-gateway
	@echo "==> Installing logrotate config..."
	sudo install -m 644 logrotate/tenodera /etc/logrotate.d/tenodera
	@echo ""
	@echo "✓ Tenodera Panel installed"
	@echo "  Service: systemctl status tenodera-gateway"
	@echo "  Logs:    journalctl -u tenodera-gateway -f"
	@echo ""
	@echo "  Bridge must be installed separately on managed hosts."
	@echo "  See ../bridge/ or use: make install in the bridge/ directory on each host."
	@echo ""
	@echo "  Login with any PAM user (system credentials)."
	@echo "  Configuration: $(CONFDIR)/gateway.env"
	@echo ""
	@echo "  Panel:  http://$$(hostname -I | awk '{print $$1}'):9090"
	@echo "  Running in HTTP mode. To enable HTTPS: sudo make tls-selfsigned, then update $(CONFDIR)/gateway.env."

$(GATEWAY_BIN):
	$(MAKE) build-backend

$(PAM_HELPER_BIN):
	$(MAKE) build-backend

ui/dist/index.html:
	$(MAKE) build-frontend

# ── Uninstall ─────────────────────────────────────────────

uninstall:
	@echo "==> Stopping and removing Tenodera Panel..."
	-sudo systemctl stop tenodera-gateway
	-sudo systemctl disable tenodera-gateway
	-sudo rm -f $(SYSTEMDDIR)/tenodera-gateway.service
	-sudo rm -rf $(SYSTEMDDIR)/tenodera-gateway.service.d
	-sudo systemctl stop tenodera-bridge 2>/dev/null || true
	-sudo systemctl disable tenodera-bridge 2>/dev/null || true
	-sudo rm -f $(SYSTEMDDIR)/tenodera-bridge.service
	-sudo systemctl daemon-reload
	-sudo pkill -f tenodera-gateway 2>/dev/null || true
	-sudo pkill -f tenodera-bridge 2>/dev/null || true
	-sudo rm -f $(BINDIR)/tenodera-gateway $(BINDIR)/tenodera-pam-helper $(BINDIR)/tenodera-bridge
	-sudo rm -rf $(UIDIR)
	-sudo rm -rf $(CONFDIR)
	-sudo rm -f /etc/logrotate.d/tenodera
	-sudo rm -f /etc/pam.d/tenodera
	-sudo rm -f /var/log/tenodera*
	-sudo userdel tenodera-gw 2>/dev/null || true
	@echo "✓ Tenodera Panel fully removed"

# ── TLS ───────────────────────────────────────────────────

tls-selfsigned:
	@echo "==> Generating self-signed TLS certificate (valid 3650 days)..."
	sudo mkdir -p $(CONFDIR)/tls
	sudo openssl req -x509 -newkey rsa:4096 -nodes -days 3650 \
		-keyout $(CONFDIR)/tls/key.pem \
		-out $(CONFDIR)/tls/cert.pem \
		-subj "/CN=$$(hostname)"
	sudo chown root:tenodera-gw $(CONFDIR)/tls/cert.pem $(CONFDIR)/tls/key.pem
	sudo chmod 640 $(CONFDIR)/tls/cert.pem $(CONFDIR)/tls/key.pem
	@echo ""
	@echo "✓ Self-signed certificate created:"
	@echo "  Cert: $(CONFDIR)/tls/cert.pem"
	@echo "  Key:  $(CONFDIR)/tls/key.pem"
	@echo ""
	@echo "  To enable HTTPS, edit $(CONFDIR)/gateway.env:"
	@echo "    1. Uncomment TENODERA_TLS_CERT and TENODERA_TLS_KEY"
	@echo "    2. Comment out TENODERA_ALLOW_UNENCRYPTED=1"
	@echo "    3. sudo systemctl restart tenodera-gateway"
	@echo "    4. Update /etc/tenodera/bridge.env: change http:// → https://"
	@echo "       and set TENODERA_BRIDGE_ACCEPT_INSECURE=1"
	@echo "    5. sudo systemctl restart tenodera-bridge"
	@echo ""
	@echo "  Panel will then be at: https://$$(hostname -I | awk '{print $$1}'):9090"
	@echo "  (Browser will warn about self-signed cert — this is expected)"

# ── Packages ──────────────────────────────────────────────

VERSION ?= $(shell . "$$HOME/.cargo/env" 2>/dev/null || true; cargo metadata --no-deps --format-version 1 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['packages'][0]['version'])" 2>/dev/null || echo "0.1.0")

package-deb: build
	@echo "==> Building Debian package (tenodera-gateway v$(VERSION))..."
	@command -v dpkg-deb >/dev/null 2>&1 || { echo "ERROR: dpkg-deb not found — install dpkg"; exit 1; }
	$(eval PKGDIR := /tmp/tenodera-gateway-deb-$(VERSION))
	@rm -rf $(PKGDIR) && mkdir -p \
		$(PKGDIR)/DEBIAN \
		$(PKGDIR)/usr/bin \
		$(PKGDIR)/usr/share/tenodera/ui \
		$(PKGDIR)/lib/systemd/system \
		$(PKGDIR)/etc/logrotate.d \
		$(PKGDIR)/etc/pam.d
	@install -m 755 target/release/tenodera-gateway $(PKGDIR)/usr/bin/
	@install -m 4750 target/release/tenodera-pam-helper $(PKGDIR)/usr/bin/
	@cp -r ui/dist/. $(PKGDIR)/usr/share/tenodera/ui/
	@install -m 644 systemd/tenodera-gateway.service $(PKGDIR)/lib/systemd/system/
	@install -m 644 logrotate/tenodera $(PKGDIR)/etc/logrotate.d/tenodera
	@install -m 644 pam.d/tenodera $(PKGDIR)/etc/pam.d/tenodera
	@printf 'Package: tenodera-gateway\nVersion: $(VERSION)\nArchitecture: amd64\nMaintainer: Tenodera <noreply@tenodera>\nDescription: Tenodera web administration panel gateway\n The gateway serves the Tenodera web UI and routes channel messages to\n bridge agents on managed hosts via reverse WebSocket connections.\n' > $(PKGDIR)/DEBIAN/control
	@printf '#!/bin/sh\ngetent group tenodera-gw >/dev/null || groupadd -r tenodera-gw\ngetent passwd tenodera-gw >/dev/null || \\\n    useradd -r -s /sbin/nologin -M -d /nonexistent -g tenodera-gw \\\n    -c "Tenodera Gateway" tenodera-gw\nexit 0\n' > $(PKGDIR)/DEBIAN/preinst
	@chmod 755 $(PKGDIR)/DEBIAN/preinst
	@dpkg-deb --build $(PKGDIR) tenodera-gateway_$(VERSION)_amd64.deb
	@rm -rf $(PKGDIR)
	@echo "✓ Package: tenodera-gateway_$(VERSION)_amd64.deb"

package-rpm: build
	@echo "==> Building RPM package (tenodera-gateway v$(VERSION))..."
	@command -v rpmbuild >/dev/null 2>&1 || { echo "ERROR: rpmbuild not found — install rpm-build"; exit 1; }
	@mkdir -p ~/rpmbuild/{BUILD,RPMS,SOURCES,SPECS,SRPMS}
	@cp ../packaging/tenodera-gateway.spec ~/rpmbuild/SPECS/
	@cp target/release/tenodera-gateway target/release/tenodera-pam-helper ~/rpmbuild/BUILD/
	@cp -r . ~/rpmbuild/BUILD/panel
	@cp -r ui/dist ~/rpmbuild/BUILD/panel/ui/
	@rpmbuild -bb --define "version $(VERSION)" --define "_topdir $$HOME/rpmbuild" ~/rpmbuild/SPECS/tenodera-gateway.spec
	@find ~/rpmbuild/RPMS -name "tenodera-gateway-*.rpm" -exec cp {} . \;
	@echo "✓ RPM package built"

# ── Clean ─────────────────────────────────────────────────

clean:
	cargo clean
	rm -rf ui/dist ui/node_modules
