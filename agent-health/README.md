# Agent Health Center

`outbox/claude.md` is the shared handoff from Codex’s Agent Health Center to Duncan/Claude. It is created only for a red, evidence-backed failure and removed on an all-clear. Claude must not treat a missing file as a failure.

## Verification contract (September 19 repair)

Canonical checker: `python3 ~/dashboard/agent-health/scripts/health_check.py --read-only`.
It reads local receipts and public GitHub deployment/ref metadata. Read-only mode never
writes or deletes the outbox. Report yellow and red; green proves only the named evidence,
not pick accuracy or future reliability. Missing/stale/malformed proof is yellow; explicit
failures and named blockers are red. An absent outbox is not an all-clear certificate.
Only run without `--read-only` when an evidence-backed Claude handoff is authorized.
Manual Collections inactivity is not permission to run paid research. Schedule ownership
stays unchanged; Optimus is weekly Sunday 21:15 with Sol low, not daily/minimal.
