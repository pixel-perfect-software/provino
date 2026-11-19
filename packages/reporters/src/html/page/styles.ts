// The report's stylesheet, as a string (`render.ts` writes it into a `<style>`; the CSP allows
// inline styles and nothing external). It is the Profiler Panel design (`DESIGN.md`): flat panel
// greys and 1 px hairlines, dense system sans with tabular numerals, status as a glyph and a word
// with a pattern on every drawn mark, red for failure and blue for selection only.
//
// Every colour, size, spacing and duration is a custom property on `:root` (light) with the dark
// values redefined under `prefers-color-scheme: dark`; a rule below holds only `var(--…)`, `0`, a
// 1 px hairline and a percentage. The markup's class names are the hooks:
//   status:   icon, s-pass s-fail s-skip s-todo s-crash s-notrun, sr-only, sprite
//   verdict:  verdict (is-fail), verdict-main, glyph, fields, n-fail, where, synthetic
//   overview: overview, overview-head, ov-desc, ov-chart, range, range-form, lane-track, slice (s-<status>), brush, dim, axis
//   tabs:     tabbar, tabs, tab, count, panel, toolbar, spaced, search, chip, note
//   failures: failures, failure, failure-head, failure-file, failure-title, sep, failure-first,
//             failure-ms, failure-body, links, hl, add, del, dim-line
//   tree:     tree, treeitem, node (k-folder k-file k-suite k-test), twisty, label, meta, slow,
//             is-active, inline-error, more
//   map:      legend, map-grid, map-block (has-fail), cells, cell (s-<status>)
//   folders:  folders, bar-cell, bar (has-fail), num, path, col-files, mono
//   timeline: timeline, lanes-labels, replaced, busy, lanes-scroll, lane-sep, t-slice, axis-text,
//             tick, table-wrap
//   other:    empty, pat-<name>-base and pat-<name>-mark (the SVG patterns)

/** The light colour tokens, as the rules `STYLES` has them. Read by `styles.test.ts`. */
export const LIGHT_COLOURS: string = `
  --bg: #ffffff;
  --panel: #f4f6f8;
  --line: #d5dae0;
  --line-strong: #b9c0c8;
  --ink: #16191d;
  --ink-2: #4f5965;
  --ink-3: #66707c;
  --accent: #0a5fd1;
  --accent-wash: #e3eefc;
  --pass: #17723a;
  --pass-fill: #7d8b9a;
  --slice-s: 18%;
  --slice-l: 42%;
  --fail: #c01f2b;
  --fail-fill: #e0505b;
  --skip: #85590a;
  --skip-fill: #a7802a;
  --todo: #6a4bb8;
  --idle: #eef1f4;
  --code-bg: #f7f8fa;`

/** The dark values of the same tokens. */
export const DARK_COLOURS: string = `
    --bg: #15171a;
    --panel: #1c1f23;
    --line: #2e3339;
    --line-strong: #434a52;
    --ink: #e7e9ec;
    --ink-2: #a6afb9;
    --ink-3: #8f99a4;
    --accent: #5ea3ff;
    --accent-wash: #1b2d47;
    --pass: #5cc985;
    --pass-fill: #66737f;
    --slice-s: 17%;
    --slice-l: 56%;
    --fail: #ff7a73;
    --fail-fill: #d9434d;
    --skip: #e3b85a;
    --skip-fill: #8a6a26;
    --todo: #b7a2ff;
    --idle: #1f2328;
    --code-bg: #1a1d21;`

