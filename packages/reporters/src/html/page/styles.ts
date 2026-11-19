// The report's stylesheet, as a string (`render.ts` writes it into a `<style>`; the CSP allows
// inline styles and nothing external). Deliberately plain and structural: a design pass replaces
// the look by changing the custom properties on `:root` (light) and under
// `prefers-color-scheme: dark` (dark), and the rules below, never the markup.
//
// Every colour, font size and spacing value is a custom property. The markup's class names are
// stable hooks, one block per view and one element class per kind of thing:
//   report, report__header, report__title, report__verdict (--pass --fail --empty)
//   summary, summary__stat, summary__term, summary__value, count (--pass --fail --skip --todo --crash --notrun)
//   tabs, tab, panels, panel, search, search__input, search__checkbox, search__results
//   tree, node (--folder --file --suite --test --error; --pass --fail --skip --todo --crash --notrun),
//     node__row, node__toggle, node__status, node__glyph, node__label, node__meta,
//     node__children, node__detail, failure, tree__note, tree__empty
//   legend, legend__item, map__folder, map__title, map__cells, cell (--pass --fail --skip --todo --crash)
//   table-wrap, folders (and folders__*), bar, bar__fill (its width is `--share`, a percentage)
//   timeline, timeline__row, timeline__label, timeline__track, rect (--pass --fail --skip --todo
//     --crash), timeline__axis, timeline__switch, timeline__button, timeline__table, hatch__*
//   sr-only (text for assistive technology only)

/** The light and dark colour tokens, as the rules `STYLES` has them. Read by `styles.test.ts`. */
export const LIGHT_COLOURS: string = `
  --bg: #ffffff;
  --surface: #f6f8fa;
  --text: #1f2328;
  --text-muted: #57606a;
  --border: #6e7781;
  --rule: #d0d7de;
  --pass: #1a7f37;
  --fail: #cf222e;
  --skip: #7d4e00;
  --todo: #6639ba;
  --crash: #a64b00;
  --accent: #0969da;
  --focus: #0969da;
  --bar: #0969da;`

/** The dark values of the same tokens. */
export const DARK_COLOURS: string = `
    --bg: #0d1117;
    --surface: #161b22;
    --text: #e6edf3;
    --text-muted: #9198a1;
    --border: #7d8590;
    --rule: #30363d;
    --pass: #3fb950;
    --fail: #ff7b72;
    --skip: #d29922;
    --todo: #bc8cff;
    --crash: #ffa657;
    --accent: #58a6ff;
    --focus: #58a6ff;
    --bar: #58a6ff;`

