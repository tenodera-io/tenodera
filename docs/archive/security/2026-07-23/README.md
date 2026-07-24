# Archived security analysis — Tenodera v0.x (2026-07-23)

**Historical documents. Not maintained.**

These files capture the external security audit and its triage as they stood for
the **v0.x** architecture (outbound root agent + WebSocket gateway + JSON-file
state). They are preserved for reference and provenance.

| File | What it is |
|------|------------|
| `ANALISE.md` | Raw external-AI security review (self-reported base v0.2.13). |
| `SECURITY_AUDIT_TRIAGE.md` | Verified triage against live code: which findings were real, fixed, or open, with `file:line` evidence. |

**Status of the findings:** all P0 and the P1/P2 items marked *done* in the triage
were fixed and merged into the v0.x line (see the `## [0.3.1]`–`## [Unreleased]`
sections of `docs/CHANGELOG.md` and tags `v0.3.1`…`v0.5.1`+). 

**The remaining items are superseded by the v2 rebuild.** The triage's open work
(`sudo sh -c` → file-helper, agent privilege separation, systemd sandboxing of the
root agent) all exists *because the v0.x agent runs as root*. Tenodera v2 removes
the persistent root daemon entirely (SSH transport → per-user bridge → sudo), so
that class of problem does not carry forward. See
[`../../../architecture/TENODERA_V2.md`](../../../architecture/TENODERA_V2.md) and
the ADRs under `docs/adr/`.
