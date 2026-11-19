---
name: Provino HTML test report
description: One self-contained page that shows a test run as a recorded profile of results and time.
colors:
  bg: "#ffffff"
  panel: "#f4f6f8"
  line: "#d5dae0"
  line-strong: "#b9c0c8"
  ink: "#16191d"
  ink-2: "#4f5965"
  ink-3: "#66707c"
  accent: "#0a5fd1"
  accent-wash: "#e3eefc"
  pass: "#17723a"
  pass-fill: "#7d8b9a"
  fail: "#c01f2b"
  fail-fill: "#e0505b"
  skip: "#85590a"
  skip-fill: "#a7802a"
  todo: "#6a4bb8"
  idle: "#eef1f4"
  code-bg: "#f7f8fa"
  bg-dark: "#15171a"
  panel-dark: "#1c1f23"
  line-dark: "#2e3339"
  line-strong-dark: "#434a52"
  ink-dark: "#e7e9ec"
  ink-2-dark: "#a6afb9"
  ink-3-dark: "#8f99a4"
  accent-dark: "#5ea3ff"
  accent-wash-dark: "#1b2d47"
  pass-dark: "#5cc985"
  pass-fill-dark: "#66737f"
  fail-dark: "#ff7a73"
  fail-fill-dark: "#d9434d"
  skip-dark: "#e3b85a"
  skip-fill-dark: "#8a6a26"
  todo-dark: "#b7a2ff"
  idle-dark: "#1f2328"
  code-bg-dark: "#1a1d21"
typography:
  display:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 650
    lineHeight: 1.45
    letterSpacing: "-0.01em"
    fontFeature: "\"tnum\""
  headline:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 700
    lineHeight: 1.45
  title:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: 1.45
    fontFeature: "\"tnum\""
  body:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.45
    fontFeature: "\"tnum\""
  meta:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.45
    fontFeature: "\"tnum\""
  label:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 600
    lineHeight: 1.45
    letterSpacing: "0.04em"
  data:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, \"Liberation Mono\", monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  hairline: "1px"
  cell: "2px"
  field: "4px"
  pill: "999px"
spacing:
  s-1: "2px"
  s-2: "4px"
  s-3: "8px"
  s-4: "12px"
  s-5: "16px"
  s-6: "24px"
  row: "26px"
components:
  verdict-bar:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    typography: "{typography.display}"
    padding: "8px 16px"
  tab:
    textColor: "{colors.ink-2}"
    typography: "{typography.body}"
    padding: "8px 12px"
  tab-selected:
    textColor: "{colors.ink}"
  chip:
    textColor: "{colors.ink-2}"
    typography: "{typography.meta}"
    rounded: "{rounded.pill}"
    height: "24px"
    padding: "0 8px"
  chip-pressed:
    backgroundColor: "{colors.accent-wash}"
    textColor: "{colors.ink}"
  search:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.field}"
    height: "28px"
    padding: "0 8px"
  range-input:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    height: "24px"
    width: "7em"
    padding: "0 4px"
  code-frame:
    backgroundColor: "{colors.code-bg}"
    textColor: "{colors.ink}"
    typography: "{typography.data}"
    rounded: "{rounded.field}"
    padding: "8px 12px"
  tree-node:
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    height: "26px"
    padding: "0 4px"
  tree-node-active:
    backgroundColor: "{colors.accent-wash}"
  map-cell:
    backgroundColor: "{colors.pass-fill}"
    rounded: "{rounded.cell}"
    size: "11px"
  folder-bar:
    rounded: "{rounded.hairline}"
    height: "8px"
---

# Design System: Provino HTML test report

## Overview

**Creative North Star: "The Profiler Panel"**

The report is a recorded profile of a run. Results and time are one instrument: a run overview of every worker along one time axis sits under the verdict, and every tab (Failures, Tests, Map, Folders, Timeline) is a lens on that recording. Brushing a range on the overview filters every view; a slice, a cell or a failure link jumps to the file in Tests or on its worker.

The material is panel grey and hairlines. Surfaces are flat white and panel grey, divided by 1 px lines, with no cards and no shadows. Text is dense system sans at 12 and 13 px with tabular numerals, and monospace is kept for data: code frames, error text, file and folder paths. The page is a tool for reading a run in seconds, so density is high and decoration is absent.

Status is never colour alone. Every status has an authored SVG glyph and a word or count, and every drawn mark adds a pattern. Passing work recedes in muted folder hues or slate; failure is the one red; selection and focus are the one blue. Dark is a true panel dark with its own values, not an inversion.

