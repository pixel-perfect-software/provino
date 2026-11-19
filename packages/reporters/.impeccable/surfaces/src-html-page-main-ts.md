---
version: 1
slug: "src-html-page-main-ts"
primary_target: "src/html/page/main.ts"
related_targets: ["src/html/page/styles.ts"]
---

# Surface: Provino HTML test report

Scope: the static, self-contained report page (`src/html/page/main.ts`, `src/html/page/styles.ts`). Mode: Operate.
Audience and job: developers who ran the suite (locally) and reviewers who open it as a CI artifact, cold. In order: find why tests failed, get the run at a glance, see where time went, browse the whole suite.
Constraints: one file, CSP `default-src 'none'`, system fonts, inline SVG only, light and dark through `prefers-color-scheme`, WCAG 2.2 AA, 320 px and 200% zoom, render on demand (50,000 tests), ≤ 400 KB at 500 passing files.
Tyler: the first screen is the verdict with the failures under it. Wrong would be terminal cosplay, a look-alike of Jest's or Vitest's UI, or low density.

## Direction contract

THESIS: The run as a recorded profile. Time and results are one instrument: a run overview of every worker along time sits under the verdict, and every view (failures, tree, map, folders, lanes) is a lens on that recording. Refused: the category's tiles, donut and two-pane tree.

OWN-WORLD: Panel greys with hairline 1 px dividers, no cards and no shadows. Dense system UI sans at 12 and 13 px with tabular numerals. Monospace is for data: code, error text, and file and folder paths. Status is an authored glyph plus a word or a count, and on drawn marks a pattern (hatched failed, cross-hatched crashed, dotted skipped, outlined todo), never colour alone. Passing work is muted by folder hue, failure is signal red, and selection is the one blue. Dark is a true panel dark, not inverted.

STORY: The visitor reads the verdict in one second and the first failure in three, then follows a failure to its file, to its place in the run, and to its worker.

FIRST VIEWPORT: A 40 px verdict bar (💥/🎉, failed, passed, skipped, todo, time, workers, seed, snapshots in fixed fields). Under it, a 56 px run overview: every worker's files as slices on one time axis, with failures marked. Then the tab strip (Failures · Tests · Map · Folders · Timeline), with Failures open on a failing run, the first failure expanded with its code frame, and the rest as one-line rows.

FORM: Profiler Panel, my ranked #1 (the pick), seed d17c758a (degraded roll). Signature interaction: brushing a time range on the run overview filters every view to the files that ran in it, and a slice click jumps to that file in Tests. Motion: 120 ms opacity and height on expand only, none under reduced motion.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
