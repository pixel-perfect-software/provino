import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import type { ReportData } from './data.ts'
import { renderReport } from './page/main.ts'
import { contentSecurityPolicy, DATA_ID, escapeHtml, pageScript, renderDocument } from './render.ts'

const DATA: ReportData = {
  version: 1,
  title: 'project',
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

/**
 * The template literals in `source` whose own text (not the code in a `${…}`) spans lines. A small
 * scanner: it skips strings, comments and regular expression literals, and follows `${…}`. A `/`
 * after a word, a number or a closing bracket is division; after anything else it opens a regular
 * expression.
 */
function multiLineTemplates(source: string): string[] {
  const found: string[] = []
  // What is open: a template (with the text it has so far) or a `${` (with the braces opened in it).
  const stack: (
    | { kind: 'template'; from: number; text: string }
    | { kind: 'code'; depth: number }
  )[] = []
  let previous = ''
  let at = 0
  const closeTemplate = (): void => {
    const top = stack.pop()
    if (top?.kind === 'template' && top.text.includes('\n')) {
      found.push(source.slice(top.from, at + 1))
    }
  }
  while (at < source.length) {
    const char = source[at] as string
    const top = stack.at(-1)
    if (top?.kind === 'template') {
      if (char === '\\') {
        top.text += source.slice(at, at + 2)
        at += 2
        continue
      }
      if (char === '`') {
        closeTemplate()
        previous = '`'
      } else if (char === '$' && source[at + 1] === '{') {
        stack.push({ kind: 'code', depth: 0 })
        at += 1
      } else {
        top.text += char
      }
      at += 1
      continue
    }
    if (char === '"' || char === "'") {
      at += 1
      while (at < source.length && source[at] !== char) at += source[at] === '\\' ? 2 : 1
      previous = char
    } else if (char === '`') {
      stack.push({ kind: 'template', from: at, text: '' })
    } else if (char === '/' && source[at + 1] === '/') {
      while (at < source.length && source[at] !== '\n') at += 1
      continue
    } else if (char === '/' && source[at + 1] === '*') {
      at = source.indexOf('*/', at + 2) + 1
      if (at === 0) break
    } else if (char === '/' && !/[\w)\]]/.test(previous)) {
      // A regular expression literal: to the next `/` outside a class.
      let inClass = false
      at += 1
      while (at < source.length && (inClass || source[at] !== '/')) {
        if (source[at] === '\\') at += 1
        else if (source[at] === '[') inClass = true
        else if (source[at] === ']') inClass = false
        at += 1
      }
      previous = '/'
    } else if (char === '{' && top?.kind === 'code') {
      top.depth += 1
      previous = char
    } else if (char === '}' && top?.kind === 'code') {
      if (top.depth === 0) stack.pop()
      else top.depth -= 1
      previous = char
    } else if (!/\s/.test(char)) {
      previous = char
    }
    at += 1
  }
  return found
}

/** The start of an interpolation, kept apart so no string of the test holds it. */
const OPEN = ['$', '{'].join('')

/** Source text from its parts. */
const source = (...parts: string[]): string => parts.join('')

describe('the page script’s source', () => {
  it('has no template literal that spans lines, which `pageScript` would rewrite', () => {
    // The scanner first: it sees a literal across lines, wherever it sits, and only that.
    assert.deepEqual(multiLineTemplates(source('const a = `one line ', OPEN, '1 + 1}`')), [])
    assert.equal(multiLineTemplates('const a = `two\nlines`').length, 1)
    assert.equal(multiLineTemplates(source('f(`', OPEN, 'g(`inner\ntext`)}`)')).length, 1)
    assert.equal(
      multiLineTemplates(source('const a = `', OPEN, '\n  b\n}`')).length,
      0,
      'code in an interpolation may span lines',
    )
    assert.deepEqual(
      multiLineTemplates('const a = \'`\'\nconst b = "`"\n// `\nconst c = /[`]/'),
      [],
    )
    assert.deepEqual(multiLineTemplates('const r = /\\//.test(x) // `a\nb`\nconst q = a / b'), [])
    // Then the script: its source holds none, so the whitespace `pageScript` drops is code's.
    const script = renderReport.toString()
    assert.deepEqual(multiLineTemplates(script), [])
    // And it was in step to the end of it: a literal added after the whole source is found.
    assert.equal(multiLineTemplates(`${script}\nconst added = \`a\nb\``).length, 1)
  })
})