**Key Characteristics:**
- Flat panel greys, 1 px dividers, no cards, no shadows.
- System sans at 11 to 18 px with tabular numerals; monospace only for data.
- Status as glyph plus word or count, plus a pattern on drawn marks.
- Red only for failure, blue only for selection and focus.
- One time axis shared by the overview, the timeline and every filter.

## Colors

A cool slate neutral field, with three signal hues (failure red, selection blue, and the amber and violet of skipped and todo) and muted folder hues for passing work. Every token is a custom property on `:root`; the dark scheme redefines the same names under `prefers-color-scheme: dark` (the `-dark` keys above are those values).

### Primary
- **Selection Blue** (`--accent`): the selected tab's 2 px underline, the focus ring, links and link-styled buttons, the brush on the run overview, and a pressed chip's border. **Selection Wash** (`--accent-wash`) fills a pressed chip, the active tree row and text selection.

### Secondary
- **Signal Red** (`--fail`): failure text, the failing verdict headline, failed counts, the first error line of a collapsed failure row, the highlighted line of a code frame, and the crashed map cell. **Failure Fill** (`--fail-fill`) is the base of hatched marks: failed slices, failed cells, a folder bar with a failure.

### Tertiary
- **Skip Amber** (`--skip`, fill `--skip-fill`): skipped and not-run glyphs; dotted skipped marks.
- **Todo Violet** (`--todo`): todo glyphs and the outline of todo marks.
- **Pass Green** (`--pass`): the pass glyph and `- Expected` diff lines only. It is not a fill.
- **Folder hue** (`hsl(var(--h) var(--slice-s) var(--slice-l))`; saturation 18% and lightness 42% light, 17% and 56% dark): the fill of a passing slice on the overview and timeline and of a folder's time bar. Each folder gets `--h` from a golden-angle walk confined to 85° to 320°, so no passing hue sits near red.

### Neutral
- **Paper** (`--bg`): the page, the overview strip, inputs, and the gap stroke between slices.
- **Panel Grey** (`--panel`): the verdict bar, the tab bar, sticky table headers, and row hover.
- **Hairline** (`--line`) and **Strong Hairline** (`--line-strong`): every divider; strong for input borders, table header rules and the scrollbar.
- **Ink** (`--ink`), **Ink 2** (`--ink-2`), **Ink 3** (`--ink-3`): primary text; secondary text, folder paths and tab labels; field labels, counts, axis text and placeholders. Each passes 4.5:1 on Paper and Panel Grey in both schemes.
- **Slate** (`--pass-fill`): a passing map cell.
- **Idle** (`--idle`): the empty track of a worker lane.
- **Code Paper** (`--code-bg`): code frames and inline errors.

### Named Rules
**The One Red Rule.** Red means a failure or a crash and nothing else. No passing hue may come near it: folder hues stay inside 85° to 320°.

**The One Blue Rule.** Blue means selection or focus: the selected tab, a pressed chip, the active row, the brush, the focus ring, links. It never marks a status.

**The Muted Pass Rule.** Passing work recedes. It is drawn in folder hue or slate at low saturation, so the eye lands on what failed.

## Typography

**Body Font:** system-ui (with -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif)
**Data Font:** ui-monospace (with SFMono-Regular, Menlo, Consolas, Liberation Mono, monospace)

**Character:** One system sans for every word of interface, set small and dense with tabular numerals on the root, and one system monospace for the data the run produced.

### Hierarchy
The scale is five steps, `--t-xs` to `--t-xl`; the root is `400 var(--t-md)/1.45` with `font-variant-numeric: tabular-nums`.
- **Display** (650, `--t-xl`, -0.01em): the verdict headline only, with the run glyph at `--t-lg` beside it.
- **Headline** (bold, `--t-lg`): the empty state's heading.
- **Title** (600, `--t-md`): a failure row's test title path, separated by a muted `›`; field values in the verdict bar.
- **Body** (400, `--t-md`): tabs, tree rows, table cells, prose.
- **Meta** (400, `--t-sm`): counts and times in tree rows, chips, notes, the legend, lane labels, the tab-bar location line.
- **Label** (600, `--t-xs`, 0.04em, uppercase): verdict field names, folder table column headers, and the run overview's own heading.
- **Data** (mono, `--t-sm`, line-height 1.5): code frames, error lines, file and folder paths.

### Named Rules
**The Data Is Mono Rule.** Monospace is for what the run produced: code, error text, file and folder paths. Interface words are never mono.

**The Tabular Rule.** Numerals are tabular everywhere, so counts and times line up across rows.

## Layout

