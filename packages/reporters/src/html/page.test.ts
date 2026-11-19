// The report's page, run in jsdom with scripts on: what it draws for the fixture run equals the
// fixture, its keyboard works, a network request or a console error fails the test, and nothing in
// a test's title or a failure's text becomes markup.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type DOMWindow, JSDOM, requestInterceptor, VirtualConsole } from 'jsdom'
import { createReporterBus } from '../bus.ts'
import { htmlReporter } from './reporter.ts'
import { playSample, sampleClock } from './sample.ts'
import { reportFor, type TimedFile } from './test-support.ts'

/** A page that is loaded, with what went wrong while it loaded. */
interface Page {
  readonly window: DOMWindow
  readonly document: Document
  readonly errors: string[]
  readonly fetched: string[]
  /** Runs what the page scheduled with `setTimeout` (its search waits for a pause in typing). */
  readonly flush: () => void
}

/**
 * The document loaded with its script running, and every request or error recorded. The page's
 * timers are ours: a callback runs when a test calls `flush`, so no test waits in real time.
 */
function load(html: string): Page {
  const errors: string[] = []
  const fetched: string[] = []
  const pending = new Map<number, () => void>()
  let sequence = 0
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (error) => errors.push(error.stack ?? String(error)))
  virtualConsole.on('error', (...args) => errors.push(args.map(String).join(' ')))
  virtualConsole.on('warn', (...args) => errors.push(args.map(String).join(' ')))
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    // Resource loading is on, so any request the page makes reaches the interceptor, which refuses it.
    resources: {
      interceptors: [
        requestInterceptor((request) => {
          fetched.push(request.url)
          return new Response('refused', { status: 403 })
        }),
      ],
    },
    virtualConsole,
    beforeParse(window) {
      Reflect.set(window, 'setTimeout', (callback: () => void): number => {
        pending.set(++sequence, callback)
        return sequence
      })
      Reflect.set(window, 'clearTimeout', (handle: number): void => {
        pending.delete(handle)
      })
    },
  })
  return {
    window: dom.window,
    document: dom.window.document,
    errors,
    fetched,
    flush() {
      const callbacks = [...pending.values()]
      pending.clear()
      for (const callback of callbacks) callback()
    },
  }
}

/** Nothing was fetched and nothing was reported as an error. */
function assertClean(page: Page): void {
  assert.deepEqual(page.fetched, [], 'the page requested a resource')
  assert.deepEqual(page.errors, [], 'the page reported an error')
}

function all(page: Page, selector: string): HTMLElement[] {
  return [...page.document.querySelectorAll<HTMLElement>(selector)]
}

function one(page: Page, selector: string): HTMLElement {
  const found = page.document.querySelector<HTMLElement>(selector)
  assert.ok(found !== null, `no ${selector}`)
  return found
}

const text = (element: Element | null | undefined): string => element?.textContent?.trim() ?? ''

/** The file node of `path` (its `title` is the whole path). */
function fileNode(page: Page, path: string): HTMLElement {
  const label = all(page, '.node--file > .node__row > .node__label').find(
    (item) => item.title === path,
  )
  assert.ok(label !== undefined, `no file node for ${path}`)
  const item = label.closest<HTMLElement>('li')
  assert.ok(item !== null)
  return item
}

function press(page: Page, target: Element, key: string): void {
  target.dispatchEvent(
    new page.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  )
}

function click(page: Page, target: Element): void {
  target.dispatchEvent(new page.window.MouseEvent('click', { bubbles: true, cancelable: true }))
}

/** Types into the search box and lets the page's pause in typing end. */
function search(page: Page, query: string): void {
  const input = one(page, '#search') as unknown as HTMLInputElement
  input.value = query
  input.dispatchEvent(new page.window.Event('input', { bubbles: true }))
  page.flush()
}

/** The counts a summary stat shows, by kind. */
function counts(page: Page, stat: 'files' | 'tests'): Record<string, string> {
  const result: Record<string, string> = {}
  for (const item of all(page, `.summary__stat--${stat} .count`)) {
    const kind = [...item.classList].find((name) => name.startsWith('count--'))?.slice(7)
    if (kind !== undefined) result[kind] = text(item.querySelector('.count__number'))
  }
  return result
}