/** The stylesheet. */
export const STYLES: string = `
:root {
  color-scheme: light dark;
  --font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  --t-axis: 0.625rem;
  --t-xs: 0.6875rem;
  --t-sm: 0.75rem;
  --t-md: 0.8125rem;
  --t-lg: 0.9375rem;
  --t-xl: 1.125rem;
  --tracking: 0.04em;
  --tracking-tight: -0.01em;
  --s-1: 2px;
  --s-2: 4px;
  --s-3: 8px;
  --s-4: 12px;
  --s-5: 16px;
  --s-6: 24px;
  --row: 26px;
  --icon: 12px;
  --twisty: 14px;
  --step: 14px;
  --err-offset: 40px;
  --ring: 2px;
  --ring-thin: 1.5px;
  --r-cell: 2px;
  --r-field: 4px;
  --r-pill: 999px;
  --ov-h: 56px;
  --lane-h: 22px;
  --search-h: 28px;
  --search-min: 260px;
  --search-max: 520px;
  --chip-h: 24px;
  --input-w: 7em;
  --bar-h: 8px;
  --cell: 11px;
  --map-min: 232px;
  --table-max: 480px;
  --chart-min: 480px;
  --ring-thick: 3px;
  --dash: 3 2;
  --tabbar-h: 52px;
  --measure: 60ch;
  --hatch-gap: 2px;
  --hatch-line: 3px;
  --dot-r: 1.4px;
  --dot-pitch: 4px;
  --dim: 0.28;
  --dur: 120ms;
  --ease: cubic-bezier(0.16, 1, 0.3, 1);${LIGHT_COLOURS}
  --hatch-fail: color-mix(in srgb, var(--bg) 55%, transparent);
  --hatch-crash: color-mix(in srgb, var(--bg) 60%, transparent);
  --hatch-skip: color-mix(in srgb, var(--bg) 75%, transparent);
}
@media (prefers-color-scheme: dark) {
  :root {${DARK_COLOURS}
  }
}
*, *::before, *::after { box-sizing: border-box; }
html { scroll-padding-top: var(--tabbar-h); scrollbar-gutter: stable; background: var(--bg); color: var(--ink); -webkit-text-size-adjust: 100%; scrollbar-color: var(--line-strong) transparent; }
body { margin: 0; min-width: 0; font: 400 var(--t-md)/1.45 var(--font); font-variant-numeric: tabular-nums; }
::selection { background: var(--accent-wash); color: var(--ink); }
:focus-visible { outline: var(--ring) solid var(--accent); outline-offset: var(--s-1); border-radius: var(--r-cell); }
[hidden] { display: none !important; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
a { color: var(--accent); text-underline-offset: var(--s-1); }
code, pre, .mono { font-family: var(--mono); font-size: var(--t-sm); }
h1, h2, h3, p, ul, dl, dd { margin: 0; }
.icon { width: var(--icon); height: var(--icon); flex: none; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.s-pass { color: var(--pass); }
.s-fail, .s-crash { color: var(--fail); }
.s-skip, .s-notrun { color: var(--skip); }
.s-todo { color: var(--todo); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.sprite { position: absolute; }
.pat-fail-base { fill: var(--fail-fill); }
.pat-fail-mark { fill: var(--hatch-fail); }
.pat-crash-base { fill: var(--fail); }
.pat-crash-mark { fill: var(--hatch-crash); }
.pat-skip-base { fill: var(--skip-fill); }
.pat-skip-mark { fill: var(--hatch-skip); }

.verdict { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2) var(--s-6); padding: var(--s-3) var(--s-5); background: var(--panel); border-bottom: 1px solid var(--line); }
.verdict-main { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s-2) var(--s-6); min-width: 0; }
.verdict h1 { font-size: var(--t-xl); font-weight: 650; letter-spacing: var(--tracking-tight); display: flex; align-items: baseline; gap: var(--s-3); }
.verdict h1 .glyph { font-size: var(--t-lg); }
.verdict.is-fail h1 { color: var(--fail); }
.fields { display: flex; flex-wrap: wrap; gap: var(--s-2) var(--s-6); }
.fields div { display: flex; align-items: baseline; gap: var(--s-2); }
.fields dt { color: var(--ink-3); font-size: var(--t-xs); font-weight: 600; text-transform: uppercase; letter-spacing: var(--tracking); }
.fields dd { font-weight: 600; }
.fields .n-fail { color: var(--fail); }
.where { color: var(--ink-3); font-size: var(--t-sm); min-width: 0; line-height: 1.35; }
.where code { color: var(--ink-2); }
.synthetic { color: var(--ink-3); font-weight: 600; }

.overview { position: relative; padding: var(--s-3) var(--s-5) var(--s-2); border-bottom: 1px solid var(--line); background: var(--bg); }
.overview-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s-1) var(--s-4); margin-bottom: var(--s-2); color: var(--ink-3); font-size: var(--t-xs); }
.overview-head h2 { font-size: var(--t-xs); font-weight: 600; text-transform: uppercase; letter-spacing: var(--tracking); color: var(--ink-2); }
.range { margin-left: auto; display: flex; gap: var(--s-3); align-items: baseline; color: var(--ink-2); }
.range button, .links button { display: inline-flex; align-items: center; min-height: var(--chip-h); margin-block: calc(var(--s-2) * -1); color: var(--accent); text-decoration: underline; text-underline-offset: var(--s-1); }
.range-form { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2) var(--s-3); margin: 0 0 var(--s-3); font-size: var(--t-sm); color: var(--ink-2); }
.range-form input { width: var(--input-w); height: var(--chip-h); padding: 0 var(--s-2); font: inherit; color: var(--ink); background: var(--bg); border: 1px solid var(--ink-3); border-radius: var(--r-field); }
.range-form input[aria-invalid="true"] { border: var(--ring) solid var(--fail); }
.field-error { display: flex; align-items: center; gap: var(--s-2); flex: 0 0 100%; color: var(--fail); font-weight: 600; }
.ov-chart { display: block; width: 100%; height: var(--ov-h); cursor: crosshair; touch-action: none; }
.lane-track { fill: var(--idle); }
.slice { fill: hsl(var(--h, 210) var(--slice-s) var(--slice-l)); stroke: var(--bg); stroke-width: 1px; vector-effect: non-scaling-stroke; }
.slice.s-fail { fill: url(#p-fail); }
.slice.s-crash { fill: url(#p-crash); }
.slice.s-skip { fill: url(#p-skip); }
.slice.s-todo { fill: var(--bg); stroke: var(--todo); stroke-width: var(--ring-thin); }
.brush { fill: var(--accent); fill-opacity: 0.14; stroke: var(--accent); stroke-width: 1px; }
.dim { opacity: var(--dim); }
.axis { display: flex; justify-content: space-between; color: var(--ink-3); font-size: var(--t-xs); padding-top: var(--s-1); }

.tabbar { display: flex; align-items: center; gap: var(--s-4); padding: 0 var(--s-5) 0 var(--s-2); border-bottom: 1px solid var(--line); background: var(--panel); position: sticky; top: 0; z-index: 2; }
.tabbar .where { margin-left: auto; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tabs { display: flex; gap: var(--s-1); min-width: 0; }
.tab { position: relative; display: flex; align-items: center; gap: var(--s-2); padding: var(--s-3) var(--s-4); color: var(--ink-2); white-space: nowrap; }
.tab:hover, .tab[aria-selected="true"] { color: var(--ink); }
.tab[aria-selected="true"]::after { content: ""; position: absolute; left: var(--s-3); right: var(--s-3); bottom: -1px; height: var(--ring); background: var(--accent); }
.tab .count { color: var(--ink-3); font-weight: 400; }
.tab .count.n-fail { color: var(--fail); font-weight: 600; }
.panel { padding: var(--s-4) var(--s-5) var(--s-6); }
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-3); margin-bottom: var(--s-3); }
.toolbar.spaced { margin-top: var(--s-4); }
.search { flex: 1 1 var(--search-min); max-width: var(--search-max); height: var(--search-h); padding: 0 var(--s-3); font: inherit; color: var(--ink); background: var(--bg); border: 1px solid var(--ink-3); border-radius: var(--r-field); }
.search::placeholder { color: var(--ink-3); }
.chip { display: inline-flex; align-items: center; gap: var(--s-2); height: var(--chip-h); padding: 0 var(--s-3); border: 1px solid var(--ink-3); border-radius: var(--r-pill); color: var(--ink-2); font-size: var(--t-sm); }
.chip:hover { border-color: var(--ink); color: var(--ink); }
.chip[aria-pressed="true"] { background: var(--accent-wash); border-color: var(--accent); color: var(--ink); }
.note { color: var(--ink-3); font-size: var(--t-sm); margin-bottom: var(--s-3); }

.failures { list-style: none; padding: 0; border-top: 1px solid var(--line); }
.failure { border-bottom: 1px solid var(--line); }
.failure-head { display: grid; grid-template-columns: var(--icon) minmax(0, 1fr) auto; gap: var(--s-1) var(--s-3); align-items: baseline; width: 100%; padding: var(--s-3) var(--s-2); text-align: left; }
.failure-head:hover { background: var(--panel); }
.failure-head .icon { align-self: center; }
.failure-file { font-family: var(--mono); font-size: var(--t-sm); color: var(--ink-2); overflow-wrap: anywhere; }
.failure-title { grid-column: 2; font-weight: 600; overflow-wrap: anywhere; }
.failure-title .sep { color: var(--ink-3); font-weight: 400; padding: 0 var(--s-1); }
[aria-expanded="true"] > .failure-first { display: none; }
.failure-first { grid-column: 2 / 4; color: var(--fail); font-family: var(--mono); font-size: var(--t-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.failure-ms { grid-column: 3; grid-row: 1; color: var(--ink-3); font-size: var(--t-sm); }
.failure-body { padding: 0 var(--s-2) var(--s-4) calc(var(--icon) + var(--s-3) + var(--s-2)); }
.failure-body pre, .inline-error { margin: 0; padding: var(--s-3) var(--s-4); background: var(--code-bg); border: 1px solid var(--line); border-radius: var(--r-field); overflow-x: auto; line-height: 1.5; color: var(--ink); white-space: pre; }
.hl { color: var(--fail); font-weight: 600; }
.add { color: var(--pass); }
.del { color: var(--fail); }
.dim-line { color: var(--ink-3); }
.links { display: flex; gap: var(--s-4); margin-top: var(--s-3); font-size: var(--t-sm); }

.tree { border-top: 1px solid var(--line); }
.tree [role="group"] { padding: 0; }
.node { display: grid; grid-template-columns: calc(var(--level, 0) * var(--step)) var(--twisty) var(--icon) minmax(0, 1fr) auto; align-items: center; gap: 0 var(--s-2); min-height: var(--row); padding: 0 var(--s-2); border-bottom: 1px solid var(--line); cursor: default; }
.node:hover { background: var(--panel); }
.treeitem:focus-visible { outline: none; }
.treeitem:focus-visible > .node { outline: var(--ring) solid var(--accent); outline-offset: calc(var(--ring) * -1); }
.node.is-active { background: var(--accent-wash); }
.twisty { width: var(--twisty); height: var(--twisty); color: var(--ink-3); transition: transform var(--dur) var(--ease); }
[aria-expanded="true"] > .node > .twisty { transform: rotate(90deg); }
.label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.node.k-folder .label, .node.k-file .label { font-family: var(--mono); font-size: var(--t-sm); }
.node.k-folder .label { color: var(--ink-2); }
.meta { display: flex; gap: var(--s-3); color: var(--ink-3); font-size: var(--t-sm); white-space: nowrap; }
.meta .n-fail { color: var(--fail); font-weight: 600; }
.meta .slow { color: var(--skip); }
.inline-error { margin: var(--s-2) var(--s-2) var(--s-3) calc(var(--level, 0) * var(--step) + var(--err-offset)); }
.more { padding: var(--s-3) var(--s-2); }

.legend { display: flex; flex-wrap: wrap; gap: var(--s-4); margin: 0 0 var(--s-3); padding: 0; list-style: none; color: var(--ink-2); font-size: var(--t-sm); }
.legend li { display: flex; align-items: center; gap: var(--s-2); }
.map-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(var(--map-min), 1fr)); gap: var(--s-4) var(--s-6); border-top: 1px solid var(--line); padding-top: var(--s-4); }
.map-block h3 { margin: 0 0 var(--s-2); font: 400 var(--t-sm)/1.35 var(--mono); color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.map-block h3 span { font-family: var(--font); color: var(--ink-3); font-size: var(--t-xs); padding-left: var(--s-2); }
.map-block.has-fail h3 span { color: var(--fail); font-weight: 600; }
.cells { display: flex; flex-wrap: wrap; gap: var(--s-1); }
.cell { width: var(--cell); height: var(--cell); border-radius: var(--r-cell); background: var(--pass-fill); }
.cell.s-fail { background-color: var(--fail-fill); background-image: repeating-linear-gradient(135deg, transparent 0 var(--hatch-gap), var(--hatch-fail) var(--hatch-gap) var(--hatch-line)); }
.cell.s-crash { background-color: var(--fail); background-image: repeating-linear-gradient(45deg, transparent 0 var(--hatch-gap), var(--hatch-crash) var(--hatch-gap) var(--hatch-line)), repeating-linear-gradient(135deg, transparent 0 var(--hatch-gap), var(--hatch-crash) var(--hatch-gap) var(--hatch-line)); }
.cell.s-skip { background-color: var(--skip-fill); background-image: radial-gradient(circle, var(--hatch-skip) 1px, transparent var(--dot-r)); background-size: var(--dot-pitch) var(--dot-pitch); }
.cell.s-todo { background: transparent; box-shadow: inset 0 0 0 var(--ring-thin) var(--todo); }
.cell.dim { opacity: var(--dim); }
button.cell:hover { outline: 1px solid var(--ink); outline-offset: 1px; }

.folders { width: 100%; border-collapse: collapse; }
.folders th { text-align: left; font-size: var(--t-xs); font-weight: 600; text-transform: uppercase; letter-spacing: var(--tracking); color: var(--ink-3); padding: var(--s-2) var(--s-3); border-bottom: 1px solid var(--line-strong); }
.folders td { padding: var(--s-2) var(--s-3); border-bottom: 1px solid var(--line); vertical-align: middle; }
.folders td.path { font-family: var(--mono); font-size: var(--t-sm); overflow-wrap: anywhere; }
.folders td.num, .folders th.num { text-align: right; white-space: nowrap; }
.folders .bar-cell { width: 34%; }
.bar { height: var(--bar-h); border-radius: 1px; background: hsl(var(--h, 210) var(--slice-s) var(--slice-l)); }
.bar.has-fail { background-color: var(--fail-fill); background-image: repeating-linear-gradient(135deg, transparent 0 var(--hatch-gap), var(--hatch-fail) var(--hatch-gap) var(--hatch-line)); }

.timeline { display: grid; grid-template-columns: auto minmax(0, 1fr); border-top: 1px solid var(--line); }
.lanes-labels { display: grid; grid-auto-rows: var(--lane-h); border-right: 1px solid var(--line); }
.lanes-labels div { display: flex; align-items: center; padding: 0 var(--s-3) 0 0; color: var(--ink-2); font-size: var(--t-sm); white-space: nowrap; border-bottom: 1px solid var(--line); }
.lanes-labels .replaced { color: var(--ink-3); font-style: italic; }
.lanes-labels .busy { color: var(--ink-3); padding-left: var(--s-3); font-size: var(--t-xs); font-style: normal; }
.lanes-scroll { overflow-x: auto; }
.lanes-scroll svg { display: block; min-width: var(--chart-min); }
.lane-sep { stroke: var(--line); }
.t-slice { stroke: var(--bg); stroke-width: 1px; vector-effect: non-scaling-stroke; }
.t-slice:hover { stroke: var(--ink); }
.axis-text { fill: var(--ink-3); font-family: var(--font); font-size: var(--t-axis); }
.tick { stroke: var(--line); }
.table-wrap { max-height: var(--table-max); overflow: auto; border: 1px solid var(--line); border-radius: var(--r-field); margin-top: var(--s-4); }
.table-wrap .icon { display: inline-block; vertical-align: middle; margin-right: var(--s-2); }
.table-wrap table { width: 100%; border-collapse: collapse; font-size: var(--t-sm); }
.table-wrap th { position: sticky; top: 0; background: var(--panel); text-align: left; padding: var(--s-2) var(--s-3); border-bottom: 1px solid var(--line-strong); }
.table-wrap td { padding: var(--s-1) var(--s-3); border-bottom: 1px solid var(--line); }

.empty { max-width: var(--measure); padding: var(--s-6) var(--s-5); }
.empty h2 { font-size: var(--t-lg); margin-bottom: var(--s-3); }
.empty p { color: var(--ink-2); margin-bottom: var(--s-3); }

@media (max-width: 640px) {
  .verdict { padding: var(--s-3); }
  .panel, .overview { padding-left: var(--s-3); padding-right: var(--s-3); }
  html { scroll-padding-top: 0; }
  .tabbar { position: static; flex-wrap: wrap; padding: 0; }
  .tabs { flex-wrap: wrap; }
  .tab { padding: var(--s-3); }
  .tabbar .where { order: 2; width: 100%; margin: 0; padding: 0 var(--s-3) var(--s-2); text-align: left; white-space: normal; }
  .ov-desc { flex-basis: 100%; order: 3; }
  .failure-body { padding-left: var(--s-2); }
  .folders .bar-cell, .folders .col-files { display: none; }
  .failure-ms { display: none; }
}
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
@media (forced-colors: active) {
  .inline-error, .failure-body pre { border: 1px solid CanvasText; }
  .cell, .bar, .slice, .t-slice { forced-color-adjust: none; }
  .bar { border: 1px solid CanvasText; background: GrayText; }
  .bar.has-fail { background: Highlight; }
  .cell { border: 1px solid CanvasText; background: CanvasText; }
  .cell.s-fail { border: var(--ring-thick) double CanvasText; background: Highlight; }
  .cell.s-crash { border: var(--ring-thick) solid CanvasText; background: Canvas; }
  .cell.s-skip { border: var(--ring) dotted CanvasText; background: Canvas; }
  .cell.s-todo { border: 1px solid GrayText; background: Canvas; box-shadow: none; }
  :focus-visible, button.cell:hover { outline-color: Highlight; }
  .lane-track { fill: Canvas; stroke: GrayText; stroke-width: 1px; }
  .slice, .t-slice { fill: GrayText; stroke: Canvas; stroke-width: 1px; }
  .slice.s-fail, .t-slice.s-fail { fill: Highlight; stroke: CanvasText; stroke-width: var(--ring); }
  .slice.s-crash, .t-slice.s-crash { fill: Canvas; stroke: CanvasText; stroke-width: var(--ring); stroke-dasharray: var(--dash); }
  .slice.s-skip, .t-slice.s-skip { fill: Canvas; stroke: GrayText; stroke-dasharray: var(--dash); }
  .slice.s-todo, .t-slice.s-todo { fill: Canvas; stroke: CanvasText; stroke-width: 1px; }
  .brush { fill: Highlight; stroke: Highlight; }
}
`
