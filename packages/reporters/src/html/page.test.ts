// The report's page, run in jsdom with scripts on: what it draws for the fixture run equals the
// fixture, its keyboard works, a network request or a console error fails the test, and nothing in
// a test's title or a failure's text becomes markup.

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type DOMWindow, JSDOM, requestInterceptor, VirtualConsole } from 'jsdom'
import { beforeAll, describe, it } from 'provino'
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

describe('the report page, on the fixture run', () => {
  let html = ''
  beforeAll(async () => {
    ;({ html } = await reportFor())
  })

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
    // Where and when, in the tab bar, with no label for a run that is real. Where is the root's
    // directory name: the run's path is not in the report.
    assert.equal(text(one(page, '.tabbar .where code')), 'project')
    assert.equal(text(one(page, '.tabbar .where')), 'project · 2026-11-19 12:00 UTC')
    assert.equal(all(page, '.synthetic').length, 0)
  })

  it('stacks the verdict, the run overview, the tab bar and the open panel; the first failure is open', () => {
    const page = load(html)
    const shell = one(page, '#report > div')
    assert.deepEqual(
      [...shell.children].map(
        (child) => (child.getAttribute('class') ?? '').split(' ')[0] || child.tagName.toLowerCase(),
      ),
      ['sprite', 'verdict', 'main'],
    )
    // Everything after the banner is the page's one main landmark.
    assert.equal(one(page, '.verdict').tagName, 'HEADER')
    assert.deepEqual(
      [...one(page, '#report > div > main').children].map(
        (child) => (child.getAttribute('class') ?? '').split(' ')[0],
      ),
      ['overview', 'tabbar', 'panel', 'panel', 'panel', 'panel', 'panel'],
    )
    assert.equal(all(page, 'main').length, 1)
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
    // What describes the test is the error's own text, which sits in a named group.
    const describing = page.document.getElementById(described)
    assert.ok(describing?.closest('.inline-error') !== null)
    assert.match(describing?.textContent ?? '', /toBe\(expected\)/)
    const frame = describing?.closest('.inline-error') ?? null
    assert.equal(frame?.getAttribute('role'), 'group')
    assert.equal(frame?.getAttribute('aria-label'), 'Failure output')
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
    // The chart is a named group (its focusable slices are buttons, which an image would hide), and
    // it follows its container: a viewBox and 100%, not a width of its own.
    const chart = one(page, '.lanes-scroll svg')
    assert.equal(chart.getAttribute('role'), 'group')
    assert.match(chart.getAttribute('aria-label') ?? '', /^Per-worker timeline of 8 files/)
    assert.equal(chart.getAttribute('width'), '100%')
    assert.match(chart.getAttribute('viewBox') ?? '', /^0 0 \d+ 88$/)
    assert.equal(chart.getAttribute('preserveAspectRatio'), 'none')
    for (const slice of slices.filter((item) => item.getAttribute('tabindex') === '0')) {
      assert.equal(slice.getAttribute('role'), 'button')
      assert.equal(slice.getAttribute('aria-label'), text(slice.querySelector('title')))
    }
    assert.ok(
      slices
        .filter((item) => item.getAttribute('tabindex') === '-1')
        .every((item) => !item.hasAttribute('role')),
    )
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
async function sampleHtml(state: SampleState): Promise<string> {
  const clock = sampleClock()
  const dir = await mkdtemp(join(tmpdir(), `provino-html-${state}-`))
  try {
    const outputFile = join(dir, 'report.html')
    const bus = createReporterBus([
      htmlReporter({
        outputFile,
        now: clock.now,
        // The sample CLI's wall clock: the start time the page shows is not today's date.
        wallClock: () => Date.UTC(2026, 10, 19, 12, 0, 0),
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
    assert.match(text(one(page, '.verdict .where')), /^project · 2026-11-19/)
    assert.equal(one(page, '#report > div > main > .empty').tagName, 'SECTION')
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
    // A row's body is built when it is opened.
    assert.equal(crash.querySelector('pre'), null)
    click(page, crash.querySelector('.failure-head') as Element)
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

/** The levels of the document's headings, in order. */
function headingLevels(page: Page): number[] {
  return all(page, 'h1, h2, h3, h4, h5, h6').map((heading) => Number(heading.tagName.slice(1)))
}

/** No heading skips a level on the way down: an `h3` has an `h2` above it. */
function assertNoSkippedLevel(page: Page): void {
  const levels = headingLevels(page)
  assert.equal(levels[0], 1)
  levels.forEach((level, index) => {
    if (index > 0) {
      assert.ok(level <= (levels[index - 1] ?? 0) + 1, `h${level} after h${levels[index - 1]}`)
    }
  })
}

/** The `block` of the options a stubbed `scrollIntoView` got (the page's objects are another realm's). */
function blockOf(call: { readonly options: unknown } | undefined): string {
  const options = call?.options as { block?: string } | undefined
  return options?.block ?? ''
}

/** Types into a field of the range form, as a keystroke does: the value, then `input`. */
function typeInto(page: Page, selector: string, value: string): HTMLInputElement {
  const input = one(page, selector) as unknown as HTMLInputElement
  input.value = value
  input.dispatchEvent(new page.window.Event('input', { bubbles: true }))
  return input
}

/** Submits the range form as a browser's button does: the field constraints are checked first. */
function submit(page: Page): void {
  ;(one(page, '#range-form') as unknown as HTMLFormElement).requestSubmit()
}

describe('the report page, the range form and the status messages', () => {
  // A run long enough for the form's own bounds (whole tenths of a second) to hold a range.
  let long = ''
  beforeAll(async () => {
    long = await sampleHtml('failures')
  })

  it('applies a corrected range after an invalid one: the error is cleared as the value is corrected', () => {
    const page = load(long)
    const pick = one(page, '.range button[aria-controls="range-form"]')
    click(page, pick)
    const to = one(page, '#range-to') as unknown as HTMLInputElement
    const error = one(page, '#range-error')
    assert.equal(error.hidden, true)
    // From 8 s to 2 s: refused, with the reason in text, on the field and for a screen reader.
    typeInto(page, '#range-from', '8')
    typeInto(page, '#range-to', '2')
    submit(page)
    assert.equal(one(page, '#range-form').hidden, false)
    assert.equal(to.validity.customError, true)
    assert.equal(to.getAttribute('aria-invalid'), 'true')
    assert.equal(to.getAttribute('aria-describedby'), 'range-error')
    assert.equal(error.hidden, false)
    assert.equal(text(error), 'The end must be after the start.')
    assert.equal(error.querySelector('svg.icon')?.getAttribute('aria-hidden'), 'true')
    assert.equal(one(page, '#range-from').hasAttribute('aria-invalid'), false)
    assert.equal(text(one(page, '.range [aria-live]')), '')
    // Corrected to 1 s to 3 s: the error goes with the typing, and the range applies.
    typeInto(page, '#range-from', '1')
    assert.equal(to.validity.customError, false)
    assert.equal(to.hasAttribute('aria-invalid'), false)
    assert.equal(to.hasAttribute('aria-describedby'), false)
    assert.equal(error.hidden, true)
    assert.equal(text(error), '')
    typeInto(page, '#range-to', '3')
    submit(page)
    assert.equal(one(page, '#range-form').hidden, true)
    assert.equal(page.document.activeElement, pick)
    // The new range is in a status region, so it is announced.
    const status = one(page, '.range [aria-live]')
    assert.equal(status.getAttribute('role'), 'status')
    assert.match(text(status), /^1\.00 s – 3\.00 s · [\d,]+ files$/)
    assertClean(page)
  })

  it('names the field that is empty or not a number, and refuses nothing the field allows', () => {
    const page = load(long)
    click(page, one(page, '.range button[aria-controls="range-form"]'))
    const from = typeInto(page, '#range-from', '')
    submit(page)
    assert.equal(from.getAttribute('aria-invalid'), 'true')
    assert.equal(text(one(page, '#range-error')), 'Enter the start in seconds.')
    assert.equal(from.validity.customError, true)
    typeInto(page, '#range-from', '1')
    typeInto(page, '#range-to', '')
    submit(page)
    assert.equal(one(page, '#range-to').getAttribute('aria-invalid'), 'true')
    assert.equal(text(one(page, '#range-error')), 'Enter the end in seconds.')
    assert.equal(from.hasAttribute('aria-invalid'), false)
  })

  it('opens clean after Cancel: an invalid range left in the form is gone with it', () => {
    const page = load(long)
    const pick = one(page, '.range button[aria-controls="range-form"]')
    click(page, pick)
    const to = typeInto(page, '#range-to', '0.1')
    typeInto(page, '#range-from', '2')
    submit(page)
    assert.equal(to.validity.customError, true)
    click(page, one(page, '#range-form [data-cancel]'))
    assert.equal(one(page, '#range-form').hidden, true)
    assert.equal(page.document.activeElement, pick)
    assert.equal(to.validity.customError, false)
    assert.equal(to.hasAttribute('aria-invalid'), false)
    assert.equal(one(page, '#range-error').hidden, true)
    // Reopened, a valid range goes through at once.
    click(page, pick)
    typeInto(page, '#range-from', '0')
    typeInto(page, '#range-to', '2')
    submit(page)
    assert.equal(one(page, '#range-form').hidden, true)
    assert.match(text(one(page, '.range [aria-live]')), /^0 ms – 2\.00 s · /)
  })

  it('says when a range is cleared, in a status region, and says nothing when there was none', () => {
    const page = load(long)
    const note = one(page, '.range .sr-only[role="status"]')
    const overview = one(page, '.overview svg[role="img"]')
    // Escape with no range changes nothing worth announcing.
    press(page, overview, 'Escape')
    assert.equal(text(note), '')
    click(page, one(page, '.range button[aria-controls="range-form"]'))
    typeInto(page, '#range-from', '1')
    typeInto(page, '#range-to', '3')
    submit(page)
    assert.equal(text(note), '')
    click(page, one(page, '.range button:not([aria-controls])'))
    assert.match(text(note), /^Range cleared\. All [\d,]+ files shown\.$/)
    assert.equal(text(one(page, '.range [aria-live]')), '')
  })
})

describe('the report page, focus and names', () => {
  let html = ''
  beforeAll(async () => {
    ;({ html } = await reportFor())
  })

  it('scrolls the row of the focused tree item, nearest, never the item with its children', () => {
    const page = load(html)
    const scrolled: { target: Element; options: unknown }[] = []
    const focused: unknown[] = []
    const proto = page.window.HTMLElement.prototype
    const focus = proto.focus
    Reflect.set(
      page.window.Element.prototype,
      'scrollIntoView',
      function (this: Element, options?: unknown) {
        scrolled.push({ target: this, options })
      },
    )
    proto.focus = function (this: HTMLElement, options?: FocusOptions) {
      focused.push(options)
      focus.call(this, options)
    }
    open(page, 'Tests')
    const math = fileItem(page, 'math.test.ts')
    math.focus()
    press(page, math, 'ArrowRight')
    press(page, math, 'ArrowRight')
    const child = page.document.activeElement as HTMLElement
    assert.equal(child.closest('.treeitem'), child)
    scrolled.length = 0
    focused.length = 0
    // Left to the ancestor, which holds its open children: its own row is scrolled to.
    press(page, child, 'ArrowLeft')
    assert.equal(page.document.activeElement, math)
    assert.equal(scrolled.length, 1)
    assert.equal(scrolled[0]?.target, math.querySelector(':scope > .node'))
    // (The page's objects are another realm's: compare what is in them.)
    assert.equal(blockOf(scrolled[0]), 'nearest')
    assert.deepEqual(
      focused.map((options) => (options as { preventScroll: boolean }).preventScroll),
      [true],
    )
    // Home goes to the first row of the tree, and Up and Down to their neighbours', the same way.
    scrolled.length = 0
    press(page, math, 'Home')
    const first = one(page, '.treeitem')
    assert.equal(page.document.activeElement, first)
    assert.equal(scrolled[0]?.target, first.querySelector(':scope > .node'))
    press(page, first, 'ArrowDown')
    const second = page.document.activeElement as HTMLElement
    assert.equal(scrolled.at(-1)?.target, second.querySelector(':scope > .node'))
    press(page, second, 'ArrowUp')
    assert.equal(scrolled.at(-1)?.target, first.querySelector(':scope > .node'))
    assert.ok(scrolled.every((call) => blockOf(call) === 'nearest'))
    // Opening a file from the map centres its row.
    open(page, 'Map')
    click(page, all(page, '.map-grid button.cell')[0] as Element)
    const last = scrolled.at(-1)
    assert.ok(last !== undefined)
    assert.ok(last.target.classList.contains('node'))
    assert.equal(blockOf(last), 'center')
    assertClean(page)
  })

  it('gives each tab panel a heading, so the map’s folders sit under an h2', () => {
    const page = load(html)
    for (const name of ['Failures', 'Tests', 'Map', 'Folders', 'Timeline']) {
      const panel = open(page, name)
      const heading = panel.querySelector('h2')
      assert.equal(text(heading), name)
      assert.ok(
        heading?.classList.contains('sr-only'),
        `${name}'s heading is for assistive technology`,
      )
      assertNoSkippedLevel(page)
    }
    // The map's folder headings are the h3s under the Map's h2.
    const map = open(page, 'Map')
    assert.ok(map.querySelectorAll('h3').length > 0)
    assertNoSkippedLevel(page)
    // A range re-draws a panel and its heading with it.
    applyRange(page, '0', '0.0')
    assert.equal(text(open(page, 'Map').querySelector('h2')), 'Map')
  })

  it('gives every failure’s code frame a role and a name, and the tree item is described by its text', () => {
    const page = load(html)
    open(page, 'Tests')
    const frames = all(page, 'pre')
    assert.ok(frames.length >= 3)
    for (const frame of frames) {
      assert.equal(frame.getAttribute('role'), 'group')
      assert.equal(frame.getAttribute('aria-label'), 'Failure output')
    }
    open(page, 'Failures')
    assert.ok(
      all(page, '.failure-body pre').every((frame) => frame.getAttribute('role') === 'group'),
    )
  })

  it('opens a failed file of the timeline with Enter or Space, as the button it is, and Space does not scroll', () => {
    const page = load(html)
    open(page, 'Timeline')
    const slice = all(page, '.t-slice').find((item) => item.getAttribute('role') === 'button')
    assert.ok(slice !== undefined)
    for (const key of ['Enter', ' ']) {
      open(page, 'Timeline')
      const event = new page.window.KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
      })
      all(page, '.t-slice[role="button"]')[0]?.dispatchEvent(event)
      assert.equal(event.defaultPrevented, true)
      assert.equal(one(page, '#tab-1').getAttribute('aria-selected'), 'true')
    }
    // The other keys are left alone.
    open(page, 'Timeline')
    const other = new page.window.KeyboardEvent('keydown', {
      key: 'a',
      bubbles: true,
      cancelable: true,
    })
    all(page, '.t-slice[role="button"]')[0]?.dispatchEvent(other)
    assert.equal(other.defaultPrevented, false)
    assert.equal(one(page, '#tab-4').getAttribute('aria-selected'), 'true')
  })

  it('puts a glyph beside the status word in the timeline’s table', () => {
    const page = load(html)
    open(page, 'Timeline')
    click(page, one(page, '[aria-controls="tl-table"]'))
    for (const row of all(page, '#tl-table tbody tr')) {
      const cell = row.querySelectorAll('td')[5] as HTMLElement
      assert.equal(cell.querySelector('svg.icon')?.getAttribute('aria-hidden'), 'true')
      assert.match(text(cell), /^(passed|failed|skipped|todo|crashed)$/)
    }
  })

  it('says the tests are all shown when a search or a chip is cleared, and shows nothing before one is set', () => {
    const page = load(html)
    open(page, 'Tests')
    const note = one(page, '.note[role="status"]')
    assert.equal(text(note), '')
    // Emptying the box.
    search(page, 'math')
    assert.equal(text(note), '3 tests shown in 1 file.')
    search(page, '')
    assert.equal(text(note), 'All tests shown.')
    assert.equal(all(page, '.node.k-file').length, 8)
    // Escape in the box clears it at once.
    search(page, 'math')
    const input = one(page, '#search') as unknown as HTMLInputElement
    const escapeKey = new page.window.KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    })
    input.dispatchEvent(escapeKey)
    assert.equal(escapeKey.defaultPrevented, true)
    assert.equal(input.value, '')
    assert.equal(text(note), 'All tests shown.')
    assert.equal(all(page, '.node.k-file').length, 8)
    // A native clear that then fires `input` changes nothing more.
    input.dispatchEvent(new page.window.Event('input', { bubbles: true }))
    page.flush()
    assert.equal(text(note), 'All tests shown.')
    // Escape in an empty box does nothing.
    const again = new page.window.KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    })
    input.dispatchEvent(again)
    assert.equal(again.defaultPrevented, false)
    // A chip that is turned off again restores the whole tree the same way.
    const chip = all(page, '.toolbar .chip')[0] as Element
    click(page, chip)
    assert.equal(text(note), '2 tests shown in 3 files.')
    click(page, chip)
    assert.equal(text(note), 'All tests shown.')
    assertClean(page)
  })

  it('has no heading that skips a level on a run with nothing to show, or one that passed', async () => {
    for (const state of ['empty', 'all-passed'] as const) {
      const page = load(await sampleHtml(state))
      assertNoSkippedLevel(page)
      assert.equal(all(page, 'main').length, 1)
      assertClean(page)
    }
  })
})

describe('the report page, redrawing and the tree’s keys', () => {
  let html = ''
  beforeAll(async () => {
    ;({ html } = await reportFor())
  })

  it('draws one timeline after a resize on another tab: the stale one is cleared, not added to', () => {
    const page = load(html)
    open(page, 'Timeline')
    assert.equal(all(page, '.timeline').length, 1)
    open(page, 'Map')
    page.window.dispatchEvent(new page.window.Event('resize'))
    page.flush()
    // Not on screen, so nothing is built for it until it is.
    assert.equal(one(page, '#panel-4').childElementCount, 0)
    open(page, 'Timeline')
    assert.equal(all(page, '.timeline').length, 1)
    assert.equal(all(page, '#tl-table').length, 1)
    assert.equal(all(page, '[id^="t-f-"]').length, 8)
    // A resize on the Timeline itself draws it again in place.
    page.window.dispatchEvent(new page.window.Event('resize'))
    page.flush()
    assert.equal(all(page, '.timeline').length, 1)
    assert.equal(all(page, '#tl-table').length, 1)
    assertClean(page)
  })

  it('draws only the tab on screen when the range changes, and the others when they are next shown', () => {
    const page = load(html)
    open(page, 'Tests')
    open(page, 'Folders')
    open(page, 'Map')
    applyRange(page, '0', '0.015')
    // Map is on screen and drawn for the range; Tests and Folders were drawn and are cleared.
    assert.equal(all(page, '#panel-2 .cell.dim').length, 3)
    assert.equal(one(page, '#panel-1').childElementCount, 0)
    assert.equal(one(page, '#panel-3').childElementCount, 0)
    // Shown again, each is drawn for the range.
    open(page, 'Tests')
    assert.equal(all(page, '.node.k-file').length, 5)
    open(page, 'Folders')
    assert.equal(text(all(page, '.folders tbody td')[2]), '26 ms')
    click(page, one(page, '.range button:not([aria-controls])'))
    open(page, 'Tests')
    assert.equal(all(page, '.node.k-file').length, 8)
    assertClean(page)
  })

  it('leaves the tree a tab stop after a range is set on another tab', () => {
    const page = load(html)
    open(page, 'Tests')
    open(page, 'Map')
    applyRange(page, '0', '0.015')
    open(page, 'Tests')
    const stops = all(page, '[role="treeitem"]').filter((item) => item.tabIndex === 0)
    assert.equal(stops.length, 1)
    assert.equal(stops[0], one(page, '.treeitem'))
    // And a key moves from it.
    stops[0]?.focus()
    press(page, stops[0] as Element, 'ArrowDown')
    assert.notEqual(page.document.activeElement, stops[0])
    assert.equal(page.document.activeElement?.getAttribute('role'), 'treeitem')
    assertClean(page)
  })

  it('walks the tree in document order with Down and back with Up, through open and closed groups', () => {
    const page = load(html)
    open(page, 'Tests')
    // Open a few more levels, so the walk goes in and out of groups.
    for (const path of ['math.test.ts', 'skipped.test.ts']) {
      const item = fileItem(page, path)
      item.focus()
      press(page, item, 'ArrowRight')
    }
    const shown = (): HTMLElement[] =>
      all(page, '[role="treeitem"]').filter(
        (item) => item.parentElement?.closest('[hidden]') == null,
      )
    const order = shown()
    assert.ok(order.length > 10, `only ${order.length} items shown`)
    const first = order[0] as HTMLElement
    first.focus()
    const down: Element[] = [first]
    for (let step = 1; step < order.length; step++) {
      press(page, page.document.activeElement as Element, 'ArrowDown')
      down.push(page.document.activeElement as Element)
    }
    assert.deepEqual(down, order)
    // Down on the last item stays on it, and End goes to it from anywhere.
    const last = order[order.length - 1] as HTMLElement
    press(page, last, 'ArrowDown')
    assert.equal(page.document.activeElement, last)
    first.focus()
    press(page, first, 'End')
    assert.equal(page.document.activeElement, last)
    const up: Element[] = [last]
    for (let step = 1; step < order.length; step++) {
      press(page, page.document.activeElement as Element, 'ArrowUp')
      up.push(page.document.activeElement as Element)
    }
    assert.deepEqual(up, [...order].reverse())
    // Up on the first stays on it, and Home returns to it.
    press(page, first, 'ArrowUp')
    assert.equal(page.document.activeElement, first)
    last.focus()
    press(page, last, 'Home')
    assert.equal(page.document.activeElement, first)
    assertClean(page)
  })
})

describe('the report page, with more failures than the report keeps the text of', () => {
  it('lists every failed file, the ones past the cap without text, and says how many', async () => {
    const files: TimedFile[] = Array.from({ length: 2000 }, (_, n) => ({
      spec: {
        path: `broken-${n}.test.ts`,
        state: 'fail' as const,
        errors: [{ name: 'Error', message: 'y'.repeat(100) }],
      },
      workerId: 0,
      startMs: n,
      endMs: n + 1,
    }))
    const { html } = await reportFor(files)
    const page = load(html)
    assertClean(page)
    assert.equal(all(page, '.failure').length, 2000)
    assert.match(
      text(one(page, '.note')),
      /^1,000 more failures are listed without text: the report keeps the text of 1,000 of 2,000\.$/,
    )
    // The ones past the cap say so where their text would be.
    const heads = all(page, '.failure-first').map(text)
    assert.equal(
      heads.filter((line) => line.startsWith('Failed (the report keeps no text')).length,
      1000,
    )
    assert.equal(headline(page), '2,000 files failed to run')
  })
})

describe('the report page, building only what is shown', () => {
  let html = ''
  beforeAll(async () => {
    ;({ html } = await reportFor())
  })

  it('builds a failure’s body when its row is first opened, and not again', () => {
    const page = load(html)
    const rows = all(page, '.failure')
    assert.equal(rows.length, 3)
    const bodies = all(page, '.failure-body')
    // Every head still controls a body that is in the document; only the open first row has content.
    for (const row of rows) {
      const head = row.querySelector('.failure-head') as Element
      assert.equal(row.querySelector('.failure-body')?.id, head.getAttribute('aria-controls'))
    }
    assert.deepEqual(
      bodies.map((body) => body.childElementCount),
      [2, 0, 0],
    )
    assert.deepEqual(
      bodies.map((body) => body.hidden),
      [false, true, true],
    )
    // Opening the second builds its frame and its links; closing and opening again adds nothing.
    const head = rows[1]?.querySelector('.failure-head') as Element
    click(page, head)
    assert.equal(head.getAttribute('aria-expanded'), 'true')
    assert.equal(bodies[1]?.hidden, false)
    assert.equal(bodies[1]?.querySelectorAll('pre').length, 1)
    assert.match(text(bodies[1]?.querySelector('.links')), /^Show in Tests/)
    click(page, head)
    assert.equal(bodies[1]?.hidden, true)
    assert.equal(head.getAttribute('aria-expanded'), 'false')
    click(page, head)
    assert.equal(bodies[1]?.querySelectorAll('pre').length, 1)
    assert.equal(bodies[1]?.querySelectorAll('.links').length, 1)
    // A click in the body is not a click on the row.
    click(page, bodies[1]?.querySelector('pre') as Element)
    assert.equal(head.getAttribute('aria-expanded'), 'true')
    assert.equal(bodies[1]?.hidden, false)
    // A link in the body works as it did: it takes the failure to its file.
    click(page, bodies[1]?.querySelector('.links button') as Element)
    assert.equal(one(page, '#tab-1').getAttribute('aria-selected'), 'true')
    assertClean(page)
  })

  it('writes a code frame as a few text nodes between its coloured lines, with the same text', () => {
    const page = load(html)
    const frame = one(page, '.failure-body pre code')
    const nodes = [...frame.childNodes]
    // No two text nodes side by side: each run of plain lines is one.
    nodes.forEach((node, index) => {
      if (index > 0) assert.ok(node.nodeType === 1 || nodes[index - 1]?.nodeType === 1)
    })
    assert.ok(frame.querySelector('.hl'))
    assert.equal(frame.textContent?.endsWith('\n'), true)
    // The row's first line is the first line with something on it.
    const first = one(page, '.failure-first')
    assert.equal(
      text(first),
      (frame.textContent ?? '')
        .split('\n')
        .find((line) => line.trim() !== '')
        ?.trim(),
    )
  })

  it('builds the tree once when a file is revealed: fresh from another tab, or again when it was there', () => {
    const page = load(html)
    const proto = page.window.Element.prototype
    const append = proto.append
    let builds = 0
    proto.append = function (this: Element, ...nodes: (Node | string)[]) {
      if (
        nodes.some(
          (node) => typeof node !== 'string' && (node as Element).classList?.contains('tree'),
        )
      ) {
        builds++
      }
      return append.apply(this, nodes)
    }
    // Tests has never been shown: opening a file from the Map builds it once.
    open(page, 'Map')
    click(page, all(page, '.map-grid button.cell')[0] as Element)
    assert.equal(builds, 1)
    assert.equal(one(page, '#tab-1').getAttribute('aria-selected'), 'true')
    assert.ok(all(page, '.node.is-active').length === 1)
    // Tests is there: it is built again for the file, once.
    builds = 0
    open(page, 'Map')
    click(page, all(page, '.map-grid button.cell')[3] as Element)
    assert.equal(builds, 1)
    assert.ok(all(page, '.node.is-active').length === 1)
    assertClean(page)
  })

  it('draws the timeline once, at the width the room measures', () => {
    const page = load(html)
    Object.defineProperty(page.window.HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('lanes-scroll') ? 1000 : 0
      },
    })
    const proto = page.window.Element.prototype
    const append = proto.append
    let charts = 0
    proto.append = function (this: Element, ...nodes: (Node | string)[]) {
      if (
        nodes.some(
          (node) =>
            typeof node !== 'string' &&
            (node as Element).getAttribute?.('role') === 'group' &&
            (node as Element).localName === 'svg',
        )
      ) {
        charts++
      }
      return append.apply(this, nodes)
    }
    open(page, 'Timeline')
    assert.equal(charts, 1)
    assert.equal(all(page, '.timeline').length, 1)
    assert.equal(one(page, '.lanes-scroll svg').getAttribute('viewBox'), '0 0 1000 88')
    assert.equal(all(page, '.t-slice').length, 8)
    assertClean(page)
  })
})
