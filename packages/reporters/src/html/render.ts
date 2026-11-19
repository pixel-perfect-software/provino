// The report as one HTML document: the styles, the data as an inert JSON script and the page's own
// script, pinned by a Content-Security-Policy hash so nothing else can run and nothing can be
// fetched. Pure: it returns the text.

import { createHash } from 'node:crypto'
import { serializeData } from './data.ts'
import { renderReport } from './page/main.ts'
import type { ReportData } from './page/model.ts'
import { STYLES } from './page/styles.ts'

/** The id of the `<script type="application/json">` that holds the data. */
export const DATA_ID = 'provino-data'

/** Text for an HTML text node or a double-quoted attribute value. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * The page script's text: `renderReport` as `Function.prototype.toString()` has it (types already
 * erased, whether by Node's type stripping or by the build), called on the parsed data. Comment
 * lines go, lines lose their indentation and their trailing spaces (where a stripped type was)
 * and blank lines go;
 * `renderReport` has no multi-line template literal and no comment after code, which this would
 * change. Throws if the text could end its own `<script>` element.
 * @internal
 */
export function pageScript(): string {
  const body = renderReport
    .toString()
    .replaceAll('\r', '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/^[ \t]+/gm, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{2,}/g, '\n')
  const script = `(${body})(JSON.parse(document.getElementById(${JSON.stringify(DATA_ID)}).textContent))`
  if (/<\/script|<!--/i.test(script)) {
    throw new Error('the page script holds text that would end its <script> element')
  }
  return script
}

/**
 * The `Content-Security-Policy` of the document: nothing may load (`default-src 'none'`), styles
 * may be inline, and the one script that may run is the one whose SHA-256 is `scriptHash`.
 * @internal
 */
export function contentSecurityPolicy(script: string): string {
  const hash = createHash('sha256').update(script).digest('base64')
  return `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${hash}'; img-src data:`
}

/**
 * The report's document for `data`.
 * @internal
 */
export function renderDocument(data: ReportData): string {
  const script = pageScript()
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(contentSecurityPolicy(script))}">`,
    `<title>${escapeHtml(`Provino report: ${data.title}`)}</title>`,
    `<style>${STYLES}</style>`,
    '</head>',
    '<body>',
    '<div id="report"><p class="report__noscript">This report needs JavaScript to draw itself. It makes no network requests.</p></div>',
    `<script type="application/json" id="${DATA_ID}">${serializeData(data)}</script>`,
    `<script>${script}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n')
}
