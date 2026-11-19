// The report's page, run in jsdom with scripts on: what it draws for the fixture run equals the
// fixture, its keyboard works, a network request or a console error fails the test, and nothing in
// a test's title or a failure's text becomes markup.

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { type DOMWindow, JSDOM, requestInterceptor, VirtualConsole } from 'jsdom'
import { createReporterBus } from '../bus.ts'
import { htmlReporter } from './reporter.ts'
import { playSample, type SampleState, sampleClock } from './sample.ts'
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

/** What assistive technology reads of `element`: its text without what is hidden, its children's text apart. */
function nameOf(element: Element | null): string {
  assert.ok(element !== null)
  const copy = element.cloneNode(true) as HTMLElement
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove()
  return [...copy.children]
    .map((child) => child.textContent?.trim() ?? '')
    .filter((part) => part !== '')
    .join(' ')
}

/** The tree item of the file at `path` (its label's `title` is the whole path). */
function fileItem(page: Page, path: string): HTMLElement {
  const label = all(page, '.node.k-file .label').find((item) => item.title === path)
  assert.ok(label !== undefined, `no file item for ${path}`)
  const item = label.closest<HTMLElement>('.treeitem')
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

function pointer(page: Page, target: Element, type: string, clientX: number): void {
  target.dispatchEvent(
    new page.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX }),
  )
}

/** Types into the search box and lets the page's pause in typing end. */
function search(page: Page, query: string): void {
  const input = one(page, '#search') as unknown as HTMLInputElement
  input.value = query
  input.dispatchEvent(new page.window.Event('input', { bubbles: true }))
  page.flush()
}

/** The verdict's field values by name. */
function fields(page: Page): Record<string, string> {
  const result: Record<string, string> = {}
  for (const box of all(page, '.fields > div'))
    result[text(box.querySelector('dt'))] = text(box.querySelector('dd'))
  return result
}

/** The headline without its glyph. */
function headline(page: Page): string {
  const copy = one(page, '.verdict h1').cloneNode(true) as HTMLElement
  for (const glyph of copy.querySelectorAll('.glyph')) glyph.remove()
  return text(copy)
}

/** Opens the tab named `name` and returns its panel. */
function open(page: Page, name: string): HTMLElement {
  const tab = all(page, '[role="tab"]').find((item) => item.firstChild?.textContent === name)
  assert.ok(tab !== undefined, `no tab ${name}`)
  click(page, tab)
  return one(page, `#${tab.getAttribute('aria-controls')}`)
}

/** Fills the range form and submits it. */
function applyRange(page: Page, from: string, to: string): void {
  click(page, one(page, '.range button[aria-controls="range-form"]'))
  ;(one(page, '#range-from') as unknown as HTMLInputElement).value = from
  ;(one(page, '#range-to') as unknown as HTMLInputElement).value = to
  one(page, '#range-form').dispatchEvent(
    new page.window.Event('submit', { bubbles: true, cancelable: true }),
  )
}

