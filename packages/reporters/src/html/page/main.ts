// The page's script. `renderReport` is written into the report with `Function.prototype.toString()`
// (`render.ts`), so it is one self-contained function: it closes over nothing outside itself (a
// type import is erased, and a reference to anything else throws when the page runs: the jsdom
// test of `page.test.ts` runs it). Every statement inside it ships in the page, so it is kept
// lean: it uses no multi-line template literal and no comment after code (the document drops comment
// lines, blank lines and the spaces that end a line), no `innerHTML` with data (text goes in with
// `textContent` and `append`), and no URL (the SVG namespace is read from the parser).
//
// The design is `DESIGN.md`'s Profiler Panel, built from the compact rows of `ReportData`: a verdict
// bar, a run overview (every worker's files along one time axis, brushed or filtered by a range
// that every view obeys), a sticky tab bar and five views, each built the first time it is shown
// and again when the range changes: Failures, Tests (the `role="tree"`, built a level at a time as
// it opens), Map, Folders and Timeline. The class names are the styling's hooks (`styles.ts`).

import type { FileStatus, ReportData, TestStatus } from './model.ts'

/**
 * Draws `data` into `#report`.
 * @internal
 */
export function renderReport(data: ReportData): void {
  const doc = document
  const mount = doc.getElementById('report')
  if (mount === null) return
  const strings = data.strings
  const str = (id: number): string => strings[id] ?? ''
  const FILE_KIND = ['pass', 'fail', 'skip', 'todo', 'crash'] as const
  const TEST_KIND = ['pass', 'fail', 'skip', 'todo', 'notrun'] as const
  // The word for a status, read by its kind: a file's, a test's, a row's.
  const WORD = {
    pass: 'passed',
    fail: 'failed',
    skip: 'skipped',
    todo: 'todo',
    crash: 'crashed',
    notrun: 'not run',
  } as const
  const MAX_RESULTS = 500

  type Child = Node | string | null | undefined | false
  const el = (
    tag: string,
    attrs: Record<string, string | number | boolean> | null,
    ...children: Child[]
  ): HTMLElement => {
    const node = doc.createElement(tag)
    if (attrs !== null) {
      for (const key of Object.keys(attrs)) {
        const value = attrs[key]
        if (value === false || value === undefined) continue
        if (key === 'class') node.className = String(value)
        else node.setAttribute(key, value === true ? '' : String(value))
      }
    }
    for (const child of children) {
      if (child !== null && child !== undefined && child !== false) node.append(child)
    }
    return node
  }
  const probe = doc.createElement('div')
  probe.innerHTML = '<svg></svg>'
  const SVG_NS = probe.firstElementChild?.namespaceURI ?? null
  const svg = (tag: string, attrs: Record<string, string | number>): SVGElement => {
    const node = doc.createElementNS(SVG_NS, tag) as SVGElement
    for (const key of Object.keys(attrs)) node.setAttribute(key, String(attrs[key]))
    return node
  }
  const icon = (kind: string): SVGElement => {
    const node = svg('svg', {
      class: `icon s-${kind}`,
      viewBox: '0 0 12 12',
      'aria-hidden': 'true',
    })
    node.append(svg('use', { href: `#i-${kind}` }))
    return node
  }
  const num = (n: number): string => n.toLocaleString('en-US')
  const plural = (n: number, one: string, many = `${one}s`): string =>
    `${num(n)} ${n === 1 ? one : many}`
  const ms = (value: number): string => {
    if (value < 0) return '–'
    if (value === 0) return '0 ms'
    if (value < 1) return '<1 ms'
    if (value < 1000) return `${value < 10 ? Math.round(value * 10) / 10 : Math.round(value)} ms`
    if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)} s`
    return `${Math.floor(value / 60_000)}m ${((value % 60_000) / 1000).toFixed(1)} s`
  }
  const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  // The parts that are there, joined by a middle dot.
  const dot = (...parts: (string | false)[]): string =>
    parts.filter((part): part is string => typeof part === 'string').join(' · ')
  const nFail = (text: string): HTMLElement => el('span', { class: 'n-fail' }, text)
  const at = <T>(list: readonly T[], index: number): T => list[index] as T
  const firstLine = (text: string): string =>
    (text.split('\n').find((line) => line.trim() !== '') ?? '').trim()

  // ---- The rows, read once
  interface FileModel {
    i: number
    path: string
    name: string
    project: string
    dir: string
    status: FileStatus
    ms: number
    worker: number
    start: number
    end: number
    expected: number
    tests: number[]
    failed: number
    error: string | null
    placed: boolean
  }
  interface TestModel {
    i: number
    file: number
    titles: string[]
    status: TestStatus
    ms: number
    error: string | null
  }
  const files: FileModel[] = data.files.map((row, i) => {
    const path = str(row[0])
    const slash = path.lastIndexOf('/')
    return {
      i,
      path,
      name: slash < 0 ? path : path.slice(slash + 1),
      project: str(row[7]),
      dir: slash < 0 ? '.' : slash === 0 ? '/' : path.slice(0, slash),
      status: row[1],
      ms: row[2],
      worker: row[3],
      start: row[4],
      end: row[5],
      expected: row[6],
      tests: [],
      failed: 0,
      error: null,
      placed: row[3] >= 0 && row[4] >= 0 && row[5] >= 0,
    }
  })
  const tests: TestModel[] = data.tests.map((row, i) => ({
    i,
    file: row[0],
    titles: row[1].map(str),
    status: row[2],
    ms: row[3],
    error: null,
  }))
  const count: [number, number, number, number, number] = [0, 0, 0, 0, 0]
  for (const test of tests) {
    count[test.status]++
    const file = files[test.file]
    if (file === undefined) continue
    file.tests.push(test.i)
    if (test.status === 1) file.failed++
  }
  // Skipped counts the tests that never ended with the skipped ones.
  const skippedTests = count[2] + count[4]
  for (const row of data.failures) {
    const test = tests[row[0]]
    if (test !== undefined) test.error = row[1]
  }
  for (const row of data.fileErrors) {
    const file = files[row[0]]
    if (file !== undefined) file.error = row[1]
  }
  const broken = (file: FileModel): boolean => file.status === 1 || file.status === 4
  const crashed = files.filter((file) => file.status === 4)
  const failedTests = count[1]
  const filesWithFailures = files.filter((file) => file.failed > 0).length
  const failedToRun = files.filter((file) => file.status === 1 && file.failed === 0).length
  let latest = 0
  for (const file of files) if (file.placed) latest = Math.max(latest, file.end)
  const duration = Math.max(1, data.durationMs, latest)

  // Folders: a file's folder is its path's directory within its project, each with a hue for
  // passing work from 85° to 320°, so no passing hue sits near red.
  interface Folder {
    key: string
    label: string
    hue: number
    files: FileModel[]
  }
  const folderMap = new Map<string, Folder>()
  for (const file of files) {
    const key = `${file.project}\u0000${file.dir}`
    let folder = folderMap.get(key)
    if (folder === undefined) {
      const dir = file.dir.endsWith('/') ? file.dir : `${file.dir}/`
      folder = {
        key,
        label: file.project === '' ? dir : `${file.project} ${dir}`,
        hue: 0,
        files: [],
      }
      folderMap.set(key, folder)
    }
    folder.files.push(file)
  }
  const folders = Array.from(folderMap.values()).sort((a, b) => compare(a.key, b.key))
  folders.forEach((folder, index) => {
    folder.hue = Math.round(85 + ((index * 137.508) % 235))
    folder.files.sort((a, b) => compare(a.path, b.path))
  })
  const folderOf = new Map<number, Folder>()
  for (const folder of folders) for (const file of folder.files) folderOf.set(file.i, folder)
  const paint = (node: SVGElement, file: FileModel): void => {
    const kind = FILE_KIND[file.status]
    node.classList.add('slice', `s-${kind}`)
    if (kind === 'pass') node.style.setProperty('--h', String(folderOf.get(file.i)?.hue ?? 210))
  }

  // Workers in id order; a worker that takes over a crashed worker's lane is labelled as its
  // replacement.
  const placed = files.filter((file) => file.placed)
  const workerIds = Array.from(new Set(placed.map((file) => file.worker))).sort((a, b) => a - b)
  const replaces = new Map<number, number>()
  for (const dead of crashed) {
    if (!dead.placed) continue
    const later = workerIds.filter(
      (id) =>
        id !== dead.worker &&
        !replaces.has(id) &&
        placed.filter((file) => file.worker === id).every((file) => file.start >= dead.end),
    )
    const next = later[0]
    if (next !== undefined) replaces.set(next, dead.worker)
  }

  // The failures, in folder and path order: a file's own error, then its failed tests; the errors
  // that belong to no file last.
  interface Entry {
    file: FileModel | null
    test: TestModel | null
    text: string
  }
  const entries: Entry[] = []
  for (const folder of folders) {
    for (const file of folder.files) {
      if (!broken(file)) continue
      if (file.error !== null) entries.push({ file, test: null, text: file.error })
      for (const index of file.tests) {
        const test = at(tests, index)
        if (test.status === 1) {
          entries.push({
            file,
            test,
            text: test.error ?? 'Failed (the report keeps no text for this failure).',
          })
        }
      }
    }
  }
  for (const text of data.runErrors) entries.push({ file: null, test: null, text })
  const failing = entries.length > 0 || data.reason !== 'passed'

  // ---- State
  let range: [number, number] | null = null
  const inRange = (file: FileModel): boolean =>
    range === null || (file.placed && file.end >= range[0] && file.start <= range[1])
  const listeners: (() => void)[] = []
  const setRange = (next: [number, number] | null): void => {
    range = next
    for (const listener of listeners) listener()
  }

  // ---- Icons: an authored sprite, and the three patterns of the drawn marks
  const sprite = svg('svg', { class: 'sprite', width: 0, height: 0, 'aria-hidden': 'true' })
  const defs = svg('defs', {})
  const symbol = (id: string, ...paths: string[]): void => {
    const node = svg('symbol', { id, viewBox: '0 0 12 12' })
    for (const d of paths) node.append(svg('path', { d }))
    defs.append(node)
  }
  symbol('i-pass', 'M2.5 6.3 4.9 8.6 9.5 3.4')
  symbol('i-fail', 'M3 3l6 6', 'M9 3 3 9')
  symbol('i-skip', 'M2.5 3 5.5 6 2.5 9', 'M6.5 3 9.5 6 6.5 9')
  symbol('i-todo', 'M2.5 9.5 3 7.5 7.8 2.7a1 1 0 0 1 1.5 1.5L4.5 9 2.5 9.5Z')
  symbol('i-crash', 'M6.8 1.5 3 6.6h3l-.8 3.9L9 5.4H6Z')
  symbol('i-notrun', 'M3 6h6')
  symbol('i-chevron', 'M4.5 2.5 8 6l-3.5 3.5')
  const pattern = (id: string, name: string, size: number, rotate: boolean): SVGElement => {
    const node = svg('pattern', { id, width: size, height: size, patternUnits: 'userSpaceOnUse' })
    if (rotate) node.setAttribute('patternTransform', 'rotate(45)')
    node.append(svg('rect', { class: `pat-${name}-base`, width: size, height: size }))
    return node
  }
  const failPattern = pattern('p-fail', 'fail', 4, true)
  failPattern.append(svg('rect', { class: 'pat-fail-mark', width: 1.2, height: 4 }))
  const crashPattern = pattern('p-crash', 'crash', 5, true)
  crashPattern.append(svg('rect', { class: 'pat-crash-mark', width: 1.6, height: 5 }))
  const skipPattern = pattern('p-skip', 'skip', 4, false)
  skipPattern.append(svg('circle', { class: 'pat-skip-mark', cx: 2, cy: 2, r: 0.9 }))
  defs.append(failPattern, crashPattern, skipPattern)
  sprite.append(defs)

  // ---- The verdict bar
  const verdict = el('header', { class: `verdict${failing ? ' is-fail' : ''}` })
  const stop = {
    interrupted: 'Run interrupted',
    terminated: 'Run terminated',
    hangup: 'Terminal closed',
  }
  const what = dot(
    data.reason === 'passed' || data.reason === 'failed' ? false : stop[data.reason],
    failedTests > 0 &&
      `${plural(failedTests, 'test')} failed in ${plural(filesWithFailures, 'file')}`,
    failedToRun > 0 && `${plural(failedToRun, 'file')} failed to run`,
    crashed.length > 0 && `${plural(crashed.length, 'file')} crashed`,
    data.runErrors.length > 0 && `${plural(data.runErrors.length, 'error')} outside the tests`,
  )
  const headline =
    files.length === 0
      ? 'No tests ran'
      : failing
        ? what === ''
          ? 'The run failed'
          : what
        : `All ${plural(count[0], 'test')} passed`
  const verdictMain = el('div', { class: 'verdict-main' })
  verdict.append(verdictMain)
  verdictMain.append(
    el(
      'h1',
      null,
      files.length === 0
        ? null
        : el('span', { class: 'glyph', 'aria-hidden': 'true' }, failing ? '💥' : '🎉'),
      headline,
    ),
  )
  const field = (label: string, value: string, cls = ''): HTMLElement =>
    el('div', null, el('dt', null, label), el('dd', cls === '' ? null : { class: cls }, value))
  const snaps = data.snapshots
  const snapshotText =
    snaps === undefined
      ? ''
      : dot(
          snaps.matched > 0 && `${num(snaps.matched)} passed`,
          snaps.unmatched > 0 && `${num(snaps.unmatched)} failed`,
          snaps.added > 0 && `${num(snaps.added)} written`,
          snaps.updated > 0 && `${num(snaps.updated)} updated`,
          snaps.unchecked > 0 && `${num(snaps.unchecked)} obsolete`,
        )
  verdictMain.append(
    el(
      'dl',
      { class: 'fields' },
      ...(failing
        ? [field('Failed', num(failedTests), 'n-fail'), field('Passed', num(count[0]))]
        : [field('Passed', num(count[0])), field('Failed', num(failedTests))]),
      field('Skipped', num(skippedTests)),
      field('Todo', num(count[3])),
      field('Files', num(files.length)),
      field('Time', ms(data.durationMs)),
      field('Workers', num(workerIds.length)),
      data.seed !== undefined && field('Seed', String(data.seed)),
      snapshotText !== '' && field('Snapshots', snapshotText),
    ),
  )
  const started = new Date(data.startedAt)
  const when = Number.isNaN(started.getTime())
    ? data.startedAt
    : `${started.toISOString().slice(0, 16).replace('T', ' ')} UTC`
  const where = el(
    'p',
    { class: 'where' },
    el('code', null, data.title),
    ` · ${when}`,
    data.sample === true
      ? el('span', null, ' · ', el('span', { class: 'synthetic' }, 'sample data'))
      : null,
  )
  const shell = el('div', null, sprite, verdict)
  if (files.length === 0) {
    verdict.append(where)
    shell.append(
      el(
        'main',
        null,
        el(
          'section',
          { class: 'empty' },
          el('h2', null, 'No test files ran'),
          el(
            'p',
            null,
            "Provino found no test files for this run, so there is nothing to show. Check the project's test match patterns and roots, or the path pattern passed on the command line.",
          ),
          el(
            'p',
            null,
            'A run that finds no files fails unless it is given ',
            el('code', null, '--passWithNoTests'),
            '.',
          ),
        ),
      ),
    )
    mount.replaceChildren(shell)
    return
  }

  // ---- The run overview: every worker as a lane on one axis; a brush or a range filters the views
  const rangeText = el('span', { role: 'status', 'aria-live': 'polite' })
  const rangeNote = el('span', { class: 'sr-only', role: 'status' })
  let ranged = false
  const clear = el('button', { type: 'button', hidden: true }, 'Clear range')
  clear.addEventListener('click', () => setRange(null))
  const pick = el(
    'button',
    { type: 'button', 'aria-expanded': 'false', 'aria-controls': 'range-form' },
    'Select range…',
  )
  const seconds = (duration / 1000).toFixed(1)
  const rangeInput = (id: string, value: string | number): HTMLInputElement =>
    el('input', {
      type: 'number',
      min: 0,
      max: seconds,
      step: 0.1,
      value,
      id,
      inputmode: 'decimal',
    }) as HTMLInputElement
  const fromInput = rangeInput('range-from', 0)
  const toInput = rangeInput('range-to', seconds)
  const rangeForm = el(
    'form',
    { class: 'range-form', id: 'range-form', hidden: true },
    el('label', { for: 'range-from' }, 'From (s)'),
    fromInput,
    el('label', { for: 'range-to' }, 'To (s)'),
    toInput,
    el('button', { type: 'submit', class: 'chip' }, 'Apply'),
    el('button', { type: 'button', class: 'chip', 'data-cancel': '' }, 'Cancel'),
  )
  const rangeErrorText = el('span', null)
  const rangeError = el(
    'p',
    { class: 'field-error', id: 'range-error', hidden: true },
    icon('fail'),
    rangeErrorText,
  )
  rangeForm.append(rangeError)
  const clearRangeError = (): void => {
    for (const input of [fromInput, toInput]) {
      input.setCustomValidity('')
      input.removeAttribute('aria-invalid')
      input.removeAttribute('aria-describedby')
    }
    rangeErrorText.textContent = ''
    rangeError.hidden = true
  }
  const rejectRange = (input: HTMLInputElement, message: string): void => {
    input.setCustomValidity(message)
    input.setAttribute('aria-invalid', 'true')
    input.setAttribute('aria-describedby', 'range-error')
    rangeErrorText.textContent = message
    rangeError.hidden = false
    input.reportValidity()
  }
  for (const input of [fromInput, toInput]) {
    input.addEventListener('input', clearRangeError)
    input.addEventListener('change', clearRangeError)
  }
  const closeForm = (): void => {
    clearRangeError()
    rangeForm.hidden = true
    pick.setAttribute('aria-expanded', 'false')
  }
  pick.addEventListener('click', () => {
    const open = rangeForm.hidden
    rangeForm.hidden = !open
    pick.setAttribute('aria-expanded', String(open))
    if (open) fromInput.focus()
  })
  rangeForm.addEventListener('submit', (event) => {
    event.preventDefault()
    clearRangeError()
    const from = Number(fromInput.value) * 1000
    const to = Number(toInput.value) * 1000
    if (fromInput.value === '' || !Number.isFinite(from)) {
      rejectRange(fromInput, 'Enter the start in seconds.')
      return
    }
    if (toInput.value === '' || !Number.isFinite(to)) {
      rejectRange(toInput, 'Enter the end in seconds.')
      return
    }
    if (to <= from) {
      rejectRange(toInput, 'The end must be after the start.')
      return
    }
    closeForm()
    setRange([Math.max(0, from), Math.min(duration, to)])
    pick.focus()
  })
  rangeForm.addEventListener('click', (event) => {
    if ((event.target as Element).hasAttribute('data-cancel')) {
      closeForm()
      pick.focus()
    }
  })
  const overview = el('section', { class: 'overview', 'aria-labelledby': 'ov-title' })
  overview.append(
    el(
      'div',
      { class: 'overview-head' },
      el('h2', { id: 'ov-title' }, 'Run overview'),
      el(
        'span',
        { class: 'ov-desc' },
        `${plural(workerIds.length, 'worker')} along ${ms(duration)}. Drag across it, or select a range, to filter every view.`,
      ),
      el('span', { class: 'range' }, rangeText, rangeNote, clear, pick),
    ),
    rangeForm,
  )
  const laneH = 56 / Math.max(1, workerIds.length)
  const ov = svg('svg', {
    class: 'ov-chart',
    viewBox: '0 0 1000 56',
    preserveAspectRatio: 'none',
    role: 'img',
    'aria-label': `Timeline of ${plural(placed.length, 'file')} across ${plural(workerIds.length, 'worker')}; the Timeline tab has the same data as a table.`,
    tabindex: 0,
  })
  const ovSlices = new Map<number, SVGElement>()
  workerIds.forEach((_id, lane) => {
    ov.append(
      svg('rect', {
        class: 'lane-track',
        x: 0,
        y: lane * laneH + 0.5,
        width: 1000,
        height: Math.max(1, laneH - 1),
      }),
    )
  })
  const drawSlice = (file: FileModel): void => {
    const rect = svg('rect', {
      x: (file.start / duration) * 1000,
      y: workerIds.indexOf(file.worker) * laneH + 0.5,
      width: Math.max(0.6, ((file.end - file.start) / duration) * 1000),
      height: Math.max(1, laneH - 1),
      'data-f': file.i,
    })
    paint(rect, file)
    ovSlices.set(file.i, rect)
    ov.append(rect)
  }
  for (const file of placed) if (!broken(file)) drawSlice(file)
  for (const file of placed) if (broken(file)) drawSlice(file)
  const brush = svg('rect', {
    class: 'brush',
    x: 0,
    y: 0,
    width: 0,
    height: 56,
    visibility: 'hidden',
  })
  ov.append(brush)
  const showBrush = (from: number, to: number): void => {
    brush.setAttribute('visibility', 'visible')
    brush.setAttribute('x', String((from / duration) * 1000))
    brush.setAttribute('width', String(((to - from) / duration) * 1000))
  }
  overview.append(
    ov,
    el(
      'div',
      { class: 'axis', 'aria-hidden': 'true' },
      el('span', null, '0'),
      el('span', null, ms(duration / 2)),
      el('span', null, ms(duration)),
    ),
  )
  const timeAt = (clientX: number): number => {
    const box = ov.getBoundingClientRect()
    return Math.min(
      duration,
      Math.max(0, ((clientX - box.left) / Math.max(1, box.width)) * duration),
    )
  }
  let dragFrom: number | null = null
  let downOn: Element | null = null
  ov.addEventListener('pointerdown', (event) => {
    dragFrom = timeAt(event.clientX)
    downOn = event.target as Element
    if (typeof ov.setPointerCapture === 'function') ov.setPointerCapture(event.pointerId)
  })
  ov.addEventListener('pointermove', (event) => {
    if (dragFrom === null) return
    const now = timeAt(event.clientX)
    showBrush(Math.min(dragFrom, now), Math.max(dragFrom, now))
  })
  ov.addEventListener('pointerup', (event) => {
    if (dragFrom === null) return
    const now = timeAt(event.clientX)
    const from = dragFrom
    dragFrom = null
    if (Math.abs(now - from) < duration / 400) {
      revealOf(downOn)
      brush.setAttribute('visibility', range === null ? 'hidden' : 'visible')
      return
    }
    setRange([Math.min(from, now), Math.max(from, now)])
  })
  ov.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setRange(null)
  })
  listeners.push(() => {
    clear.hidden = range === null
    if (range === null) {
      rangeText.textContent = ''
      rangeNote.textContent = ranged
        ? `Range cleared. All ${plural(files.length, 'file')} shown.`
        : ''
      ranged = false
      brush.setAttribute('visibility', 'hidden')
    } else {
      ranged = true
      rangeNote.textContent = ''
      rangeText.textContent = `${ms(range[0])} – ${ms(range[1])} · ${plural(files.filter(inRange).length, 'file')}`
      showBrush(range[0], range[1])
    }
    for (const file of placed) ovSlices.get(file.i)?.classList.toggle('dim', !inRange(file))
  })

  // ---- The tab bar
  const tabNames = ['Failures', 'Tests', 'Map', 'Folders', 'Timeline'] as const
  const tabCounts = [entries.length, tests.length, files.length, folders.length, workerIds.length]
  const tabList = el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Report views' })
  const panels: HTMLElement[] = []
  const tabs: HTMLElement[] = []
  const rendered: boolean[] = []
  const renderers: ((panel: HTMLElement) => void)[] = []
  tabNames.forEach((name, index) => {
    const tab = el(
      'button',
      {
        type: 'button',
        class: 'tab',
        role: 'tab',
        id: `tab-${index}`,
        'aria-controls': `panel-${index}`,
        'aria-selected': 'false',
        tabindex: -1,
      },
      name,
      el(
        'span',
        { class: `count${index === 0 && failing ? ' n-fail' : ''}` },
        num(tabCounts[index] ?? 0),
      ),
    )
    tab.addEventListener('click', () => select(index))
    tabs.push(tab)
    tabList.append(tab)
    panels.push(
      el('section', {
        class: 'panel',
        role: 'tabpanel',
        id: `panel-${index}`,
        'aria-labelledby': `tab-${index}`,
        tabindex: 0,
        hidden: true,
      }),
    )
  })
  tabList.addEventListener('keydown', (event) => {
    const current = tabs.indexOf(event.target as HTMLElement)
    if (current < 0) return
    let next = current
    if (event.key === 'ArrowRight') next = (current + 1) % tabs.length
    else if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = tabs.length - 1
    else return
    event.preventDefault()
    select(next)
    tabs[next]?.focus()
  })
  let selected = -1
  function select(index: number): void {
    if (index === selected) return
    selected = index
    tabs.forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === index))
      tab.tabIndex = i === index ? 0 : -1
    })
    panels.forEach((panel, i) => {
      panel.hidden = i !== index
    })
    if (rendered[index] !== true) build(index)
  }
  const heading = (panel: HTMLElement, index: number): void => {
    panel.append(el('h2', { class: 'sr-only' }, tabNames[index] ?? ''))
  }
  // A panel's view, built afresh.
  const build = (index: number): void => {
    const panel = panels[index]
    if (panel === undefined) return
    panel.replaceChildren()
    rendered[index] = true
    renderers[index]?.(panel)
  }
  // What a panel shows changed (the range, the window's size): the one on screen is built again,
  // any other is cleared and built when it is next shown.
  const redraw = (index: number): void => {
    if (index === selected) {
      build(index)
      return
    }
    panels[index]?.replaceChildren()
    rendered[index] = false
  }
  listeners.push(() => {
    for (let index = 0; index < panels.length; index++) redraw(index)
  })

  // ---- An error as a code frame: the first line and the `>` lines are red, the diff is coloured
  const failureText = (text: string): HTMLElement => {
    const pre = el('pre', { role: 'group', 'aria-label': 'Failure output' })
    const code = el('code', null)
    text.split('\n').forEach((line, index) => {
      const trimmed = line.trimStart()
      let cls = ''
      if (index === 0 || trimmed.startsWith('> ')) cls = 'hl'
      else if (/^- /.test(trimmed)) cls = 'add'
      else if (/^\+ /.test(trimmed)) cls = 'del'
      else if (trimmed.startsWith('at ')) cls = 'dim-line'
      code.append(cls === '' ? line : el('span', { class: cls }, line), '\n')
    })
    pre.append(code)
    return pre
  }

  // ---- Failures: a row for each failed test and each file that failed or crashed on its own
  renderers[0] = (panel) => {
    if (!failing) {
      panel.append(
        el(
          'div',
          { class: 'empty' },
          el('h2', null, 'No failures'),
          el(
            'p',
            null,
            `Every one of the ${plural(tests.length, 'test')} passed, was skipped or is a todo.`,
          ),
        ),
      )
      return
    }
    heading(panel, 0)
    const shown = entries.filter((entry) => entry.file === null || inRange(entry.file))
    if (data.omitted > 0) {
      panel.append(
        el(
          'p',
          { class: 'note' },
          `${plural(data.omitted, 'more failed test')} ${data.omitted === 1 ? 'is' : 'are'} listed without text: the report keeps the text of the first ${num(failedTests - data.omitted)}.`,
        ),
      )
    }
    if (shown.length === 0) {
      panel.append(el('p', { class: 'note' }, 'No failures in the selected range.'))
      return
    }
    const list = el('ul', { class: 'failures' })
    shown.forEach((entry, index) => {
      const open = index === 0
      const bodyId = `fb-${index}`
      const { file, test } = entry
      const kind = file === null ? 'fail' : test === null ? FILE_KIND[file.status] : 'fail'
      const title =
        test !== null
          ? test.titles.flatMap((part, i) =>
              i === 0 ? [part] : [el('span', { class: 'sep', 'aria-hidden': 'true' }, '›'), part],
            )
          : [file === null ? 'An error outside any test file' : 'The file failed to finish']
      const head = el(
        'button',
        {
          type: 'button',
          class: 'failure-head',
          'aria-expanded': String(open),
          'aria-controls': bodyId,
        },
        icon(kind),
        el('span', { class: 'failure-file' }, file === null ? 'run' : file.path),
        el(
          'span',
          { class: 'failure-ms' },
          test !== null ? ms(test.ms) : file === null ? '' : WORD[FILE_KIND[file.status]],
        ),
        el(
          'span',
          { class: 'failure-title' },
          el('span', { class: 'sr-only' }, `${WORD[kind]}: `),
          ...title,
        ),
        el('span', { class: 'failure-first' }, firstLine(entry.text)),
      )
      const links = el('div', { class: 'links' })
      if (file !== null) {
        const showTest = el('button', { type: 'button' }, 'Show in Tests')
        showTest.addEventListener('click', () => reveal(file.i))
        links.append(showTest)
        if (file.placed) {
          const showTime = el('button', { type: 'button' }, `Show on worker ${file.worker}`)
          showTime.addEventListener('click', () => {
            select(4)
            doc.getElementById(`t-f-${file.i}`)?.focus()
          })
          links.append(showTime)
        }
      }
      const body = el(
        'div',
        { class: 'failure-body', id: bodyId, hidden: !open },
        failureText(entry.text),
        links,
      )
      head.addEventListener('click', () => {
        const next = head.getAttribute('aria-expanded') !== 'true'
        head.setAttribute('aria-expanded', String(next))
        body.hidden = !next
      })
      list.append(el('li', { class: 'failure' }, head, body))
    })
    panel.append(list)
  }

  // ---- Tests: the tree. A node builds what is under it the first time it opens.
  let nodeSeq = 0
  const builders = new WeakMap<HTMLElement, () => void>()
  const groups = new WeakMap<HTMLElement, HTMLElement>()
  let treeFocus: HTMLElement | null = null
  let activeRow: HTMLElement | null = null
  let fileItems = new Map<number, HTMLElement>()
  let folderItems = new Map<string, HTMLElement>()
  const statusFilter = new Set<number>()
  let query = ''
  let filtered = false
  const setOpen = (item: HTMLElement, open: boolean): void => {
    if (item.getAttribute('aria-expanded') === null) return
    if (open) {
      const build = builders.get(item)
      if (build !== undefined) {
        builders.delete(item)
        build()
      }
    }
    const group = groups.get(item)
    if (group !== undefined) group.hidden = !open
    item.setAttribute('aria-expanded', String(open))
  }
  interface RowSpec {
    kind: string
    level: number
    tone: keyof typeof WORD
    label: string
    title: string
    meta: Child[]
    fill: ((group: HTMLElement) => void) | null
    open: boolean
  }
  const makeItem = (spec: RowSpec): HTMLElement => {
    const id = `ti-${++nodeSeq}`
    const item = el('div', {
      class: 'treeitem',
      role: 'treeitem',
      'aria-level': spec.level,
      tabindex: -1,
      'aria-labelledby': `${id}-row`,
    })
    item.style.setProperty('--level', String(spec.level - 1))
    const meta = el('span', { class: 'meta' })
    for (const part of spec.meta) {
      if (part === null || part === undefined || part === false) continue
      meta.append(part, ' ')
    }
    let twisty: HTMLElement | SVGElement = el('span', null)
    if (spec.fill !== null) {
      twisty = svg('svg', { class: 'twisty icon', viewBox: '0 0 12 12', 'aria-hidden': 'true' })
      twisty.append(svg('use', { href: '#i-chevron' }))
    }
    const row = el(
      'div',
      { class: `node k-${spec.kind}`, id: `${id}-row` },
      el('span', null),
      twisty,
      icon(spec.tone),
      el(
        'span',
        { class: 'label', title: spec.title === '' ? false : spec.title },
        el('span', { class: 'sr-only' }, `${WORD[spec.tone]} `),
        spec.label,
      ),
      meta,
    )
    item.append(row)
    if (spec.fill !== null) {
      const fill = spec.fill
      const group = el('div', { role: 'group', hidden: true })
      item.setAttribute('aria-expanded', 'false')
      item.append(group)
      groups.set(item, group)
      builders.set(item, () => fill(group))
      if (spec.open) setOpen(item, true)
    }
    return item
  }
  // An error's frame inside the tree, indented to `level` when it is not a test's own.
  const inlineError = (text: string, level?: number): HTMLElement => {
    const box = failureText(text)
    box.className = 'inline-error'
    if (level !== undefined) box.style.setProperty('--level', String(level))
    return box
  }
  const errorBox = (item: HTMLElement, text: string): void => {
    const box = inlineError(text)
    const textId = `eb-${++nodeSeq}`
    const code = box.firstElementChild
    if (code !== null) code.id = textId
    item.append(box)
    item.setAttribute('aria-describedby', textId)
  }
  const testItem = (test: TestModel, level: number): HTMLElement => {
    const item = makeItem({
      kind: 'test',
      level,
      tone: TEST_KIND[test.status],
      label: test.titles[test.titles.length - 1] ?? '',
      title: test.titles.join(' › '),
      meta: [test.status === 0 || test.status === 1 ? ms(test.ms) : WORD[TEST_KIND[test.status]]],
      fill: null,
      open: false,
    })
    if (test.error !== null) errorBox(item, test.error)
    else if (test.status === 1)
      errorBox(item, 'Failed (the report keeps no text for this failure).')
    return item
  }
  interface Suite {
    title: string
    suites: Map<string, Suite>
    kids: (Suite | TestModel)[]
    tests: number
    failed: number
  }
  const suiteOf = (list: readonly number[]): Suite => {
    const top: Suite = { title: '', suites: new Map(), kids: [], tests: 0, failed: 0 }
    for (const index of list) {
      const test = at(tests, index)
      const path: Suite[] = [top]
      let suite = top
      for (const title of test.titles.slice(0, -1)) {
        let next = suite.suites.get(title)
        if (next === undefined) {
          next = { title, suites: new Map(), kids: [], tests: 0, failed: 0 }
          suite.suites.set(title, next)
          suite.kids.push(next)
        }
        suite = next
        path.push(suite)
      }
      suite.kids.push(test)
      for (const each of path) {
        each.tests++
        if (test.status === 1) each.failed++
      }
    }
    return top
  }
  const addKids = (group: HTMLElement, suite: Suite, level: number, forceOpen: boolean): void => {
    for (const kid of suite.kids) {
      if ('titles' in kid) {
        group.append(testItem(kid, level))
        continue
      }
      group.append(
        makeItem({
          kind: 'suite',
          level,
          tone: kid.failed > 0 ? 'fail' : 'pass',
          label: kid.title,
          title: '',
          meta: [
            kid.failed > 0 && nFail(`${num(kid.failed)} failed`),
            el('span', null, plural(kid.tests, 'test')),
          ],
          fill: (inner) => addKids(inner, kid, level + 1, forceOpen),
          open: kid.failed > 0 || forceOpen,
        }),
      )
    }
  }
  const fileItem = (
    file: FileModel,
    only: readonly number[] | null,
    level: number,
    forceOpen: boolean,
    label: string,
  ): HTMLElement => {
    const ran = file.tests.filter((index) => at(tests, index).status !== 4).length
    const item = makeItem({
      kind: 'file',
      level,
      tone: FILE_KIND[file.status],
      label,
      title: file.path,
      meta: [
        file.status === 4
          ? nFail('crashed')
          : file.failed > 0 && nFail(`${num(file.failed)} failed`),
        el(
          'span',
          null,
          plural(
            only === null ? ran : only.length,
            only === null ? 'test' : 'match',
            only === null ? 'tests' : 'matches',
          ),
        ),
        file.expected > 0 &&
          file.ms > file.expected * 1.5 &&
          file.ms > 1000 &&
          el('span', { class: 'slow' }, 'slow'),
        el('span', null, ms(file.ms)),
      ],
      fill:
        file.tests.length > 0 || file.error !== null
          ? (group) => {
              if (file.error !== null) group.append(inlineError(file.error, level))
              addKids(group, suiteOf(only ?? file.tests), level + 1, forceOpen)
            }
          : null,
      open: forceOpen || broken(file),
    })
    fileItems.set(file.i, item)
    return item
  }
  const folderItem = (folder: Folder, shown: FileModel[]): HTMLElement => {
    const failed = shown.filter(broken).length
    const item = makeItem({
      kind: 'folder',
      level: 1,
      tone: failed > 0 ? 'fail' : 'pass',
      label: folder.label,
      title: '',
      meta: [
        failed > 0 && nFail(`${num(failed)} failed`),
        el('span', null, plural(shown.length, 'file')),
        el('span', null, ms(shown.reduce((sum, file) => sum + file.ms, 0))),
      ],
      fill: (group) => {
        for (const file of shown) group.append(fileItem(file, null, 2, false, file.name))
      },
      open: failed > 0,
    })
    folderItems.set(folder.key, item)
    return item
  }
  // The tree's items in the order the arrow keys walk them: an item, then its children when it is
  // open, then its next sibling, and so on up. Each step is along the DOM from the item, and an
  // item is open or closed by its own state, not by whether the panel it is in is on screen.
  const isItem = (node: Element | null): node is HTMLElement =>
    node !== null && node.getAttribute('role') === 'treeitem'
  const sibling = (item: Element, before: boolean): HTMLElement | null => {
    let node = before ? item.previousElementSibling : item.nextElementSibling
    while (node !== null && !isItem(node)) {
      node = before ? node.previousElementSibling : node.nextElementSibling
    }
    return node
  }
  const edgeItem = (parent: Element | undefined, last: boolean): HTMLElement | null => {
    let node = last ? (parent?.lastElementChild ?? null) : (parent?.firstElementChild ?? null)
    while (node !== null && !isItem(node)) {
      node = last ? node.previousElementSibling : node.nextElementSibling
    }
    return node
  }
  const childrenOf = (item: HTMLElement): HTMLElement | undefined =>
    item.getAttribute('aria-expanded') === 'true' ? groups.get(item) : undefined
  const parentItem = (item: HTMLElement): HTMLElement | null =>
    item.parentElement?.closest<HTMLElement>('[role="treeitem"]') ?? null
  const lastShown = (item: HTMLElement): HTMLElement => {
    let node = item
    for (let inner = edgeItem(childrenOf(node), true); inner !== null; ) {
      node = inner
      inner = edgeItem(childrenOf(node), true)
    }
    return node
  }
  const itemAfter = (item: HTMLElement): HTMLElement | null => {
    const inside = edgeItem(childrenOf(item), false)
    if (inside !== null) return inside
    for (let node: HTMLElement | null = item; node !== null; node = parentItem(node)) {
      const next = sibling(node, false)
      if (next !== null) return next
    }
    return null
  }
  const itemBefore = (item: HTMLElement): HTMLElement | null => {
    const before = sibling(item, true)
    return before === null ? parentItem(item) : lastShown(before)
  }
  const focusItem = (
    item: HTMLElement | null | undefined,
    block: ScrollLogicalPosition = 'nearest',
  ): void => {
    if (item === null || item === undefined) return
    if (treeFocus !== null && treeFocus !== item) treeFocus.tabIndex = -1
    item.tabIndex = 0
    treeFocus = item
    // The item holds its children: scrolling it whole can leave its own row off screen or under
    // the sticky tab bar, so the row is the one that is scrolled to.
    item.focus({ preventScroll: true })
    const row = item.querySelector<HTMLElement>(':scope > .node')
    if (row !== null && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block })
  }
  const searchNote = el('p', { class: 'note', role: 'status' })
  const buildTree = (container: HTMLElement): void => {
    fileItems = new Map()
    folderItems = new Map()
    activeRow = null
    treeFocus = null
    const tree = el('div', {
      class: 'tree',
      role: 'tree',
      'aria-label': 'Tests by folder and file',
    })
    const searching = query !== '' || statusFilter.size > 0
    if (!searching) {
      searchNote.textContent = filtered ? 'All tests shown.' : ''
      for (const folder of folders) {
        const shown = folder.files.filter(inRange)
        if (shown.length > 0) tree.append(folderItem(folder, shown))
      }
      if (data.runErrors.length > 0 && range === null) {
        const item = makeItem({
          kind: 'file',
          level: 1,
          tone: 'fail',
          label: 'Errors outside any test file',
          title: '',
          meta: [nFail(plural(data.runErrors.length, 'error'))],
          fill: (group) => {
            for (const text of data.runErrors) group.append(inlineError(text, 1))
          },
          open: true,
        })
        tree.append(item)
      }
    } else {
      const needle = query.toLowerCase()
      let matches = 0
      let over = 0
      let shownFiles = 0
      for (const folder of folders) {
        for (const file of folder.files) {
          if (!inRange(file)) continue
          const pathHit = needle !== '' && file.path.toLowerCase().includes(needle)
          const hits: number[] = []
          for (const index of file.tests) {
            const test = at(tests, index)
            if (statusFilter.size > 0 && !statusFilter.has(test.status === 4 ? 2 : test.status))
              continue
            if (
              needle !== '' &&
              !pathHit &&
              !test.titles.join(' › ').toLowerCase().includes(needle)
            )
              continue
            if (matches >= MAX_RESULTS) {
              over++
              continue
            }
            hits.push(index)
            matches++
          }
          // A file with no test to show (a crash, a collection error) is found by its path.
          const bare =
            file.tests.length === 0 &&
            file.error !== null &&
            (statusFilter.size === 0 || statusFilter.has(1)) &&
            (needle === '' || pathHit)
          if (hits.length === 0 && !bare) continue
          shownFiles++
          tree.append(fileItem(file, hits, 1, true, file.path))
        }
      }
      searchNote.textContent =
        matches === 0 && shownFiles === 0
          ? 'No tests match.'
          : `${plural(matches, 'test')} shown in ${plural(shownFiles, 'file')}${over > 0 ? `; ${num(over)} more match, so refine the filter` : ''}.`
    }
    filtered = searching
    container.append(tree)
    const first = edgeItem(tree, false)
    if (first !== null) {
      first.tabIndex = 0
      treeFocus = first
    }
    tree.addEventListener('click', (event) => {
      const row = (event.target as Element).closest('.node')
      const item = row?.parentElement ?? null
      if (item === null || row === null || row === undefined) return
      const state = item.getAttribute('aria-expanded')
      if (state !== null) setOpen(item, state === 'false')
      focusItem(item)
    })
    tree.addEventListener('keydown', (event) => {
      const current = event.target as HTMLElement
      if (
        current.getAttribute('role') !== 'treeitem' ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      )
        return
      const state = current.getAttribute('aria-expanded')
      switch (event.key) {
        case 'ArrowDown':
          focusItem(itemAfter(current))
          break
        case 'ArrowUp':
          focusItem(itemBefore(current))
          break
        case 'Home':
          focusItem(edgeItem(tree, false))
          break
        case 'End': {
          const last = edgeItem(tree, true)
          focusItem(last === null ? null : lastShown(last))
          break
        }
        case 'ArrowRight':
          if (state === 'false') setOpen(current, true)
          else if (state === 'true')
            focusItem(current.querySelector<HTMLElement>('[role="treeitem"]'))
          break
        case 'ArrowLeft':
          if (state === 'true') setOpen(current, false)
          else focusItem(current.parentElement?.closest<HTMLElement>('[role="treeitem"]'))
          break
        case 'Enter':
        case ' ':
          if (state !== null) setOpen(current, state === 'false')
          break
        default:
          return
      }
      event.preventDefault()
    })
  }
  let treeHost: HTMLElement | null = null
  let searchInput: HTMLInputElement | null = null
  const rebuildTree = (): void => {
    if (treeHost === null) return
    treeHost.replaceChildren()
    buildTree(treeHost)
  }
  renderers[1] = (panel) => {
    heading(panel, 1)
    const input = el('input', {
      class: 'search',
      id: 'search',
      type: 'search',
      placeholder: 'Filter by file path or test name',
      'aria-label': 'Filter tests by file path or test name',
      value: query,
    }) as HTMLInputElement
    searchInput = input
    let timer: ReturnType<typeof setTimeout> | undefined
    input.addEventListener('input', () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (input.value.trim() === query) return
        query = input.value.trim()
        rebuildTree()
      }, 140)
    })
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || input.value === '') return
      event.preventDefault()
      clearTimeout(timer)
      input.value = ''
      query = ''
      rebuildTree()
    })
    const chip = (label: string, status: TestStatus, n: number): HTMLElement => {
      const button = el(
        'button',
        { type: 'button', class: 'chip', 'aria-pressed': String(statusFilter.has(status)) },
        icon(TEST_KIND[status]),
        `${label} ${num(n)}`,
      )
      button.addEventListener('click', () => {
        if (statusFilter.has(status)) statusFilter.delete(status)
        else statusFilter.add(status)
        button.setAttribute('aria-pressed', String(statusFilter.has(status)))
        rebuildTree()
      })
      return button
    }
    panel.append(
      el(
        'div',
        { class: 'toolbar' },
        input,
        failedTests > 0 && chip('Failed', 1, failedTests),
        skippedTests > 0 && chip('Skipped', 2, skippedTests),
        count[3] > 0 && chip('Todo', 3, count[3]),
      ),
      searchNote,
    )
    treeHost = el('div', null)
    panel.append(treeHost)
    buildTree(treeHost)
  }
  // Reveals the file an element stands for (its `data-f`), and says whether it stood for one.
  function revealOf(node: Element | null | undefined): boolean {
    const index = node?.getAttribute('data-f') ?? null
    if (index === null) return false
    reveal(Number(index))
    return true
  }
  function reveal(fileIndex: number): void {
    const file = files[fileIndex]
    if (file === undefined) return
    query = ''
    statusFilter.clear()
    if (range !== null && !inRange(file)) setRange(null)
    select(1)
    if (searchInput !== null) searchInput.value = ''
    rebuildTree()
    const folder = folderOf.get(file.i)
    const folderNode = folder === undefined ? undefined : folderItems.get(folder.key)
    if (folderNode !== undefined) setOpen(folderNode, true)
    const node = fileItems.get(file.i)
    if (node === undefined) return
    setOpen(node, true)
    if (activeRow !== null) activeRow.classList.remove('is-active')
    activeRow = node.firstElementChild as HTMLElement | null
    if (activeRow !== null) activeRow.classList.add('is-active')
    focusItem(node, 'center')
  }

  // ---- Map: a square for each file, by folder, in the patterned vocabulary
  renderers[2] = (panel) => {
    heading(panel, 2)
    const legend = el('ul', { class: 'legend' })
    const key = (kind: string, label: string): void => {
      legend.append(
        el('li', null, el('span', { class: `cell s-${kind}`, 'aria-hidden': 'true' }), label),
      )
    }
    key('pass', 'passed')
    key('fail', 'failed (hatched)')
    key('crash', 'crashed (cross-hatched)')
    key('skip', 'skipped (dotted)')
    key('todo', 'todo (outline)')
    panel.append(
      legend,
      el(
        'p',
        { class: 'note', id: 'map-help' },
        'One square per file, by folder. Select a square, or move with the arrow keys and press Enter, to open its file in Tests.',
      ),
    )
    const grid = el('div', {
      class: 'map-grid',
      role: 'group',
      'aria-label': 'Files by folder',
      'aria-describedby': 'map-help',
    })
    panel.append(grid)
    const cells: HTMLElement[] = []
    const move = (from: HTMLElement, to: HTMLElement | undefined): void => {
      if (to === undefined) return
      from.tabIndex = -1
      to.tabIndex = 0
      to.focus()
    }
    const rowAbove = (from: HTMLElement, down: boolean): HTMLElement | undefined => {
      const box = from.getBoundingClientRect()
      const lines = cells.filter((cell) => {
        const top = cell.getBoundingClientRect().top
        return down ? top > box.top + 2 : top < box.top - 2
      })
      let nextTop = down ? Infinity : -Infinity
      for (const cell of lines) {
        const top = cell.getBoundingClientRect().top
        nextTop = down ? Math.min(nextTop, top) : Math.max(nextTop, top)
      }
      let best: HTMLElement | undefined
      for (const cell of lines) {
        const rect = cell.getBoundingClientRect()
        if (Math.abs(rect.top - nextTop) >= 2) continue
        if (
          best === undefined ||
          Math.abs(rect.left - box.left) < Math.abs(best.getBoundingClientRect().left - box.left)
        )
          best = cell
      }
      return best
    }
    grid.addEventListener('keydown', (event) => {
      const current = event.target as HTMLElement
      const position = cells.indexOf(current)
      if (position < 0) return
      const keyName = event.key
      if (keyName === 'ArrowRight') move(current, cells[position + 1])
      else if (keyName === 'ArrowLeft') move(current, cells[position - 1])
      else if (keyName === 'Home') move(current, cells[0])
      else if (keyName === 'End') move(current, cells[cells.length - 1])
      else if (keyName === 'ArrowDown' || keyName === 'ArrowUp')
        move(current, rowAbove(current, keyName === 'ArrowDown'))
      else if (keyName === 'Enter') revealOf(current)
      else return
      event.preventDefault()
    })
    grid.addEventListener('click', (event) => {
      revealOf((event.target as Element).closest('button.cell'))
    })
    for (const folder of folders) {
      const row = el('div', { class: 'cells', role: 'group', 'aria-label': folder.label })
      let failed = 0
      let crashedHere = 0
      for (const file of folder.files) {
        if (file.status === 1) failed++
        if (file.status === 4) crashedHere++
        const kind = FILE_KIND[file.status]
        const word = WORD[kind]
        const cell = el('button', {
          type: 'button',
          class: `cell s-${kind}${inRange(file) ? '' : ' dim'}`,
          title: `${file.path} · ${word} · ${ms(file.ms)}`,
          'aria-label': `${file.path}, ${word}, ${plural(file.tests.length, 'test')}, ${ms(file.ms)}`,
          tabindex: cells.length === 0 ? 0 : -1,
          'data-f': file.i,
        })
        cells.push(cell)
        row.append(cell)
      }
      const summary = dot(
        failed > 0 && `${num(failed)} failed`,
        crashedHere > 0 && `${num(crashedHere)} crashed`,
      )
      grid.append(
        el(
          'div',
          { class: `map-block${summary === '' ? '' : ' has-fail'}` },
          el(
            'h3',
            { title: folder.label },
            folder.label,
            el(
              'span',
              null,
              summary === ''
                ? num(folder.files.length)
                : `${summary} of ${num(folder.files.length)}`,
            ),
          ),
          row,
        ),
      )
    }
  }

  // ---- Folders: time by folder, slowest first
  renderers[3] = (panel) => {
    heading(panel, 3)
    const rows = folders
      .map((folder) => {
        const shown = folder.files.filter(inRange)
        return {
          folder,
          shown,
          time: shown.reduce((sum, file) => sum + file.ms, 0),
          failed: shown.filter(broken).length,
        }
      })
      .filter((entry) => entry.shown.length > 0)
      .sort((a, b) => b.time - a.time)
    const total = rows.reduce((sum, entry) => sum + entry.time, 0)
    const max = rows[0]?.time ?? 1
    const table = el(
      'table',
      { class: 'folders' },
      el('caption', { class: 'sr-only' }, 'Time spent in each folder, slowest first'),
      el(
        'thead',
        null,
        el(
          'tr',
          null,
          el('th', { scope: 'col' }, 'Folder'),
          el(
            'th',
            { scope: 'col', class: 'bar-cell' },
            el('span', { class: 'sr-only' }, 'Share of time'),
          ),
          el('th', { scope: 'col', class: 'num' }, 'Time'),
          el('th', { scope: 'col', class: 'num' }, 'Share'),
          el('th', { scope: 'col', class: 'num col-files' }, 'Files'),
          el('th', { scope: 'col', class: 'col-files' }, 'Slowest file'),
        ),
      ),
    )
    const body = el('tbody', null)
    for (const entry of rows) {
      const slowest = entry.shown.slice().sort((a, b) => b.ms - a.ms)[0]
      const bar = el('div', { class: `bar${entry.failed > 0 ? ' has-fail' : ''}` })
      bar.style.width = `${Math.max(1, (entry.time / max) * 100).toFixed(1)}%`
      bar.style.setProperty('--h', String(entry.folder.hue))
      body.append(
        el(
          'tr',
          null,
          el(
            'td',
            { class: 'path' },
            entry.folder.label,
            entry.failed > 0
              ? el('span', { class: 's-fail' }, ` · ${num(entry.failed)} failed`)
              : null,
          ),
          el('td', { class: 'bar-cell', 'aria-hidden': 'true' }, bar),
          el('td', { class: 'num' }, ms(entry.time)),
          el('td', { class: 'num' }, `${((entry.time / Math.max(1, total)) * 100).toFixed(1)}%`),
          el('td', { class: 'num col-files' }, num(entry.shown.length)),
          el(
            'td',
            { class: 'mono col-files' },
            slowest === undefined ? '' : `${slowest.name} (${ms(slowest.ms)})`,
          ),
        ),
      )
    }
    table.append(body)
    panel.append(
      el(
        'p',
        { class: 'note' },
        `Summed file time across workers: ${ms(total)} over ${ms(duration)} of wall time.`,
      ),
      table,
    )
  }

  // ---- Timeline: a lane for each worker, sized to its container
  let timelineWidth: number | null = null
  renderers[4] = (panel) => {
    heading(panel, 4)
    const LANE = 22
    const width = timelineWidth ?? Math.max(480, panel.clientWidth - 200)
    const scale = (t: number): number => (t / duration) * width
    const labels = el('div', { class: 'lanes-labels', 'aria-hidden': 'true' }, el('div', null, ''))
    const chart = svg('svg', {
      width: '100%',
      height: (workerIds.length + 1) * LANE,
      viewBox: `0 0 ${width} ${(workerIds.length + 1) * LANE}`,
      preserveAspectRatio: 'none',
      role: 'group',
      'aria-label': `Per-worker timeline of ${plural(placed.length, 'file')}. The table below has the same data.`,
    })
    const step =
      [100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000].find((s) => duration / s <= 12) ??
      120_000
    for (let t = 0; t <= duration; t += step) {
      chart.append(
        svg('line', {
          class: 'tick',
          x1: scale(t),
          x2: scale(t),
          y1: LANE - 4,
          y2: (workerIds.length + 1) * LANE,
        }),
      )
      const text = svg('text', { class: 'axis-text', x: scale(t) + 3, y: 14 })
      text.textContent = ms(t)
      chart.append(text)
    }
    workerIds.forEach((id, lane) => {
      const y = (lane + 1) * LANE
      const replaced = replaces.get(id)
      const busy = placed
        .filter((file) => file.worker === id)
        .reduce((sum, file) => sum + file.ms, 0)
      labels.append(
        el(
          'div',
          { class: replaced === undefined ? '' : 'replaced' },
          replaced === undefined ? `worker ${id}` : `worker ${id} (took over from ${replaced})`,
          el('span', { class: 'busy' }, `${Math.round((busy / duration) * 100)}% busy`),
        ),
      )
      chart.append(svg('rect', { class: 'lane-track', x: 0, y: y + 2, width, height: LANE - 4 }))
      chart.append(
        svg('line', {
          class: 'lane-sep',
          x1: 0,
          x2: width,
          y1: y + LANE - 0.5,
          y2: y + LANE - 0.5,
        }),
      )
    })
    for (const file of placed) {
      const y = (workerIds.indexOf(file.worker) + 1) * LANE + 2
      const rect = svg('rect', {
        class: `t-slice${inRange(file) ? '' : ' dim'}`,
        x: scale(file.start),
        y,
        width: Math.max(1, scale(file.end) - scale(file.start)),
        height: LANE - 4,
        id: `t-f-${file.i}`,
        tabindex: broken(file) ? 0 : -1,
        'data-f': file.i,
      })
      paint(rect, file)
      const description = `${file.path} · ${WORD[FILE_KIND[file.status]]} · ${ms(file.ms)} · worker ${file.worker} · ${ms(file.start)}–${ms(file.end)}`
      if (broken(file)) {
        rect.setAttribute('role', 'button')
        rect.setAttribute('aria-label', description)
      }
      const title = svg('title', {})
      title.textContent = description
      rect.append(title)
      chart.append(rect)
    }
    chart.addEventListener('click', (event) => {
      revealOf(event.target as Element)
    })
    chart.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      if (revealOf(event.target as Element)) event.preventDefault()
    })
    const scroller = el('div', { class: 'lanes-scroll' }, chart)
    panel.append(
      el(
        'p',
        { class: 'note' },
        "Each bar is a file on the worker that ran it; gaps are idle time, and each worker's busy share is beside its name. Failed and crashed files can be reached with Tab.",
      ),
      el('div', { class: 'timeline' }, labels, scroller),
    )
    if (
      timelineWidth === null &&
      scroller.clientWidth >= 480 &&
      Math.abs(scroller.clientWidth - width) > 2
    ) {
      timelineWidth = scroller.clientWidth
      panel.replaceChildren()
      renderers[4]?.(panel)
      timelineWidth = null
      return
    }
    const toggle = el(
      'button',
      { type: 'button', class: 'chip', 'aria-expanded': 'false', 'aria-controls': 'tl-table' },
      'Show as a table',
    )
    const wrap = el('div', { class: 'table-wrap', id: 'tl-table', hidden: true })
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') !== 'true'
      toggle.setAttribute('aria-expanded', String(open))
      toggle.textContent = open ? 'Hide the table' : 'Show as a table'
      wrap.hidden = !open
      if (open && wrap.childElementCount === 0) {
        const body = el('tbody', null)
        for (const file of placed
          .filter(inRange)
          .sort((a, b) => a.worker - b.worker || a.start - b.start)) {
          body.append(
            el(
              'tr',
              null,
              el('td', null, `worker ${file.worker}`),
              el('td', { class: 'mono' }, file.path),
              el('td', null, ms(file.start)),
              el('td', null, ms(file.end)),
              el('td', null, ms(file.ms)),
              el('td', null, icon(FILE_KIND[file.status]), WORD[FILE_KIND[file.status]]),
              el('td', null, file.expected < 0 ? '–' : ms(file.expected)),
            ),
          )
        }
        wrap.append(
          el(
            'table',
            null,
            el('caption', { class: 'sr-only' }, 'Files by worker, in the order they ran'),
            el(
              'thead',
              null,
              el(
                'tr',
                null,
                ...['Worker', 'File', 'Start', 'End', 'Time', 'Status', 'Expected'].map((name) =>
                  el('th', { scope: 'col' }, name),
                ),
              ),
            ),
            body,
          ),
        )
      }
    })
    panel.append(el('div', { class: 'toolbar spaced' }, toggle), wrap)
  }

  let resizeTimer: ReturnType<typeof setTimeout> | undefined
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => redraw(4), 150)
  })
  shell.append(
    el('main', null, overview, el('div', { class: 'tabbar' }, tabList, where), ...panels),
  )
  mount.replaceChildren(shell)
  select(failing ? 0 : 1)
}