The page is a full-width stack with no container: verdict bar, run overview, tab bar, then the open panel. Horizontal padding is `--s-5` (16 px) on desktop and `--s-3` (8 px) at 640 px and below.

- **Spacing scale** (`--s-1` to `--s-6`: 2, 4, 8, 12, 16, 24 px): gaps inside a row use `--s-2` and `--s-3`; panel padding is `--s-4` top and `--s-6` bottom; field groups in the verdict bar are `--s-6` apart.
- **Row rhythm:** tree rows are at least `--row` (26 px); timeline lanes are 22 px; the run overview is 56 px tall with lanes dividing that height.
- **Sticky bar:** the tab bar is `position: sticky; top: 0` with `scroll-padding-top: 52px` on the root, so a revealed row is not hidden under it. At 640 px and below it is static, wraps its tabs, and the padding is 0.
- **At 640 px and below:** the tab bar's location line drops to its own row, the overview's description takes a full row, the folder table hides its bar, file count and slowest file columns, and a failure row hides its time.
- **Grids:** a failure row is `12px | 1fr | auto` (glyph, title and file, time); a tree row is `indent | 14px twisty | 12px glyph | 1fr label | auto meta`, indented 14 px a level; the map is `repeat(auto-fill, minmax(232px, 1fr))`; the timeline is `auto` labels beside a horizontally scrolling SVG.

## Elevation & Depth

Flat. There are no shadows. Depth comes from two tonal layers (Paper and Panel Grey) and 1 px hairlines. The only stacking is the sticky tab bar (`z-index: 2`) and the sticky header of the timeline table. The inset ring on a todo map cell is an outline, not elevation.

### Named Rules
**The Hairline Rule.** Separate with a 1 px `--line` divider or a change from Paper to Panel Grey. No cards, no shadows, no floating surfaces.

## Shapes

Square by default. Rows, panels, tables and the bars are unrounded. Small radii are functional: 1 px on folder bars, 2 px on map cells and the focus ring, 4 px on inputs, code frames and the table wrapper, and a full pill (999 px) on chips. Drawn marks are rectangles on a time axis or 11 px squares; there is no other silhouette.

## Components

### Verdict bar
The run in one line. Panel Grey with a hairline below, `--s-3` by `--s-5` padding, wrapping. The headline is Display: "3 tests failed in 3 files · 1 file crashed" in Signal Red with 💥, or "All N tests passed" in Ink with 🎉 (the run glyphs of the brand set). Then a `<dl>` of fixed fields (Failed first on a failing run, Passed first otherwise; Skipped, Todo, Files, Time, Workers, Seed, Snapshots), each a Label name and a Title value; a failed count is red. The run's root and start time sit in Meta, in the bar on the empty state and in the tab bar otherwise.

### Run overview
Every worker as a lane on one 0-to-duration axis, 56 px tall, below the verdict. Each file is a slice: folder hue when it passed, hatched Failure Fill when it failed, cross-hatched red when it crashed, dotted Skip Amber when every test was skipped, a Paper rect outlined in Todo Violet when every test is a todo. Failed and crashed slices are drawn last, on top. Slices are separated by a 1 px Paper stroke. A three-tick axis (0, half, end) sits below in `--t-xs`.
- **Brush:** a pointer drag draws a Selection Blue rect at 14% fill with a 1 px stroke and filters every view to the files in range; files outside it dim to 0.28. A click under a fortieth of a percent of the run is a jump to the file in Tests. Escape clears.
- **Range form:** "Select range…" opens an inline form (From and To in seconds, 24 px inputs, Apply and Cancel as chips) for keyboard and touch; "Clear range" and the range's summary are announced politely.

### Tab bar
Five tabs with counts, on Panel Grey with a hairline below. A tab is Body in Ink 2, `--s-3` by `--s-4`; the selected tab is Ink with a 2 px Selection Blue underline inset by `--s-3`. The Failures count is red and 600 on a failing run. Arrow keys, Home and End move between tabs. Panels render on first selection and re-render when the range changes.

### Failure row
A one-line row per failed test or crashed file, divided by hairlines. The head is a button: the status glyph, the file path in Data, the time (or "crashed") right-aligned, the title path in Title, and, when collapsed, the first error line in red Data cut with an ellipsis. Expanded (the first one is open on load), the body indents to the title's column and shows the code frame and two link buttons, "Show in Tests" and "Show on worker N". Hover is Panel Grey.

### Code frame
Error text in a `<pre>` on Code Paper with a hairline border, 4 px radius, `--s-3` by `--s-4` padding, scrolling sideways, line-height 1.5. The first line and `>` lines are red 600; `- Expected` lines are Pass Green, `+ Received` lines red; `at` frames are Ink 3. Inline errors in the tree use the same treatment.

