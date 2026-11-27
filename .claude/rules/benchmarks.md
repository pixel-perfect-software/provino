---
paths:
  - "packages/bench/**"
---

# Benchmark rules

- **The protocol is Track 12 R5/R6.** Interleave Provino and Jest runs (10 warm, 5 cold per suite), report median ratios with a bootstrap 95% CI, and sample tree RSS. Don't invent a different protocol.
- **Label every record** with one of: `local` (any laptop or CI box; development signal only); `desktop` (the pinned-core container on Tyler's desktop, Phase 0–1 provisional numbers); `pinned` (the same container under the full protocol, with turbo off and a fixed clock, set up by B18; DECISIONS D66). Only `pinned` numbers decide GO or appear publicly.
- **Never cherry-pick.** No dropping runs, re-running until it's faster, or excluding suites without a written reason in the record.
- **Gates compare against fixed thresholds** (D5: ≤0.50 warm, ≤0.80 cold, registry/none ≤3.0). Never edit a threshold to pass. `provino-bench kill-check` applies them in `src/kill-check.ts` (`KILL_CRITERION`). A `--dry-run` record (Jest standing in for Provino) is a wiring check, never a result. Suites that can't run yet stay listed as pending in `R6_SUITES` and keep the verdict provisional. See `packages/bench/CLAUDE.md`.
- **Synthetic suites** (app-N, mock-heavy-N, isolate-heavy, jsdom-N, snapshot-N) are our own MIT-clean generators. Don't copy Bun's.
- **PR regression checks** use instruction counts (cachegrind, `--predictable`), not wall time.
- **No CI job runs a benchmark, an instruction count or a timing guard on its own.** Measurements are one-time manual runs. A heavy workflow (the install matrix, anything with dozens of jobs) is `workflow_dispatch` only: no `pull_request`, `push` or `schedule` trigger, not even one path-filtered to its own file, and it is proven by one manual run after merge. Before building anything that adds many CI jobs, say how many it adds and when they fire, and wait for Tyler's go.
- **A CI job that runs real runners or large corpora is gated on its real inputs** (extend the scope step's path list in `.github/workflows/ci.yml`), and the gate fails closed.
- Before quoting any research number, check `docs/research/benchmarks-quiet-rerun.md`. Several first-reported numbers moved on the quiet re-run.