/** The stylesheet. */
export const STYLES: string = `
:root {
  color-scheme: light dark;
  --font-body: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  --text-xs: 0.75rem;
  --text-sm: 0.875rem;
  --text-md: 1rem;
  --text-lg: 1.25rem;
  --text-xl: 1.5rem;
  --leading: 1.5;
  --weight-strong: 600;
  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-5: 1.5rem;
  --space-6: 2rem;
  --indent: 1.25rem;
  --radius: 0.375rem;
  --border-width: 1px;
  --focus-width: 2px;
  --accent-width: 4px;
  --page-width: 80rem;
  --stat-min: 14rem;
  --search-min: 16rem;
  --cell-size: 1.75rem;
  --bar-width: 8rem;
  --bar-height: 0.75rem;
  --track-height: 1.5rem;
  --label-width: 9rem;
  --toggle-width: 1em;
  --status-width: 1.25em;${LIGHT_COLOURS}
}
@media (prefers-color-scheme: dark) {
  :root {${DARK_COLOURS}
  }
}
*, *::before, *::after { box-sizing: border-box; }
html { font-size: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-body);
  font-size: var(--text-md);
  line-height: var(--leading);
}
a { color: var(--accent); }
button, input { font: inherit; color: inherit; }
:focus-visible { outline: var(--focus-width) solid var(--focus); outline-offset: var(--focus-width); }
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
.report { max-width: var(--page-width); margin: 0 auto; padding: var(--space-4); }
.report__noscript { color: var(--text-muted); }
.report__title { margin: 0 0 var(--space-2); font-size: var(--text-xl); overflow-wrap: anywhere; }
.report__verdict { margin: 0 0 var(--space-4); font-size: var(--text-lg); font-weight: var(--weight-strong); }
.report__verdict--pass { color: var(--pass); }
.report__verdict--fail { color: var(--fail); }
.report__verdict--empty { color: var(--text-muted); }
.summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(var(--stat-min), 100%), 1fr));
  gap: var(--space-3);
  margin: 0 0 var(--space-5);
}
.summary__stat { margin: 0; padding: var(--space-3); background: var(--surface); border: var(--border-width) solid var(--rule); border-radius: var(--radius); }
.summary__term { color: var(--text-muted); font-size: var(--text-sm); }
.summary__value { margin: 0; font-size: var(--text-md); overflow-wrap: anywhere; }
.count { display: inline-block; margin-right: var(--space-3); white-space: nowrap; }
.count__glyph { margin-right: var(--space-1); font-weight: var(--weight-strong); }
.count--pass { color: var(--pass); }
.count--fail { color: var(--fail); }
.count--skip { color: var(--skip); }
.count--todo { color: var(--todo); }
.count--crash { color: var(--crash); }
.count--notrun { color: var(--text-muted); }
.empty { color: var(--text-muted); }
.tabs { display: flex; flex-wrap: wrap; gap: var(--space-1); border-bottom: var(--border-width) solid var(--border); }
.tab {
  padding: var(--space-2) var(--space-4);
  background: transparent;
  border: var(--border-width) solid transparent;
  border-radius: var(--radius) var(--radius) 0 0;
  cursor: pointer;
}
.tab:hover { background: var(--surface); }
.tab[aria-selected="true"] {
  background: var(--surface);
  border-color: var(--border);
  border-bottom-color: var(--surface);
  font-weight: var(--weight-strong);
  text-decoration: underline;
  text-decoration-thickness: var(--accent-width);
  text-underline-offset: var(--space-1);
}
.panel { padding: var(--space-4) 0; }
.search { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); margin: 0 0 var(--space-2); }
.search__label { font-weight: var(--weight-strong); }
.search__input {
  flex: 1 1 var(--search-min);
  min-width: 0;
  padding: var(--space-2) var(--space-3);
  background: var(--bg);
  border: var(--border-width) solid var(--border);
  border-radius: var(--radius);
}
.search__check { white-space: nowrap; }
.search__results, .tree__note { margin: 0 0 var(--space-2); color: var(--text-muted); font-size: var(--text-sm); }
.tree, .node__children { margin: 0; padding: 0; list-style: none; }
.node__children { padding-left: var(--indent); }
.node:focus { outline: none; }
.node:focus-visible > .node__row { outline: var(--focus-width) solid var(--focus); outline-offset: calc(var(--focus-width) * -1); }
.node__row {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius);
  cursor: pointer;
}
.node__row:hover { background: var(--surface); }
.node__toggle { flex: none; width: var(--toggle-width); color: var(--text-muted); text-align: center; }
.node[aria-expanded="true"] > .node__row > .node__toggle { transform: rotate(90deg); }
.node__status { flex: none; width: var(--status-width); text-align: center; font-weight: var(--weight-strong); }
.node--pass > .node__row .node__glyph { color: var(--pass); }
.node--fail > .node__row .node__glyph { color: var(--fail); }
.node--skip > .node__row .node__glyph { color: var(--skip); }
.node--todo > .node__row .node__glyph { color: var(--todo); }
.node--crash > .node__row .node__glyph { color: var(--crash); }
.node--notrun > .node__row .node__glyph { color: var(--text-muted); }
.node__label { min-width: 0; overflow-wrap: anywhere; }
.node--folder > .node__row .node__label { font-weight: var(--weight-strong); }
.node--file > .node__row .node__label { font-family: var(--font-mono); font-size: var(--text-sm); }
.node__meta { flex: none; margin-left: auto; color: var(--text-muted); font-size: var(--text-sm); text-align: right; }
.node__detail { margin: var(--space-1) 0 var(--space-3) var(--indent); }
.failure {
  margin: 0;
  padding: var(--space-3);
  background: var(--surface);
  border: var(--border-width) solid var(--rule);
  border-left: var(--accent-width) solid var(--fail);
  border-radius: var(--radius);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.tree__empty { padding: var(--space-3); color: var(--text-muted); list-style: none; }
.legend { display: flex; flex-wrap: wrap; gap: var(--space-4); margin: 0 0 var(--space-4); padding: 0; list-style: none; }
.legend__item { display: inline-flex; align-items: center; gap: var(--space-1); }
.map__folder { margin: 0 0 var(--space-4); }
.map__title { margin: 0 0 var(--space-2); font-size: var(--text-md); overflow-wrap: anywhere; }
.map__cells { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.cell {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--cell-size);
  height: var(--cell-size);
  padding: 0;
  background: var(--bg);
  border: var(--border-width) solid currentColor;
  border-radius: var(--radius);
  font-size: var(--text-sm);
  font-weight: var(--weight-strong);
  cursor: pointer;
}
.cell--legend { cursor: default; }
.cell--pass { color: var(--pass); }
.cell--fail { color: var(--fail); background: var(--surface); }
.cell--skip { color: var(--skip); }
.cell--todo { color: var(--todo); }
.cell--crash { color: var(--crash); background: var(--surface); }
.table-wrap { overflow-x: auto; }
.folders, .timeline__table { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
.folders__caption, .timeline__caption { padding: var(--space-2) 0; color: var(--text-muted); text-align: left; }
.folders th, .folders td, .timeline__table th, .timeline__table td {
  padding: var(--space-2) var(--space-3);
  border-bottom: var(--border-width) solid var(--rule);
  text-align: left;
  vertical-align: baseline;
}
.folders__name, .timeline__path { overflow-wrap: anywhere; }
.folders__time, .folders__share, .folders__files, .folders__tests, .folders__failed { white-space: nowrap; font-variant-numeric: tabular-nums; }
.folders__row--fail .folders__failed { color: var(--fail); font-weight: var(--weight-strong); }
.bar { display: block; width: var(--bar-width); height: var(--bar-height); background: var(--rule); border-radius: var(--radius); overflow: hidden; }
.bar__fill { display: block; height: 100%; width: calc(var(--share, 0) * 1%); background: var(--bar); }
.folders__more, .timeline__button {
  margin: var(--space-3) var(--space-2) 0 0;
  padding: var(--space-2) var(--space-4);
  background: var(--surface);
  border: var(--border-width) solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
}
.timeline__button[aria-pressed="true"] { border-color: var(--accent); font-weight: var(--weight-strong); text-decoration: underline; text-underline-offset: var(--space-1); }
.timeline__summary, .timeline__note { margin: 0 0 var(--space-2); color: var(--text-muted); font-size: var(--text-sm); }
.timeline__switch { margin: 0 0 var(--space-3); }
.timeline__defs { position: absolute; }
.timeline__row { display: grid; grid-template-columns: minmax(0, var(--label-width)) minmax(0, 1fr); align-items: center; gap: var(--space-2); margin: 0 0 var(--space-1); }
.timeline__label { font-size: var(--text-sm); overflow-wrap: anywhere; }
.timeline__busy { color: var(--text-muted); font-size: var(--text-xs); }
.timeline__track { display: block; width: 100%; height: var(--track-height); background: var(--surface); border: var(--border-width) solid var(--rule); }
.rect { stroke: var(--border); stroke-width: 1; vector-effect: non-scaling-stroke; }
.rect--pass { fill: var(--pass); }
.rect--skip { fill: var(--skip); }
.rect--todo { fill: var(--todo); }
.rect--fail { fill: url(#hatch-fail); stroke: var(--fail); }
.rect--crash { fill: url(#hatch-crash); stroke: var(--crash); }
.hatch__back { fill: var(--bg); }
.hatch__line--fail { fill: var(--fail); }
.hatch__line--crash { fill: var(--crash); }
.timeline__axis { display: flex; justify-content: space-between; margin: var(--space-1) 0 0 calc(var(--label-width) + var(--space-2)); color: var(--text-muted); font-size: var(--text-xs); }
@media (max-width: 40rem) {
  .timeline__row { grid-template-columns: minmax(0, 1fr); }
  .timeline__axis { margin-left: 0; }
  .node__row { flex-wrap: wrap; }
  .node__meta { margin-left: 0; text-align: left; }
}
@media (forced-colors: active) {
  .cell, .bar, .failure { border: var(--border-width) solid CanvasText; }
  .bar__fill { background: Highlight; }
  .rect { stroke: CanvasText; }
}
`
