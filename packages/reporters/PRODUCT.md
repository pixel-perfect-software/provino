# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers who run a JavaScript or TypeScript test suite with Provino (`provino jest` today, `provino vitest` later), and the teammates who review those runs. The HTML report is opened in two situations, equally often (Tyler, 2026-11-19):
- **Locally, from disk**, by the developer who just ran the suite and wants to dig into what happened.
- **As a CI artifact** linked from a pull request, by someone who did not run the tests and arrives with no context.

The page must therefore make sense cold. It cannot rely on the reader having seen the terminal output.

## Product Purpose

Provino is a fast, type-safe test runner that drops into an existing Jest project and aims to run it faster without a migration (`wiki/why-provino.md`). "Provino's own output" (B26) is how it shows a run: a live terminal reporter, terminal views (`--tree`, `--map`), and this static HTML report.

The report has four jobs, all confirmed as important:
1. **Find why tests failed:** reach each failure, read its error and code frame, and see which files broke.
2. **Get the run at a glance:** counts, duration, workers, seed and snapshot outcomes, for a pass or fail read in seconds.
3. **See where time went:** slow files and folders, the per-worker timeline and idle gaps. Speed is Provino's reason to exist.
4. **Browse the whole suite:** search and walk the full test tree, passing tests included.

## Positioning

Provino's output is its own, identical under every dialect (D134): a Jest project and a Vitest project get the same report. It shows how the run was scheduled across workers, not only what passed, because Provino's claim is speed through reuse.

## Operating Context

- The report is one `.html` file written when the run ends: `provino run --reporter html`, or `reporters: ['html']` in a Jest config (D141, D146). It is opened from disk or served with a static file server.
- It is often attached to CI runs and opened later, on any machine, possibly offline.
- Runs range from a handful of files to thousands: the plan's states are empty, all passed, failures, a crashed file (a worker died) and 2,000 files, and 50,000 tests must not mean 50,000 DOM nodes at load.

## Capabilities and Constraints

- **Self-contained (D138):**
  - one inline script, the serialized function `renderReport(data)`, pinned by a CSP hash;
  - one inline style string;
  - the data as an inline JSON block.
- **CSP:** `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-…'; img-src data:`. No network requests, no external fonts, scripts or images, and no runtime dependency (non-negotiable 9).
- **Size and speed (D145):** at 500 files, built in ≤ 50 ms and ≤ 400 KB when all pass, or ≤ 1 MB with the fixture's failure rate.
- **Timing data (D139):** per-file start, end and worker are stamped by the reporter on the coordinator's clock, so they are approximate to about 1 ms. A replaced worker gets a new id.
- **Views (D136):** a summary header, a searchable test tree, a status map (one cell per file, by folder), time by folder, and a per-worker timeline with a table view. A live browser UI is out of scope (IDEAS I8).
- **Terminology:** a file `passed`, `failed`, or `crashed` (its worker died); a test `passed`, `failed`, `skipped` or `todo`; "slow" against a file's expected time (`expectedMs`, D140); "worker"; "seed"; snapshot outcomes `written`, `updated`, `obsolete` and `unchecked`.

## Brand Commitments

- **Glyphs (D144):** ✅ pass, ❌ fail, ⏩ skipped, 📝 todo, 🐢 slow, 🎉 a passing run, 💥 a failing run. They are shared with the terminal reporter, which also has a plain `unicode` and an `ascii` set.
- **Voice:** plain, precise, factual sentences, as in the repo's docs. No marketing language.
- **Name:** "Provino". No logo asset exists. Don't invent one.

## Evidence on Hand

- Real runs come from the repo's bench suites (app-500, mock-heavy-500) and fixtures. The report shows a user's own run, so it needs no testimonials, customers or claims.
- No benchmark number may appear on the page as a claim: `local` numbers are signals, not results (non-negotiable 7).

## Product Principles

1. **Failures first, then everything else.** Someone arriving cold should reach the first failure in one step.
2. **Fast to open, fast to scan.** The report is part of a speed product: it loads instantly at thousands of files and renders on demand.
3. **Self-contained and safe to share.** Nothing leaves the file and nothing is fetched, so it works offline and as an artifact.
4. **Show the run, not only the results.** Time and scheduling are first-class, because they are what Provino changes.
5. **Neutral across dialects.** One look and one vocabulary, whatever runner the project came from.

## Accessibility & Inclusion

WCAG 2.2 AA in both colour schemes: visible focus, keyboard-only operation (the tree is a `role="tree"` with arrow keys, the tabs a `role="tablist"`), nothing conveyed by colour alone, an SVG timeline with `<title>`s and a table view of the same data, and use at 320 px width and 200% zoom. It is checked with `/review:design` before merge.