describe('the report page, on the fixture run', async () => {
  const { html } = await reportFor()

  it('draws the verdict bar in one row: the headline, then the fixed fields, with the run’s place', () => {
    const page = load(html)
    assertClean(page)
    assert.equal(headline(page), '2 tests failed in 2 files · 1 file failed to run')
    assert.equal(text(one(page, '.verdict .glyph')), '💥')
    assert.equal(one(page, '.verdict .glyph').getAttribute('aria-hidden'), 'true')
    assert.ok(one(page, '.verdict').classList.contains('is-fail'))
    // On a failing run Failed comes before Passed; Skipped and Todo are always there.
    assert.deepEqual(all(page, '.fields dt').map(text), [
      'Failed',
      'Passed',
      'Skipped',
      'Todo',
      'Files',
      'Time',
      'Workers',
      'Snapshots',
    ])
    assert.deepEqual(fields(page), {
      Failed: '2',
      Passed: '6',
      Skipped: '3',
      Todo: '2',
      Files: '8',
      Time: '40 ms',
      Workers: '3',
      Snapshots: '1 failed',
    })
    assert.ok(one(page, '.fields .n-fail'))
    // Where and when, in the tab bar, with no label for a run that is real.
    assert.equal(text(one(page, '.tabbar .where code')), '/project')
    assert.equal(text(one(page, '.tabbar .where')), '/project · 2026-11-19 12:00 UTC')
    assert.equal(all(page, '.synthetic').length, 0)
  })

  it('stacks the verdict, the run overview, the tab bar and the open panel; the first failure is open', () => {
    const page = load(html)
    const shell = one(page, '#report > div')
    assert.deepEqual(
      [...shell.children].map(
        (child) => (child.getAttribute('class') ?? '').split(' ')[0] || child.tagName.toLowerCase(),
      ),
      ['sprite', 'verdict', 'overview', 'tabbar', 'panel', 'panel', 'panel', 'panel', 'panel'],
    )
    assert.deepEqual(
      all(page, '[role="tab"]').map((tab) => tab.firstChild?.textContent),
      ['Failures', 'Tests', 'Map', 'Folders', 'Timeline'],
    )
    assert.deepEqual(all(page, '[role="tab"] .count').map(text), ['3', '13', '8', '1', '3'])
    assert.ok(one(page, '[role="tab"] .count').classList.contains('n-fail'))
    // Failures opens first on a failing run, and nothing else is built yet.
    assert.equal(one(page, '#tab-0').getAttribute('aria-selected'), 'true')
    assert.equal(one(page, '#panel-0').hidden, false)
    assert.equal(all(page, '.panel[hidden]').length, 4)
    assert.equal(one(page, '#panel-1').childElementCount, 0)
    assertClean(page)
  })

  it('lists a row for each failed test and each file that failed on its own, the first expanded', () => {
    const page = load(html)
    const rows = all(page, '.failure')
    assert.equal(rows.length, 3)
    const heads = all(page, '.failure-head')
    assert.deepEqual(
      heads.map((head) => head.getAttribute('aria-expanded')),
      ['true', 'false', 'false'],
    )
    // The file that failed to collect, then the two failed tests, in folder and path order.
    assert.deepEqual(
      heads.map((head) => text(head.querySelector('.failure-file'))),
      ['broken.test.ts', 'fails.test.ts', 'snapshot.test.ts'],
    )
    assert.equal(
      text(heads[0]?.querySelector('.failure-title')),
      'failed: The file failed to finish',
    )
    assert.equal(text(heads[0]?.querySelector('.failure-ms')), 'failed')
    assert.equal(text(heads[1]?.querySelector('.failure-title')), 'failed: group›fails')
    assert.equal(text(heads[1]?.querySelector('.failure-ms')), '4 ms')
    assert.match(text(heads[1]?.querySelector('.failure-first')), /toBe\(expected\)/)
    // The open row has the code frame, coloured by line kind, and the two links.
    const body = one(page, '#fb-0')
    assert.equal(body.hidden, false)
    assert.match(text(body.querySelector('pre')), /Cannot find module '\.\/missing\.ts'/)
    assert.ok(body.querySelector('pre .hl'))
    assert.deepEqual(all(page, '#fb-0 .links button').map(text), [
      'Show in Tests',
      'Show on worker 2',
    ])
    assert.equal(one(page, '#fb-1').hidden, true)
    // Opening a collapsed row shows its frame.
    click(page, heads[1] as Element)
    assert.equal(heads[1]?.getAttribute('aria-expanded'), 'true')
    assert.equal(one(page, '#fb-1').hidden, false)
    assert.match(text(one(page, '#fb-1 pre')), /toBe\(expected\)/)
    assertClean(page)
  })

  it('takes a failure to its file in Tests and to its worker in the Timeline', () => {
    const page = load(html)
    click(page, one(page, '#fb-0 .links button'))
    assert.equal(one(page, '#tab-1').getAttribute('aria-selected'), 'true')
    const item = fileItem(page, 'broken.test.ts')
    assert.equal(page.document.activeElement, item)
    assert.ok(item.firstElementChild?.classList.contains('is-active'))
    assert.equal(item.getAttribute('aria-expanded'), 'true')
    // Back in Failures, the second link opens the timeline on the file's slice.
    const index = fileIndexOf(page, 'broken.test.ts')
    click(page, one(page, '#tab-0'))
    click(page, all(page, '#fb-0 .links button')[1] as Element)
    assert.equal(one(page, '#tab-4').getAttribute('aria-selected'), 'true')
    assert.equal(page.document.activeElement, one(page, `#t-f-${index}`))
    assertClean(page)
  })

  it('draws the run overview: a lane for each worker and a patterned slice for each file', () => {
    const page = load(html)
    const lanes = all(page, '.overview .lane-track')
    assert.equal(lanes.length, 3)
    const slices = all(page, '.overview .slice')
    assert.equal(slices.length, 8)
    const kinds = (kind: string): number =>
      slices.filter((slice) => slice.classList.contains(`s-${kind}`)).length
    // Passed and failed, crashed, skipped and todo each have their own look; a failed file is hatched.
    assert.deepEqual(['pass', 'fail', 'crash', 'skip', 'todo'].map(kinds), [3, 3, 0, 1, 1])
    for (const id of ['p-fail', 'p-crash', 'p-skip'])
      assert.ok(page.document.getElementById(id), id)
    // Passing slices take a muted hue from 85° to 320°, never red's.
    for (const slice of slices.filter((item) => item.classList.contains('s-pass'))) {
      const hue = Number(/--h:\s*(\d+)/.exec(slice.getAttribute('style') ?? '')?.[1])
      assert.ok(hue >= 85 && hue <= 320, `hue ${hue}`)
    }
    // Failures are drawn last, so they sit on top.
    assert.ok(slices.slice(-3).every((slice) => slice.classList.contains('s-fail')))
    assert.equal(all(page, '.overview svg[role="img"]').length, 1)
    assert.match(text(one(page, '.ov-desc')), /^3 workers along 40 ms\. Drag across it/)
    assertClean(page)
  })

  it('filters every view by a range from the form: validated, announced, focus returned, cleared', () => {
    const page = load(html)
    const pick = one(page, '.range button[aria-controls="range-form"]')
    assert.equal(one(page, '#range-form').hidden, true)
    click(page, pick)
    assert.equal(one(page, '#range-form').hidden, false)
    assert.equal(pick.getAttribute('aria-expanded'), 'true')
    assert.equal(page.document.activeElement, one(page, '#range-from'))
    // An end before the start is refused, with the reason, and nothing is filtered.
    ;(one(page, '#range-from') as unknown as HTMLInputElement).value = '0.02'
    ;(one(page, '#range-to') as unknown as HTMLInputElement).value = '0.01'
    one(page, '#range-form').dispatchEvent(new page.window.Event('submit', { cancelable: true }))
    assert.equal(
      (one(page, '#range-to') as unknown as HTMLInputElement).validationMessage,
      'The end must be after the start.',
    )
    assert.equal(text(one(page, '.range [aria-live]')), '')
    assert.equal(one(page, '#range-form').hidden, false)
    // From 0 to 15 ms: the five files that ran in it.
    applyRange(page, '0', '0.015')
    assert.equal(one(page, '#range-form').hidden, true)
    assert.equal(page.document.activeElement, pick)
    assert.equal(text(one(page, '.range [aria-live]')), '0 ms – 15 ms · 5 files')
    assert.equal(one(page, '.range [aria-live]').getAttribute('aria-live'), 'polite')
    assert.equal(all(page, '.overview .slice.dim').length, 3)
    assert.equal(one(page, '.brush').getAttribute('visibility'), 'visible')
    // Failures: only the failed test whose file is in the range.
    assert.deepEqual(all(page, '.failure-file').map(text), ['fails.test.ts'])
    // Tests: five files. Map: the other three dimmed. Folders: their time. Timeline: dimmed slices.
    open(page, 'Tests')
    assert.equal(all(page, '.node.k-file').length, 5)
    assert.equal(text(one(page, '.node.k-folder .meta')), '1 failed 5 files 26 ms')
    open(page, 'Map')
    assert.equal(all(page, '.cell.dim').length, 3)
    assert.equal(all(page, '.map-grid .cell').length, 8)
    open(page, 'Folders')
    assert.equal(text(all(page, '.folders tbody td')[2]), '26 ms')
    open(page, 'Timeline')
    assert.equal(all(page, '.t-slice.dim').length, 3)
    // Clear range puts every view back.
    click(page, one(page, '.range button:not([aria-controls])'))
    assert.equal(text(one(page, '.range [aria-live]')), '')
    assert.equal(all(page, '.dim').length, 0)
    assert.equal(one(page, '.brush').getAttribute('visibility'), 'hidden')
    open(page, 'Tests')
    assert.equal(all(page, '.node.k-file').length, 8)
    assertClean(page)
  })

  it('brushes a range on the overview with the pointer, clears it with Escape, and a click jumps to the file', () => {
    const page = load(html)
    const overview = one(page, '.overview svg[role="img"]')
    // A drag: the box has no size in jsdom, so the x of an event is the share of the run.
    pointer(page, overview, 'pointerdown', 0)
    pointer(page, overview, 'pointermove', 0.375)
    assert.equal(one(page, '.brush').getAttribute('visibility'), 'visible')
    pointer(page, overview, 'pointerup', 0.375)
    assert.equal(text(one(page, '.range [aria-live]')), '0 ms – 15 ms · 5 files')
    press(page, overview, 'Escape')
    assert.equal(text(one(page, '.range [aria-live]')), '')
    // A click on a slice reveals its file in Tests.
    const slice = all(page, '.overview .slice')[0] as Element
    pointer(page, slice, 'pointerdown', 0.1)
    pointer(page, overview, 'pointerup', 0.1)
    assert.equal(one(page, '#tab-1').getAttribute('aria-selected'), 'true')
    assert.equal(page.document.activeElement?.getAttribute('role'), 'treeitem')
    assertClean(page)
  })

  it('draws the tree: failures open with their code frames, passing files folded, built as they open', () => {
    const page = load(html)
    open(page, 'Tests')
    const tree = one(page, '[role="tree"]')
    assert.equal(all(page, '.node.k-folder').length, 1)
    assert.equal(text(one(page, '.node.k-folder .label')), 'failed ./')
    assert.equal(all(page, '.node.k-file').length, 8)
    assert.ok(tree.querySelectorAll('[role="treeitem"]').length > 8)
    // A passing file is folded and has built nothing under it yet.
    const math = fileItem(page, 'math.test.ts')
    assert.equal(math.getAttribute('aria-expanded'), 'false')
    assert.equal(math.querySelector('[role="group"]')?.childElementCount, 0)
    // A failing file is open, down to the failed test and its boxed code frame.
    const fails = fileItem(page, 'fails.test.ts')
    assert.equal(fails.getAttribute('aria-expanded'), 'true')
    assert.match(text(fails.querySelector('.inline-error')), /toBe\(expected\)/)
    assert.equal(fails.querySelectorAll('.node.k-suite').length, 1)
    assert.equal(fails.querySelectorAll('.node.k-test').length, 2)
    // A file that failed to collect shows its own error.
    const broken = fileItem(page, 'broken.test.ts')
    assert.match(
      text(broken.querySelector('.inline-error')),
      /Cannot find module '\.\/missing\.ts'/,
    )
    // Opening a passing file builds its top level, and opening a suite builds what is in it.
    click(page, math.firstElementChild as Element)
    assert.equal(math.getAttribute('aria-expanded'), 'true')
    const children = (item: Element): string[] =>
      [...item.querySelectorAll(':scope > [role="group"] > .treeitem')].map((child) =>
        text(child.querySelector('.label')).replace(/^(?:passed|failed) /, ''),
      )
    assert.deepEqual(children(math), ['math', 'stands alone'])
    assert.equal(math.querySelectorAll('.node.k-test').length, 1)
    const suite = math.querySelector('.treeitem') as HTMLElement
    assert.equal(suite.getAttribute('aria-expanded'), 'false')
    click(page, suite.firstElementChild as Element)
    assert.deepEqual(children(suite), ['adds', 'nested'])
    click(
      page,
      (suite.querySelector('[role="group"] .treeitem[aria-expanded]') as HTMLElement)
        .firstElementChild as Element,
    )
    assert.equal(math.querySelectorAll('.node.k-test').length, 3)
    assertClean(page)
  })

  it('names every node for assistive technology: role, level, state word, label and counts', () => {
    const page = load(html)
    open(page, 'Tests')
    const fails = fileItem(page, 'fails.test.ts')
    assert.equal(fails.getAttribute('role'), 'treeitem')
    assert.equal(fails.getAttribute('aria-level'), '2')
    assert.equal(
      nameOf(page.document.getElementById(fails.getAttribute('aria-labelledby') ?? '')),
      'failed fails.test.ts 1 failed 2 tests 9 ms',
    )
    // The boxed error describes its test.
    const test = fails.querySelector('.k-test.node') as HTMLElement
    const described = test.closest('.treeitem')?.getAttribute('aria-describedby')
    assert.ok(described !== undefined && described !== null)
    assert.ok(page.document.getElementById(described)?.classList.contains('inline-error'))
    // A glyph is never the only word for its status.
    for (const glyph of all(page, '.node > svg.icon, .failure-head > svg.icon')) {
      assert.equal(glyph.getAttribute('aria-hidden'), 'true')
    }
    assert.equal(all(page, '[role="tab"][aria-selected="true"]').length, 1)
  })

  it('moves through the tree with the arrow keys', () => {
    const page = load(html)
    open(page, 'Tests')
    const folder = one(page, '.treeitem')
    assert.equal(folder.tabIndex, 0)
    folder.focus()
    press(page, folder, 'ArrowDown')
    const first = page.document.activeElement as HTMLElement
    assert.equal(first.getAttribute('aria-level'), '2')
    assert.equal(first.tabIndex, 0)
    assert.equal(folder.tabIndex, -1)
    // Right opens a folded file, and a second Right goes to its first child.
    const math = fileItem(page, 'math.test.ts')
    math.focus()
    press(page, math, 'ArrowRight')
    assert.equal(math.getAttribute('aria-expanded'), 'true')
    press(page, math, 'ArrowRight')
    assert.equal(page.document.activeElement, math.querySelector('.treeitem'))
    // Left goes back to the parent, and a second Left closes it.
    press(page, page.document.activeElement as Element, 'ArrowLeft')
    assert.equal(page.document.activeElement, math)
    press(page, math, 'ArrowLeft')
    assert.equal(math.getAttribute('aria-expanded'), 'false')
    // Enter toggles; End and Home go to the last and the first visible item.
    press(page, math, 'Enter')
    assert.equal(math.getAttribute('aria-expanded'), 'true')
    press(page, math, 'End')
    const items = all(page, '[role="treeitem"]').filter(
      (item) => item.parentElement?.closest('[hidden]') == null,
    )
    assert.equal(page.document.activeElement, items[items.length - 1])
    press(page, page.document.activeElement as Element, 'Home')
    assert.equal(page.document.activeElement, folder)
    assertClean(page)
  })

  it('narrows the tree by search, with a count for a screen reader, and by the status chips', () => {
    const page = load(html)
    open(page, 'Tests')
    search(page, 'math')
    assert.deepEqual(
      all(page, '.node.k-file .label').map((item) => item.title),
      ['math.test.ts'],
    )
    assert.equal(text(one(page, '.note[role="status"]')), '3 tests shown in 1 file.')
    assert.equal(fileItem(page, 'math.test.ts').getAttribute('aria-expanded'), 'true')
    // Every word must match, across the titles.
    search(page, 'nested')
    assert.equal(all(page, '.node.k-test').length, 1)
    search(page, 'no such test')
    assert.equal(all(page, '.node.k-file').length, 0)
    assert.equal(text(one(page, '.note[role="status"]')), 'No tests match.')
    // Cleared, the whole tree is back, folded as it was.
    search(page, '')
    assert.equal(all(page, '.node.k-file').length, 8)
    assert.equal(fileItem(page, 'math.test.ts').getAttribute('aria-expanded'), 'false')
    // The chips are Failed, Skipped and Todo, with their counts.
    const chips = all(page, '.toolbar .chip')
    assert.deepEqual(chips.map(text), ['Failed 2', 'Skipped 3', 'Todo 2'])
    assert.ok(chips.every((chip) => chip.getAttribute('aria-pressed') === 'false'))
    click(page, chips[0] as Element)
    assert.equal(chips[0]?.getAttribute('aria-pressed'), 'true')
    assert.equal(text(one(page, '.note[role="status"]')), '2 tests shown in 3 files.')
    assert.deepEqual(
      all(page, '.node.k-file .label')
        .map((item) => item.title)
        .sort(),
      ['broken.test.ts', 'fails.test.ts', 'snapshot.test.ts'],
    )
    click(page, chips[0] as Element)
    click(page, chips[2] as Element)
    assert.equal(text(one(page, '.note[role="status"]')), '2 tests shown in 2 files.')
    assertClean(page)
  })

  it('draws the status map: a patterned square for each file, in one roving group, by folder', () => {
    const page = load(html)
    open(page, 'Map')
    const grid = one(page, '.map-grid')
    assert.equal(grid.getAttribute('role'), 'group')
    const help = page.document.getElementById(grid.getAttribute('aria-describedby') ?? '')
    assert.match(text(help), /^One square per file, by folder\./)
    assert.deepEqual(all(page, '.legend li').map(text), [
      'passed',
      'failed (hatched)',
      'crashed (cross-hatched)',
      'skipped (dotted)',
      'todo (outline)',
    ])
    const cells = all(page, '.map-grid button.cell')
    assert.equal(cells.length, 8)
    const kinds = (kind: string): number =>
      cells.filter((cell) => cell.classList.contains(`s-${kind}`)).length
    assert.deepEqual(['pass', 'fail', 'crash', 'skip', 'todo'].map(kinds), [3, 3, 0, 1, 1])
    assert.equal(text(one(page, '.map-block h3')), './3 failed of 8')
    const fails = cells.find((cell) => cell.title.startsWith('fails.test.ts'))
    assert.equal(fails?.title, 'fails.test.ts · failed · 9 ms')
    assert.equal(fails?.getAttribute('aria-label'), 'fails.test.ts, failed, 2 tests, 9 ms')
    assert.equal(all(page, '.map-grid button.cell[tabindex="0"]').length, 1)
    assertClean(page)
  })

  it('moves between the squares with the arrow keys, by visual line, Home and End, and Enter opens the file', () => {
    const page = load(html)
    open(page, 'Map')
    const cells = all(page, '.map-grid button.cell')
    // jsdom lays nothing out: put the eight squares on a grid of three columns, as the page would.
    cells.forEach((cell, index) => {
      const left = (index % 3) * 13
      const top = Math.floor(index / 3) * 13
      Reflect.set(cell, 'getBoundingClientRect', () => ({
        left,
        top,
        right: left + 11,
        bottom: top + 11,
        width: 11,
        height: 11,
        x: left,
        y: top,
      }))
    })
    const first = cells[0] as HTMLElement
    first.focus()
    press(page, first, 'ArrowRight')
    assert.equal(page.document.activeElement, cells[1])
    assert.equal(cells[1]?.tabIndex, 0)
    assert.equal(first.tabIndex, -1)
    press(page, cells[1] as Element, 'ArrowDown')
    assert.equal(page.document.activeElement, cells[4])
    press(page, cells[4] as Element, 'ArrowDown')
    assert.equal(page.document.activeElement, cells[7])
    // Nothing below the last line: the focus stays.
    press(page, cells[7] as Element, 'ArrowDown')
    assert.equal(page.document.activeElement, cells[7])
    press(page, cells[7] as Element, 'ArrowUp')
    assert.equal(page.document.activeElement, cells[4])
    press(page, cells[4] as Element, 'ArrowLeft')
    assert.equal(page.document.activeElement, cells[3])
    press(page, cells[3] as Element, 'End')
    assert.equal(page.document.activeElement, cells[7])
    press(page, cells[7] as Element, 'Home')
    assert.equal(page.document.activeElement, cells[0])
    assert.equal(all(page, '.map-grid button.cell[tabindex="0"]').length, 1)
    // Enter opens the file in Tests, as a click does.
    const target = cells.find((cell) => cell.title.startsWith('math.test.ts')) as HTMLElement
    target.focus()
    press(page, target, 'Enter')
    assert.equal(one(page, '#tab-1').getAttribute('aria-selected'), 'true')
    assert.equal(page.document.activeElement, fileItem(page, 'math.test.ts'))
    open(page, 'Map')
    click(page, cells.find((cell) => cell.title.startsWith('fails.test.ts')) as Element)
    assert.equal(page.document.activeElement, fileItem(page, 'fails.test.ts'))
    assertClean(page)
  })

  it('draws time by folder as a table sorted by time, with the numbers in text', () => {
    const page = load(html)
    open(page, 'Folders')
    const rows = all(page, '.folders tbody tr')
    assert.equal(rows.length, 1)
    assert.deepEqual([...(rows[0] as HTMLElement).querySelectorAll('td')].map(text), [
      './ · 3 failed',
      '',
      '41 ms',
      '100.0%',
      '8',
      'math.test.ts (12 ms)',
    ])
    assert.deepEqual(all(page, '.folders thead th').map(text), [
      'Folder',
      'Share of time',
      'Time',
      'Share',
      'Files',
      'Slowest file',
    ])
    // The bar repeats the numbers, hidden from assistive technology, and a folder with a failure is hatched.
    assert.equal(one(page, '.folders tbody .bar-cell').getAttribute('aria-hidden'), 'true')
    assert.ok(one(page, '.folders .bar').classList.contains('has-fail'))
    assert.match(
      text(one(page, '.note')),
      /^Summed file time across workers: 41 ms over 40 ms of wall time\.$/,
    )
    assertClean(page)
  })

  it('draws the timeline: a labelled lane for each worker, a titled slice for each file, and a table', () => {
    const page = load(html)
    open(page, 'Timeline')
    const labels = all(page, '.lanes-labels > div').slice(1)
    assert.deepEqual(
      labels.map((label) => label.firstChild?.textContent),
      ['worker 0', 'worker 1', 'worker 2'],
    )
    assert.deepEqual(
      labels.map((label) => text(label.querySelector('.busy'))),
      ['53% busy', '45% busy', '5% busy'],
    )
    const slices = all(page, '.t-slice')
    assert.equal(slices.length, 8)
    const titles = slices.map((slice) => text(slice.querySelector('title')))
    assert.ok(titles.includes('math.test.ts · passed · 12 ms · worker 0 · 0 ms–12 ms'))
    assert.ok(titles.includes('broken.test.ts · failed · 2 ms · worker 2 · 30 ms–32 ms'))
    // Failed and crashed slices are in the tab order; the others are not.
    assert.equal(slices.filter((slice) => slice.getAttribute('tabindex') === '0').length, 3)
    assert.equal(slices.filter((slice) => slice.classList.contains('s-fail')).length, 3)
    assert.equal(one(page, '.lanes-scroll svg').getAttribute('role'), 'img')
    // The table is built when it is first asked for, and is the same eight files.
    assert.equal(one(page, '#tl-table').hidden, true)
    const toggle = one(page, '[aria-controls="tl-table"]')
    assert.equal(text(toggle), 'Show as a table')
    click(page, toggle)
    assert.equal(one(page, '#tl-table').hidden, false)
    assert.equal(toggle.getAttribute('aria-expanded'), 'true')
    assert.equal(text(toggle), 'Hide the table')
    const lines = all(page, '#tl-table tbody tr')
    assert.equal(lines.length, 8)
    assert.deepEqual([...(lines[0] as HTMLElement).querySelectorAll('td')].map(text), [
      'worker 0',
      'math.test.ts',
      '0 ms',
      '12 ms',
      '12 ms',
      'passed',
      '10 ms',
    ])
    // Clicking a slice reveals its file.
    click(page, slices[0] as Element)
    assert.equal(one(page, '#tab-1').getAttribute('aria-selected'), 'true')
    assertClean(page)
  })

  it('moves between the tabs with the arrow keys, Home and End', () => {
    const page = load(html)
    const tab = one(page, '#tab-0')
    tab.focus()
    press(page, tab, 'ArrowRight')
    assert.equal(page.document.activeElement, one(page, '#tab-1'))
    assert.equal(one(page, '#tab-1').getAttribute('aria-selected'), 'true')
    assert.equal(one(page, '#tab-1').tabIndex, 0)
    assert.equal(one(page, '#tab-0').tabIndex, -1)
    press(page, one(page, '#tab-1'), 'End')
    assert.equal(page.document.activeElement, one(page, '#tab-4'))
    press(page, one(page, '#tab-4'), 'ArrowRight')
    assert.equal(page.document.activeElement, one(page, '#tab-0'))
    press(page, one(page, '#tab-0'), 'ArrowLeft')
    assert.equal(page.document.activeElement, one(page, '#tab-4'))
    assert.equal(one(page, '#panel-4').getAttribute('aria-labelledby'), 'tab-4')
    assert.equal(one(page, '#tab-4').getAttribute('role'), 'tab')
    assert.equal(one(page, '[role="tablist"]').getAttribute('aria-label'), 'Report views')
    assertClean(page)
  })
})

