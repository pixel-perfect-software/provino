import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import type { ReportData } from './data.ts'
import { contentSecurityPolicy, DATA_ID, escapeHtml, pageScript, renderDocument } from './render.ts'

const DATA: ReportData = {
  version: 1,
  title: 'project',
  root: '/project',
  startedAt: '2026-11-19T12:00:00.000Z',
  durationMs: 10,
  reason: 'passed',
  workers: 1,
  strings: ['a.test.ts', 'adds', ''],
  files: [[0, 0, 1, 0, 0, 1, -1, 2]],
  tests: [[0, [1], 0, 1]],
  failures: [],
  fileErrors: [],
  runErrors: [],
  omitted: 0,
}

/** The text of the document's executable script: the `<script>` with no `type`. */
function executableScript(html: string): string {
  const found = /<script>([\s\S]*?)<\/script>/.exec(html)
  assert.ok(found?.[1] !== undefined, 'the document has no executable script')
  return found[1]
}

describe('the report document', () => {
  const html = renderDocument(DATA)

  it('pins its one script by the SHA-256 of its text, and allows nothing else', () => {
    const script = executableScript(html)
    const hash = createHash('sha256').update(script).digest('base64')
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html)
    assert.equal(
      meta?.[1],
      `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${hash}'; img-src data:`,
    )
    assert.equal(contentSecurityPolicy(script), meta?.[1])
    // The CSP meta comes before any script, so it is in force when the script is parsed.
    assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<script'))
    // Exactly one script runs; the data is inert JSON.
    assert.equal(html.split('<script').length - 1, 2)
    assert.match(html, new RegExp(`<script type="application/json" id="${DATA_ID}">`))
  })

  it('makes no request: no external URL anywhere, no resource element, no import or fetch', () => {
    assert.doesNotMatch(html, /https?:/i)
    assert.equal(html.includes('//'), false)
    assert.doesNotMatch(html, /<(?:link|img|iframe|frame|embed|object|audio|video|source|base)\b/i)
    assert.doesNotMatch(html, /\s(?:src|href|action|poster|srcset)\s*=/i)
    assert.doesNotMatch(html, /@import|url\(\s*["']?(?!#)/i)
    assert.doesNotMatch(
      executableScript(html),
      /\b(?:fetch|XMLHttpRequest|WebSocket|sendBeacon|importScripts|import)\b\s*\(/,
    )
  })

  it('is one file: a complete document with its styles, data and script inside', () => {
    assert.match(html, /^<!doctype html>\n<html lang="en">/)
    assert.equal(html.split('<html').length - 1, 1)
    assert.equal(html.split('<style>').length - 1, 1)
    assert.ok(html.endsWith('</html>\n'))
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/)
    assert.equal(renderDocument(DATA), html)
  })

  it('writes renderReport as the page script, called on the parsed data', () => {
    const script = pageScript()
    assert.ok(script.startsWith('(function'))
    assert.ok(script.endsWith(`)(JSON.parse(document.getElementById("${DATA_ID}").textContent))`))
    assert.doesNotMatch(script, /<\/script|<!--/i)
    // No blank line, no comment line and no trailing space, which the document drops.
    assert.doesNotMatch(script, /\n\s*\n|^\s*\/\/|[ \t]\n/m)
  })

  it('escapes the title in the head, whatever it holds', () => {
    const doc = renderDocument({ ...DATA, title: '<b>"x" & y</b>' })
    assert.match(doc, /<title>Provino report: &lt;b&gt;&quot;x&quot; &amp; y&lt;\/b&gt;<\/title>/)
    assert.equal(escapeHtml(`<>&"`), '&lt;&gt;&amp;&quot;')
  })
})
