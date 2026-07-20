# Contributing to Tenodera

Thanks for your interest in improving Tenodera. This guide covers how to build,
test, and submit changes.

## Ground rules

- Be respectful — see the [Code of Conduct](.github/CODE_OF_CONDUCT.md).
- Security issues are **not** reported as public issues — see [SECURITY.md](.github/SECURITY.md).
- By contributing, you agree your work is licensed under the project's
  [MIT license](LICENSE).

## Project layout

| Path | What |
|------|------|
| `protocol/` | Shared message types (gateway ↔ agent) — standalone crate |
| `panel/` | Cargo workspace: `crates/gateway` (Axum server + PAM) and `crates/pam-helper` |
| `panel/ui/` | React + TypeScript frontend (Vite) |
| `agent/` | Agent installed on managed hosts |
| `packaging/` | `.deb`/`.rpm` spec + maintainer scripts |

`panel/protocol` is a symlink to `../protocol`, so `cargo` resolves it in place.

## Development setup

You need a recent stable **Rust** (edition 2024, ≥ 1.85), **Node.js 22**, and the
system libraries `libpam0g-dev`, `clang`, `libclang-dev`, `pkg-config`.

```bash
# Backend
cargo build --manifest-path panel/Cargo.toml
cargo build --manifest-path agent/Cargo.toml

# Frontend
cd panel/ui && npm ci && npm run build
```

See [DOCS.md](docs/DOCS.md) for configuration and TLS, and the per-crate READMEs
(`agent/`, `panel/crates/gateway/`, `panel/ui/`) for architecture notes.

## Before you open a PR

CI runs these on every push and pull request — run them locally first so the
build stays green:

```bash
# Format, lint, and test each crate
for d in protocol panel agent; do
  cargo fmt   --manifest-path "$d/Cargo.toml" --all --check
  cargo clippy --manifest-path "$d/Cargo.toml" --all-targets -- -D warnings
  cargo test  --manifest-path "$d/Cargo.toml"
done

# UI type-check + bundle
cd panel/ui && npm run build
```

Clippy runs with **default lints, no config files** — keep it warning-clean.

## Pull requests

1. Branch off `main`.
2. Keep changes focused; match the surrounding code's style and comment density.
3. Add or update tests for behavioural changes.
4. Update docs (`README.md`, `docs/DOCS.md`) and `docs/CHANGELOG.md` (`Unreleased` section)
   when your change is user-visible.
5. Fill in the PR template checklist.

## Releases

Releases are tag-driven: pushing a `vX.Y.Z` tag builds signed `.deb`/`.rpm`
packages (amd64 + arm64) and publishes a GitHub Release. The crate version is
stamped from the tag, so there is no version to bump by hand — see
[.github/workflows/release.yml](.github/workflows/release.yml).