describe('the report page, on the fixture run', async () => {
  const { html } = await reportFor()

  it('draws the summary: verdict, file and test counts, time, workers and snapshots', () => {
    const page = load(html)
    assertClean(page)
    assert.equal(text(one(page, '.report__title')), 'Provino report: project')
    assert.equal(text(one(page, '.report__verdict-text')), 'Failed: 3 files and 2 tests failed')
    assert.ok(one(page, '.report__verdict').classList.contains('report__verdict--fail'))
    assert.deepEqual(counts(page, 'files'), { pass: '3', fail: '3', skip: '1', todo: '1' })
    assert.deepEqual(counts(page, 'tests'), { pass: '6', fail: '2', skip: '3', todo: '2' })
    assert.equal(text(one(page, '.summary__stat--duration .summary__value')), '40 ms')
    assert.equal(
      text(one(page, '.summary__stat--started .summary__value')),
      '2026-11-19 12:00:00 UTC',
    )
    assert.equal(text(one(page, '.summary__stat--workers .summary__value')), '3 used of 4')
    assert.match(
      text(one(page, '.summary__stat--snapshots .summary__value')),
      /^1 total: 0 matched, 1 failed/,
    )
  })

  it('draws the tree: failures open with their text, passing files folded, built as they open', () => {
    const page = load(html)
    const tree = one(page, '[role="tree"]')
    assert.equal(all(page, '.node--folder').length, 1)
    assert.equal(text(one(page, '.node--folder .node__label')), './')
    assert.equal(all(page, '.node--file').length, 8)
    assert.equal(tree.querySelectorAll('li[role="treeitem"]').length > 8, true)
    // A passing file is folded and has built nothing under it yet.
    const math = fileNode(page, 'math.test.ts')
    assert.equal(math.getAttribute('aria-expanded'), 'false')
    assert.equal(math.querySelectorAll('li').length, 0)
    // A failing file is open, down to the failed test and its text.
    const fails = fileNode(page, 'fails.test.ts')
    assert.equal(fails.getAttribute('aria-expanded'), 'true')
    const failure = fails.querySelector('pre.failure')
    assert.match(text(failure), /toBe\(expected\)/)
    assert.equal(fails.querySelectorAll('.node--suite').length, 1)
    assert.equal(fails.querySelectorAll('.node--test.node--fail').length, 1)
    assert.equal(fails.querySelectorAll('.node--test.node--pass').length, 1)
    // A file that failed to collect shows its own error.
    const broken = fileNode(page, 'broken.test.ts')
    assert.match(text(broken.querySelector('.node--error')), /Test suite failed to run/)
    assert.match(text(broken.querySelector('pre.failure')), /Cannot find module '\.\/missing\.ts'/)
    // Opening a passing file builds its top level, and opening a suite builds what is in it.
    click(page, math.querySelector('.node__row') as Element)
    assert.equal(math.getAttribute('aria-expanded'), 'true')
    const children = (item: Element): string[] =>
      [...item.querySelectorAll(':scope > .node__children > li')].map((child) =>
        text(child.querySelector('.node__label')),
      )
    assert.deepEqual(children(math), ['math', 'stands alone'])
    assert.equal(math.querySelectorAll('.node--test').length, 1)
    const suite = math.querySelector('.node--suite') as HTMLElement
    assert.equal(suite.getAttribute('aria-expanded'), 'false')
    click(page, suite.querySelector('.node__row') as Element)
    assert.deepEqual(children(suite), ['adds', 'nested'])
    click(
      page,
      (suite.querySelector('.node--suite') as HTMLElement).querySelector('.node__row') as Element,
    )
    assert.equal(math.querySelectorAll('.node--test').length, 3)
    assertClean(page)
  })

  it('names every node for assistive technology: role, level, state word and label', () => {
    const page = load(html)
    const fails = fileNode(page, 'fails.test.ts')
    assert.equal(fails.getAttribute('role'), 'treeitem')
    assert.equal(fails.getAttribute('aria-level'), '2')
    // The name is the row's text without what is hidden from assistive technology.
    const row = page.document.getElementById(fails.getAttribute('aria-labelledby') ?? '')
    const named = row?.cloneNode(true) as HTMLElement
    for (const hidden of named.querySelectorAll('[aria-hidden="true"]')) hidden.remove()
    assert.equal(text(named), 'failed fails.test.ts 2 tests · 1 failed · 9 ms')
    for (const glyph of all(page, '.node__glyph')) {
      assert.equal(glyph.getAttribute('aria-hidden'), 'true')
    }
    const tabs = one(page, '[role="tablist"]')
    assert.equal(tabs.querySelectorAll('[role="tab"]').length, 4)
    assert.equal(all(page, '[role="tab"][aria-selected="true"]').length, 1)
  })

  it('moves through the tree with the arrow keys', () => {
    const page = load(html)
    const folder = one(page, '.node--folder')
    assert.equal(folder.tabIndex, 0)
    folder.focus()
    press(page, folder, 'ArrowDown')
    const first = page.document.activeElement as HTMLElement
    assert.equal(first.getAttribute('aria-level'), '2')
    assert.equal(first.tabIndex, 0)
    assert.equal(folder.tabIndex, -1)
    // Right opens a folded file, and a second Right goes to its first child.
    const math = fileNode(page, 'math.test.ts')
    math.focus()
    press(page, math, 'ArrowRight')
    assert.equal(math.getAttribute('aria-expanded'), 'true')
    press(page, math, 'ArrowRight')
    assert.equal(page.document.activeElement, math.querySelector('li'))
    // Left goes back to the parent, and a second Left closes it.
    press(page, page.document.activeElement as Element, 'ArrowLeft')
    assert.equal(page.document.activeElement, math)
    press(page, math, 'ArrowLeft')
    assert.equal(math.getAttribute('aria-expanded'), 'false')
    // Enter toggles; End and Home go to the last and the first visible item.
    press(page, math, 'Enter')
    assert.equal(math.getAttribute('aria-expanded'), 'true')
    press(page, math, 'End')
    const items = all(page, 'li[role="treeitem"]').filter(
      (item) => item.parentElement?.closest('[hidden]') == null,
    )
    assert.equal(page.document.activeElement, items[items.length - 1])
    press(page, page.document.activeElement as Element, 'Home')
    assert.equal(page.document.activeElement, folder)
    assertClean(page)
  })

  it('narrows the tree by search, with a count for a screen reader, and by failures only', async () => {
    const page = load(html)
    search(page, 'math')
    assert.deepEqual(
      all(page, '.node--file > .node__row > .node__label').map((item) => item.title),
      ['math.test.ts'],
    )
    assert.equal(text(one(page, '.search__results')), '3 tests match “math” in 1 file')
    assert.equal(one(page, '.search__results').getAttribute('role'), 'status')
    assert.equal(fileNode(page, 'math.test.ts').getAttribute('aria-expanded'), 'true')
    // Every word must match, across the path and the titles.
    search(page, 'math nested')
    assert.equal(all(page, '.node--test').length, 1)
    search(page, 'no such test')
    assert.equal(all(page, '.node--file').length, 0)
    assert.equal(text(one(page, '.tree__empty')), 'Nothing matches.')
    // Cleared, the whole tree is back, folded as it was.
    search(page, '')
    assert.equal(all(page, '.node--file').length, 8)
    assert.equal(fileNode(page, 'math.test.ts').getAttribute('aria-expanded'), 'false')
    const only = one(page, '#failures-only') as unknown as HTMLInputElement
    only.checked = true
    only.dispatchEvent(new page.window.Event('change', { bubbles: true }))
    assert.equal(text(one(page, '.search__results')), '2 failed tests in 3 files')
    assert.deepEqual(
      all(page, '.node--file > .node__row > .node__label')
        .map((item) => item.title)
        .sort(),
      ['broken.test.ts', 'fails.test.ts', 'snapshot.test.ts'],
    )
    assertClean(page)
  })

  it('draws the status map: a cell per file with its status in text, and a click reaches the file', () => {
    const page = load(html)
    click(page, one(page, '#tab-map'))
    assert.equal(one(page, '#panel-map').hidden, false)
    assert.equal(one(page, '#panel-tests').hidden, true)
    const cells = all(page, '#panel-map button.cell')
    assert.equal(cells.length, 8)
    assert.equal(cells.filter((cell) => cell.classList.contains('cell--fail')).length, 3)
    assert.equal(cells.filter((cell) => cell.classList.contains('cell--pass')).length, 3)
    const fails = cells.find((cell) => cell.title.startsWith('fails.test.ts'))
    assert.equal(fails?.title, 'fails.test.ts: failed, 2 tests, 9 ms')
    assert.equal(fails?.getAttribute('aria-label'), fails?.title)
    assert.equal(text(fails), '✕')
    assert.equal(all(page, '#panel-map button.cell[tabindex="0"]').length, 1)
    // The arrow keys move between cells.
    cells[0]?.focus()
    press(page, cells[0] as Element, 'ArrowRight')
    assert.equal(page.document.activeElement, cells[1])
    // A click opens the tree at the file.
    click(page, fails as Element)
    assert.equal(one(page, '#tab-tests').getAttribute('aria-selected'), 'true')
    assert.equal(page.document.activeElement, fileNode(page, 'fails.test.ts'))
    assertClean(page)
  })

  it('draws time by folder as a table with the numbers in text', () => {
    const page = load(html)
    click(page, one(page, '#tab-folders'))
    const rows = all(page, '#panel-folders tbody tr')
    assert.equal(rows.length, 1)
    const cells = [...(rows[0] as HTMLElement).querySelectorAll('th, td')].map(text)
    // Folder, time (the files' times added: 12 + 9 + 3 + 1 + 1 + 6 + 7 + 2), share, bar, files, tests, failed.
    assert.deepEqual(cells, ['./', '41 ms', '100%', '', '8', '13', '2'])
    assert.equal(one(page, '.bar').getAttribute('aria-hidden'), 'true')
    assertClean(page)
  })

  it('draws the timeline: a row per worker, a titled rect per file, and the same data as a table', () => {
    const page = load(html)
    click(page, one(page, '#tab-timeline'))
    const rows = all(page, '.timeline__row')
    assert.deepEqual(
      rows.map((row) => text(row.querySelector('.timeline__worker'))),
      ['Worker 0', 'Worker 1', 'Worker 2'],
    )
    assert.deepEqual(
      rows.map((row) => row.querySelectorAll('rect').length),
      [3, 4, 1],
    )
    const titles = all(page, '.timeline__track rect > title').map(text)
    assert.equal(titles.length, 8)
    assert.ok(titles.includes('math.test.ts: passed, 12 ms (worker 0, 0 ms to 12 ms)'))
    assert.ok(titles.includes('broken.test.ts: failed, 2 ms (worker 2, 30 ms to 32 ms)'))
    assert.equal(all(page, '.timeline__track rect.rect--fail').length, 3)
    // The table is built when it is first shown, and is the same eight files.
    assert.equal(one(page, '.timeline__tablewrap').hidden, true)
    click(page, all(page, '.timeline__button')[1] as Element)
    assert.equal(one(page, '.timeline__tablewrap').hidden, false)
    assert.equal(one(page, '.timeline__chart').hidden, true)
    const lines = all(page, '.timeline__table tbody tr')
    assert.equal(lines.length, 8)
    assert.deepEqual([...(lines[0] as HTMLElement).querySelectorAll('td')].map(text), [
      '0',
      'math.test.ts',
      'passed',
      '0 ms',
      '12 ms',
      '12 ms',
      '10 ms',
    ])
    assert.equal(all(page, '.timeline__button[aria-pressed="true"]').length, 1)
    assertClean(page)
  })

  it('moves between the tabs with the arrow keys, Home and End', () => {
    const page = load(html)
    const tab = one(page, '#tab-tests')
    tab.focus()
    press(page, tab, 'ArrowRight')
    assert.equal(page.document.activeElement, one(page, '#tab-map'))
    assert.equal(one(page, '#tab-map').getAttribute('aria-selected'), 'true')
    assert.equal(one(page, '#tab-map').tabIndex, 0)
    assert.equal(one(page, '#tab-tests').tabIndex, -1)
    press(page, one(page, '#tab-map'), 'End')
    assert.equal(page.document.activeElement, one(page, '#tab-timeline'))
    press(page, one(page, '#tab-timeline'), 'ArrowRight')
    assert.equal(page.document.activeElement, one(page, '#tab-tests'))
    press(page, one(page, '#tab-tests'), 'ArrowLeft')
    assert.equal(page.document.activeElement, one(page, '#tab-timeline'))
    assert.equal(one(page, '#panel-timeline').getAttribute('aria-labelledby'), 'tab-timeline')
    assertClean(page)
  })
})