### Tree row
The Tests panel is a `role="tree"` of folders, files, suites and tests. A row is 26 px minimum, hairline below, with a 14 px chevron twisty, a 12 px status glyph, the label (Data for folders and files, Body for suites and tests) and right-aligned Meta (failed count in red 600, tests, "slow" in Skip Amber, time). Folders and files with a failure open on load. Hover is Panel Grey; the row a jump lands on is Selection Wash; focus is an inset 2 px blue ring.

### Search and chips
A toolbar above the tree: a search field (28 px, 4 px radius, Strong Hairline border, Paper fill, flexible to 520 px) filters by path or title after 140 ms, and status chips (Failed, Skipped, Todo, each with its glyph and count) toggle filters. A chip is a 24 px pill with a hairline border in Ink 2; hover strengthens the border; pressed is Selection Wash with a Selection Blue border. Chips also serve as the small actions elsewhere (Apply, Cancel, "Show as a table").

### Map cell
One 11 px square per file, 2 px radius, 2 px apart, grouped by folder under a Data heading with its count (failures in red 600). A passing cell is Slate; failed is hatched Failure Fill; crashed is cross-hatched red; skipped is dotted Skip Amber; todo is transparent with a 1.5 px inset Todo Violet ring. A legend names each pattern in words. The grid is a `role="group"` described by its help line; one cell is in the tab order and arrow keys move by position; Enter or a click opens the file in Tests. Hover is a 1 px Ink outline.

### Folder bar
The Folders tab is a table, slowest folder first: path (Data), an 8 px bar of the folder's time against the slowest in its folder hue (hatched Failure Fill if the folder has a failure), time, share, files and slowest file. Column headers are Label over a Strong Hairline.

### Timeline lanes
One 22 px lane per worker, labelled "worker N" with its busy share ("72% busy") in `--t-xs` Ink 3; a lane that took over from a crashed worker is italic and says so. Slices use the overview's paint and carry a `<title>`; failed and crashed slices are in the tab order and Enter opens them in Tests. Hover strokes a slice in Ink. Ticks and grid lines are hairlines. "Show as a table" opens the same data as a table in a 480 px scrolling wrapper with a sticky header.

### Empty state
Left-aligned at 60ch with `--s-6` by `--s-5` padding: a Headline and one or two plain sentences in Ink 2 saying what happened and what to check. Used for a run with no files and a Failures tab with no failures.

### Status glyphs
Authored 12 px stroked SVG symbols in a sprite (`#i-pass` check, `#i-fail` cross, `#i-skip` double chevron, `#i-todo` pencil, `#i-crash` bolt, `#i-notrun` dash; `#i-chevron` for twisties), stroke 1.7, coloured by the status class. Always beside a word, count or label.

### Motion
One transition: the tree twisty rotates 90° over 120 ms on `cubic-bezier(0.16, 1, 0.3, 1)` (`--ease`) when a node expands. Everything else changes instantly. Under `prefers-reduced-motion: reduce` every transition is off.

### Named Rules
**The Pattern Rule.** Every drawn status mark carries a pattern as well as a colour: hatched failed, cross-hatched crashed, dotted skipped, outlined todo, flat for passed. Every status in text is a glyph plus a word or count.

**The Expand-Only Motion Rule.** Motion is the 120 ms twisty on expand and nothing else, and none under reduced motion.

## Do's and Don'ts

### Do:
- **Do** put the verdict first and the first failure, expanded with its code frame, directly under the run overview and tab bar on a failing run.
- **Do** take every size and gap from `--t-xs`…`--t-xl` and `--s-1`…`--s-6`.
- **Do** give every status mark a pattern and every status in text a glyph and a word or count.
- **Do** draw passing work in folder hue (`--h` in 85° to 320°) or Slate, and failure in `--fail` or `--fail-fill`.
- **Do** set code, error text and paths in `--mono`, and everything else in `--font` with tabular numerals.
- **Do** separate regions with 1 px `--line` hairlines and the Paper to Panel Grey step.
- **Do** define every colour in both schemes under the same custom property name.

### Don't:
- **Don't** use red for anything but failure or blue for anything but selection and focus.
- **Don't** add cards, shadows or floating surfaces.
- **Don't** convey a status by colour alone.
- **Don't** set interface words in monospace, or data in the sans.
- **Don't** animate anything but the expand twisty, and nothing under reduced motion.
- **Don't** use the uppercase Label style above another heading; it is for field names, column headers and the run overview's heading.