/** The index of the file at `path` in the page's rows, read from the Map's squares. */
function fileIndexOf(page: Page, path: string): string {
  open(page, 'Map')
  const cell = all(page, '.map-grid button.cell').find((item) => item.title.startsWith(path))
  assert.ok(cell !== undefined)
  return cell.getAttribute('data-f') ?? ''
}

/** Plays a sample state through the reporter and reads the page it wrote. */
async function sampleHtml(state: SampleState, options: { root?: string } = {}): Promise<string> {
  const clock = sampleClock()
  const dir = await mkdtemp(join(tmpdir(), `provino-html-${state}-`))
  try {
    const outputFile = join(dir, 'report.html')
    const bus = createReporterBus([
      htmlReporter({
        outputFile,
        root: options.root ?? '/project',
        now: clock.now,
        seed: 1827364,
        sample: true,
      }),
    ])
    await playSample(bus, state, clock)
    assert.deepEqual(bus.failures(), [])
    return await readFile(outputFile, 'utf8')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('the report page, on other runs', () => {
  it('says a run with no files ran no tests: the verdict and the empty state, no tabs', async () => {
    const page = load(await sampleHtml('empty'))
    assertClean(page)
    assert.equal(headline(page), 'No tests ran')
    assert.equal(all(page, '.verdict .glyph').length, 0)
    assert.equal(text(one(page, '.empty h2')), 'No test files ran')
    assert.match(text(one(page, '.empty')), /--passWithNoTests/)
    assert.equal(all(page, '[role="tablist"]').length, 0)
    assert.equal(all(page, '.overview').length, 0)
    // The run's place is in the bar, and a sample says it is one.
    assert.match(text(one(page, '.verdict .where')), /^\/project · 2026-11-19/)
    assert.equal(text(one(page, '.synthetic')), 'sample data')
  })

  it('opens Tests first on a passing run, with the verdict and the fields in the passing order', async () => {
    const page = load(await sampleHtml('all-passed'))
    assertClean(page)
    assert.match(headline(page), /^All [\d,]+ tests passed$/)
    assert.equal(text(one(page, '.verdict .glyph')), '🎉')
    assert.equal(all(page, '.verdict.is-fail').length, 0)
    assert.deepEqual(all(page, '.fields dt').slice(0, 4).map(text), [
      'Passed',
      'Failed',
      'Skipped',
      'Todo',
    ])
    assert.equal(fields(page).Seed, '1827364')
    assert.equal(one(page, '#tab-1').getAttribute('aria-selected'), 'true')
    assert.equal(all(page, '[role="tab"] .count.n-fail').length, 0)
    assert.equal(all(page, '.node.k-folder').length, 12)
    // The Failures tab says there are none.
    assert.equal(text(open(page, 'Failures').querySelector('h2')), 'No failures')
    assertClean(page)
  })

  it('opens Failures first with the first failure expanded, on the sample with failures and a collection error', async () => {
    const page = load(await sampleHtml('failures'))
    assertClean(page)
    assert.equal(one(page, '#tab-0').getAttribute('aria-selected'), 'true')
    const heads = all(page, '.failure-head')
    assert.ok(heads.length > 4)
    assert.equal(heads[0]?.getAttribute('aria-expanded'), 'true')
    assert.equal(all(page, '.failure-head[aria-expanded="true"]').length, 1)
    assert.equal(all(page, '.map-grid .cell.s-crash').length, 0)
    open(page, 'Tests')
    assert.ok(all(page, '.node.k-folder .n-fail').length > 0)
    assert.ok(all(page, '.inline-error').length > 4)
    assertClean(page)
  })

  it('shows a crashed file, its replacement worker and an error outside any test file', async () => {
    const page = load(await sampleHtml('crashed'))
    assertClean(page)
    assert.match(headline(page), /file crashed/)
    assert.match(headline(page), /1 error outside the tests/)
    // The crash has a row with its text and its worker's link; the run's own error has a row of its own.
    const crash = all(page, '.failure').find((row) => text(row).includes('native-addon'))
    assert.ok(crash !== undefined)
    assert.match(text(crash.querySelector('pre')), /SIGSEGV/)
    assert.match(text(crash.querySelector('.failure-title')), /^crashed: /)
    assert.match(text(crash.querySelector('.links')), /Show on worker \d+/)
    assert.ok(
      all(page, '.failure').some((row) => text(row.querySelector('.failure-file')) === 'run'),
    )
    // The map and the overview draw it cross-hatched; the timeline names the worker that took over.
    open(page, 'Map')
    assert.equal(all(page, '.map-grid .cell.s-crash').length, 1)
    assert.equal(all(page, '.overview .slice.s-crash').length, 1)
    open(page, 'Timeline')
    const replaced = all(page, '.lanes-labels .replaced')
    assert.equal(replaced.length, 1)
    assert.match(text(replaced[0]), /^worker \d+ \(took over from \d+\)\d+% busy$/)
    assert.equal(all(page, '.t-slice.s-crash').length, 1)
    assertClean(page)
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
    assert.ok(text(one(page, '.failure-file')).includes(evil))
    assert.ok(text(one(page, '.failure-title')).includes(evil))
    assert.ok(text(one(page, '.failure-body pre')).includes(evil))
    open(page, 'Tests')
    assert.ok(text(one(page, '.node.k-test .label')).includes(evil))
    assertClean(page)
  })

  it('builds and filters a run of 2,000 files without a node for each test', async () => {
    const page = load(await sampleHtml('2000-files'))
    assertClean(page)
    open(page, 'Tests')
    // Folded: the tests of a passing file are not in the document.
    assert.ok(all(page, '.node.k-test').length < 4000)
    assert.equal(all(page, '.node.k-folder').length, 12)
    search(page, 'app 1999')
    assert.ok(all(page, '.node.k-file').length >= 1)
    open(page, 'Map')
    assert.ok(all(page, '.map-grid button.cell').length >= 2000)
    open(page, 'Timeline')
    assert.ok(all(page, '.t-slice').length >= 2000)
    assertClean(page)
  })
})