describe('the report page, on other runs', () => {
  it('draws a run with no files as a short message and no tabs', async () => {
    const clock = sampleClock()
    const dir = await import('node:fs/promises').then(({ mkdtemp }) =>
      mkdtemp(`${process.env.TMPDIR ?? '/tmp'}/provino-html-empty-`),
    )
    const outputFile = `${dir}/report.html`
    const bus = createReporterBus([htmlReporter({ outputFile, root: '/project', now: clock.now })])
    await playSample(bus, 'empty', clock)
    const { readFile, rm } = await import('node:fs/promises')
    const page = load(await readFile(outputFile, 'utf8'))
    await rm(dir, { recursive: true, force: true })
    assertClean(page)
    assert.equal(text(one(page, '.report__verdict-text')), 'No test files ran')
    assert.match(text(one(page, '.empty')), /No test files ran/)
    assert.equal(all(page, '[role="tablist"]').length, 0)
  })

  it('never turns a title, a path or a failure into markup', async () => {
    const evil = '<img src=x onerror="window.pwned = 1"></script><script>window.pwned = 2</script>'
    const files: TimedFile[] = [
      {
        spec: {
          path: `src/${evil}/a.test.ts`,
          tests: [
            { path: [evil, evil], state: 'fail', errors: [{ name: 'Error', message: evil }] },
          ],
        },
        workerId: 0,
        startMs: 0,
        endMs: 5,
      },
    ]
    const { html } = await reportFor(files)
    // The data's `<` is escaped, so the only script elements are the two the document has.
    assert.equal(html.split('<script').length - 1, 2)
    const page = load(html)
    assertClean(page)
    assert.equal(Reflect.get(page.window, 'pwned'), undefined)
    assert.equal(all(page, 'img').length, 0)
    assert.equal(all(page, 'script').length, 2)
    assert.equal(text(one(page, '.node--test .node__label')), evil)
    assert.ok(text(one(page, 'pre.failure')).includes(evil))
  })

  for (const state of ['all-passed', 'failures', 'crashed'] as const) {
    it(`draws the ${state} sample run: 500 files, every view`, async () => {
      const clock = sampleClock()
      const { mkdtemp, readFile, rm } = await import('node:fs/promises')
      const dir = await mkdtemp(`${process.env.TMPDIR ?? '/tmp'}/provino-html-${state}-`)
      const outputFile = `${dir}/report.html`
      const bus = createReporterBus([
        htmlReporter({ outputFile, root: '/project', now: clock.now }),
      ])
      await playSample(bus, state, clock)
      assert.deepEqual(bus.failures(), [])
      const page = load(await readFile(outputFile, 'utf8'))
      await rm(dir, { recursive: true, force: true })
      assert.equal(Object.values(counts(page, 'files')).length >= 1, true)
      const failed = state !== 'all-passed'
      assert.equal(all(page, '.node--folder').length, 12)
      assert.equal(all(page, '.node--folder.node--fail').length > 0, failed)
      assert.equal(all(page, 'pre.failure').length > 0, failed)
      for (const id of ['map', 'folders', 'timeline']) click(page, one(page, `#tab-${id}`))
      assert.equal(
        all(page, '#panel-map button.cell').length,
        state === 'all-passed' ? 500 : state === 'failures' ? 502 : 503,
      )
      assert.equal(all(page, '.timeline__row').length, state === 'crashed' ? 9 : 8)
      assert.equal(all(page, '.node--crash').length, state === 'crashed' ? 1 : 0)
      if (state === 'crashed') {
        assert.equal(all(page, '#panel-map button.cell--crash').length, 1)
        click(page, one(page, '#panel-map button.cell--crash'))
        assert.equal(
          fileNode(page, 'src/api/native-addon.test.ts').getAttribute('aria-expanded'),
          'true',
        )
        assert.match(
          text(fileNode(page, 'src/api/native-addon.test.ts').querySelector('pre.failure')),
          /SIGSEGV/,
        )
        assert.equal(
          text(page.document.querySelector('.summary__stat--run-errors .summary__value')),
          '1',
        )
      }
      assertClean(page)
    })
  }
})
