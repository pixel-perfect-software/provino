// The page's script. `renderReport` is written into the report with `Function.prototype.toString()`
// (`render.ts`), so it is one self-contained function: it closes over nothing outside itself (a
// type import is erased, and a reference to anything else throws when the page runs: the jsdom
// test of `page.test.ts` runs it). Every comment and blank line inside it ships in the page, so it
// is kept lean. It uses no multi-line template literal (the document drops blank lines and the
// spaces that end a line) and no `innerHTML` with data: text goes in with `textContent`.
//
// What it builds, from the compact rows of `ReportData`:
// - a summary header;
// - four views in a `role="tablist"`, each built the first time it is opened: the test tree
//   (`role="tree"`, searchable, folded where it passed, built a level at a time as it opens), the
//   status map, time by folder (a table whose bars repeat its numbers) and the per-worker timeline
//   (an SVG with a `<title>` on every file, and the same data as a table).
// The class names are the styling's hooks (`styles.ts`): one block per view (`summary`, `tabs`,
// `tree`, `node`, `map`, `cell`, `folders`, `bar`, `timeline`, `rect`), `--` modifiers for state.

import type { FileRow, ReportData, TestRow } from './model.ts'

/**
 * Draws `data` into `#report`.
 * @internal
 */
export function renderReport(data: ReportData): void {
  const mount = document.getElementById('report')
  if (mount === null) return
  const strings = data.strings
  const files = data.files
  const tests = data.tests
  const str = (id: number): string => strings[id] ?? ''
  const fileRow = (index: number): FileRow => files[index] as FileRow
  const testRow = (index: number): TestRow => tests[index] as TestRow
  const KIND = ['pass', 'fail', 'skip', 'todo', 'crash'] as const
  const TEST_KIND = ['pass', 'fail', 'skip', 'todo', 'notrun'] as const
  const GLYPH = ['✓', '✕', '○', '✎', '!'] as const
  const TEST_GLYPH = ['✓', '✕', '○', '✎', '–'] as const
  const FILE_WORD = ['passed', 'failed', 'skipped', 'todo', 'crashed'] as const
  const TEST_WORD = ['passed', 'failed', 'skipped', 'todo', 'not run'] as const
  const MAX_RESULTS = 500
  const MAX_FOLDER_ROWS = 200

  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className = '',
    text = '',
  ): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag)
    if (className !== '') node.className = className
    if (text !== '') node.textContent = text
    return node
  }
  const fmtN = (n: number): string => n.toLocaleString('en-US')
  const plural = (n: number, noun: string): string => `${fmtN(n)} ${noun}${n === 1 ? '' : 's'}`
  const fmtMs = (ms: number): string => {
    if (ms < 0) return '–'
    if (ms === 0) return '0 ms'
    if (ms < 1) return '<1 ms'
    if (ms < 1000) return `${ms < 10 ? Math.round(ms * 10) / 10 : Math.round(ms)} ms`
    const s = ms / 1000
    if (s < 60) return `${s < 10 ? s.toFixed(2) : s.toFixed(1)} s`
    return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`
  }
  const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  const scrollRegion = (label: string): HTMLElement => {
    const wrap = el('div', 'table-wrap')
    wrap.tabIndex = 0
    wrap.setAttribute('role', 'region')
    wrap.setAttribute('aria-label', label)
    return wrap
  }
  const bump = (counts: number[], index: number, by = 1): void => {
    counts[index] = (counts[index] ?? 0) + by
  }
  const count = (counts: readonly number[], index: number): number => counts[index] ?? 0

  // The rows, read once.
  const testsByFile: number[][] = files.map(() => [])
  const nTests: number[] = files.map(() => 0)
  const nFailed: number[] = files.map(() => 0)
  const nSkipped: number[] = files.map(() => 0)
  const testCounts = [0, 0, 0, 0, 0]
  tests.forEach((row, index) => {
    testsByFile[row[0]]?.push(index)
    bump(testCounts, row[2])
    if (row[2] === 4) return
    bump(nTests, row[0])
    if (row[2] === 1) bump(nFailed, row[0])
    if (row[2] === 2 || row[2] === 3) bump(nSkipped, row[0])
  })
  const failureTexts = new Map<number, string>()
  for (const [testIndex, text] of data.failures) failureTexts.set(testIndex, text)
  const fileErrors = new Map<number, string>()
  for (const [fileIndex, text] of data.fileErrors) fileErrors.set(fileIndex, text)
  const fileCounts = [0, 0, 0, 0, 0]
  let totalFileMs = 0
  let latestEnd = 0
  for (const row of files) {
    bump(fileCounts, row[1])
    totalFileMs += row[2]
    latestEnd = Math.max(latestEnd, row[5])
  }

  // Folders: a file's folder is its path's directory, within its project.
  interface Folder {
    label: string
    files: number[]
    tests: number
    failed: number
    ms: number
    filesFailed: number
  }
  const folders: Folder[] = []
  const byKey = new Map<string, { project: string; dir: string; files: number[] }>()
  files.forEach((row, index) => {
    const path = str(row[0])
    const at = path.lastIndexOf('/')
    const dir = at === -1 ? '.' : at === 0 ? '/' : path.slice(0, at)
    const project = str(row[7])
    const key = `${project}\u0000${dir}`
    const group = byKey.get(key)
    if (group === undefined) byKey.set(key, { project, dir, files: [index] })
    else group.files.push(index)
  })
  for (const group of [...byKey.values()].sort(
    (a, b) => compare(a.project, b.project) || compare(a.dir, b.dir),
  )) {
    group.files.sort((a, b) => compare(str(fileRow(a)[0]), str(fileRow(b)[0])))
    const folder: Folder = {
      label: `${group.project === '' ? '' : `${group.project} `}${group.dir.endsWith('/') ? group.dir : `${group.dir}/`}`,
      files: group.files,
      tests: 0,
      failed: 0,
      ms: 0,
      filesFailed: 0,
    }
    for (const index of group.files) {
      folder.tests += count(nTests, index)
      folder.failed += count(nFailed, index)
      folder.ms += fileRow(index)[2]
      if (fileRow(index)[1] === 1 || fileRow(index)[1] === 4) folder.filesFailed++
    }
    folders.push(folder)
  }
  const folderOf = new Map<number, Folder>()
  for (const folder of folders) for (const index of folder.files) folderOf.set(index, folder)

  // The SVG namespace is taken from the parser, so no URL is written here.
  const holder = el('div')
  holder.innerHTML = '<svg></svg>'
  const svgNamespace = holder.firstElementChild?.namespaceURI ?? null
  const svgEl = (tag: string, className = ''): SVGElement => {
    const node = document.createElementNS(svgNamespace, tag) as SVGElement
    if (className !== '') node.setAttribute('class', className)
    return node
  }

  mount.textContent = ''
  mount.className = 'report'

  // ---- Summary header
  const breakdown = (
    counts: readonly number[],
    kinds: readonly string[],
    glyphs: readonly string[],
    words: readonly string[],
  ): HTMLElement => {
    const list = el('span', 'summary__counts')
    kinds.forEach((kind, index) => {
      const n = count(counts, index)
      if (n === 0 && index > 1) return
      const item = el('span', `count count--${kind}`)
      item.append(
        el('span', 'count__glyph', glyphs[index] ?? ''),
        el('span', 'count__number', fmtN(n)),
        el('span', 'count__word', ` ${words[index] ?? ''}`),
      )
      list.append(item)
    })
    return list
  }
  const header = el('header', 'report__header')
  header.append(el('h1', 'report__title', `Provino report: ${data.title}`))
  const failedFiles = count(fileCounts, 1) + count(fileCounts, 4)
  const failedTests = count(testCounts, 1)
  const verdictWord = {
    passed: 'Passed',
    failed: 'Failed',
    interrupted: 'Interrupted',
    terminated: 'Terminated',
    hangup: 'Terminal closed',
  }[data.reason]
  const verdict = el(
    'p',
    `report__verdict report__verdict--${files.length === 0 ? 'empty' : data.reason === 'passed' ? 'pass' : 'fail'}`,
  )
  verdict.append(
    el(
      'span',
      'report__verdict-glyph',
      files.length === 0 ? '–' : data.reason === 'passed' ? '✓' : '✕',
    ),
  )
  verdict.append(
    el(
      'span',
      'report__verdict-text',
      files.length === 0
        ? ' No test files ran'
        : data.reason === 'passed'
          ? ` ${verdictWord}: ${plural(files.length, 'file')}, ${plural(tests.length, 'test')}`
          : ` ${verdictWord}: ${plural(failedFiles, 'file')} and ${plural(failedTests, 'test')} failed`,
    ),
  )
  header.append(verdict)
  const stats = el('dl', 'summary')
  const stat = (name: string, value: Node | string): void => {
    const box = el('div', `summary__stat summary__stat--${name.toLowerCase().replace(' ', '-')}`)
    const term = el('dt', 'summary__term', name)
    const definition = el('dd', 'summary__value')
    definition.append(value)
    box.append(term, definition)
    stats.append(box)
  }
  stat('Files', breakdown(fileCounts, KIND, GLYPH, FILE_WORD))
  stat('Tests', breakdown(testCounts, TEST_KIND, TEST_GLYPH, TEST_WORD))
  stat('Duration', fmtMs(data.durationMs))
  const started = el('time', '', `${data.startedAt.replace('T', ' ').slice(0, 19)} UTC`)
  started.setAttribute('datetime', data.startedAt)
  stat('Started', started)
  const workerIds = new Set<number>()
  for (const row of files) if (row[3] >= 0) workerIds.add(row[3])
  stat(
    'Workers',
    data.workers > 0 && data.workers !== workerIds.size
      ? `${fmtN(workerIds.size)} used of ${fmtN(data.workers)}`
      : fmtN(workerIds.size),
  )
  if (data.snapshots !== undefined) {
    const s = data.snapshots
    stat(
      'Snapshots',
      `${fmtN(s.total)} total: ${fmtN(s.matched)} matched, ${fmtN(s.unmatched)} failed, ${fmtN(s.added)} added, ${fmtN(s.updated)} updated, ${fmtN(s.unchecked)} obsolete`,
    )
  }
  if (data.runErrors.length > 0) stat('Run errors', fmtN(data.runErrors.length))
  header.append(stats)
  mount.append(header)

  if (files.length === 0) {
    mount.append(el('p', 'empty', 'No test files ran, so there is nothing to show.'))
    return
  }

  // ---- The tree
  let nodeSeq = 0
  const builders = new WeakMap<HTMLElement, () => void>()
  interface NodeSpec {
    kind: 'folder' | 'file' | 'suite' | 'test' | 'error'
    level: number
    tone: string
    glyph: string
    word: string
    label: string
    title: string
    meta: string
    open: boolean
    expandable: boolean
    detail: boolean
    fill: (into: HTMLElement) => void
  }
  const setOpen = (item: HTMLElement, open: boolean): void => {
    if (item.getAttribute('aria-expanded') === null) return
    const body = item.lastElementChild as HTMLElement
    if (open) {
      const build = builders.get(item)
      if (build !== undefined) {
        builders.delete(item)
        build()
      }
    }
    body.hidden = !open
    item.setAttribute('aria-expanded', String(open))
  }
  const makeNode = (spec: NodeSpec): HTMLLIElement => {
    const id = `node-${++nodeSeq}`
    const item = el('li', `node node--${spec.kind} node--${spec.tone}`)
    item.setAttribute('role', 'treeitem')
    item.setAttribute('aria-level', String(spec.level))
    item.tabIndex = -1
    const row = el('div', 'node__row')
    row.id = `${id}-row`
    const toggle = el('span', 'node__toggle', spec.expandable ? '▸' : '')
    toggle.setAttribute('aria-hidden', 'true')
    const status = el('span', 'node__status')
    const glyph = el('span', 'node__glyph', spec.glyph)
    glyph.setAttribute('aria-hidden', 'true')
    status.append(glyph, el('span', 'sr-only', `${spec.word} `))
    const label = el('span', 'node__label', spec.label)
    if (spec.title !== '') label.title = spec.title
    row.append(toggle, status, label)
    if (spec.meta !== '') row.append(' ', el('span', 'node__meta', spec.meta))
    item.setAttribute('aria-labelledby', row.id)
    item.append(row)
    if (spec.expandable) {
      const body = spec.detail ? el('div', 'node__detail') : el('ul', 'node__children')
      if (spec.detail) item.setAttribute('aria-describedby', `${id}-body`)
      else body.setAttribute('role', 'group')
      body.id = `${id}-body`
      body.hidden = true
      item.setAttribute('aria-expanded', 'false')
      item.append(body)
      builders.set(item, () => spec.fill(body))
      if (spec.open) setOpen(item, true)
    }
    return item
  }

  const errorNode = (label: string, text: string, level: number): HTMLLIElement =>
    makeNode({
      kind: 'error',
      level,
      tone: 'fail',
      glyph: '✕',
      word: 'error',
      label,
      title: '',
      meta: '',
      open: true,
      expandable: true,
      detail: true,
      fill: (into) => into.append(el('pre', 'failure', text)),
    })
  const testNode = (testIndex: number, level: number): HTMLLIElement => {
    const row = testRow(testIndex)
    const ids = row[1]
    const status = row[2]
    const text = failureTexts.get(testIndex)
    const time = status === 4 ? 'not run' : fmtMs(row[3])
    return makeNode({
      kind: 'test',
      level,
      tone: TEST_KIND[status],
      glyph: TEST_GLYPH[status],
      word: TEST_WORD[status],
      label: str(ids[ids.length - 1] ?? 0),
      title: ids.map(str).join(' › '),
      meta: status === 1 && text === undefined ? `${time} · text not kept` : time,
      open: text !== undefined,
      expandable: text !== undefined,
      detail: true,
      fill: (into) => into.append(el('pre', 'failure', text ?? '')),
    })
  }
  interface Suite {
    name: string
    kids: (Suite | number)[]
    tests: number
    failed: number
    ms: number
  }
  const buildSuites = (list: readonly number[]): Suite => {
    const top: Suite = { name: '', kids: [], tests: 0, failed: 0, ms: 0 }
    const subs = new Map<Suite, Map<number, Suite>>()
    for (const testIndex of list) {
      const row = testRow(testIndex)
      const path: Suite[] = [top]
      let at = top
      for (let k = 0; k < row[1].length - 1; k++) {
        const id = row[1][k] as number
        let children = subs.get(at)
        if (children === undefined) {
          children = new Map()
          subs.set(at, children)
        }
        let next = children.get(id)
        if (next === undefined) {
          next = { name: str(id), kids: [], tests: 0, failed: 0, ms: 0 }
          children.set(id, next)
          at.kids.push(next)
        }
        at = next
        path.push(at)
      }
      at.kids.push(testIndex)
      for (const suite of path) {
        suite.tests++
        suite.ms += row[3]
        if (row[2] === 1) suite.failed++
      }
    }
    return top
  }
  const summarize = (n: number, failed: number, ms: number): string =>
    `${plural(n, 'test')}${failed > 0 ? ` · ${fmtN(failed)} failed` : ''} · ${fmtMs(ms)}`
  const suiteNode = (suite: Suite, level: number, forceOpen: boolean): HTMLLIElement =>
    makeNode({
      kind: 'suite',
      level,
      tone: suite.failed > 0 ? 'fail' : 'pass',
      glyph: suite.failed > 0 ? '✕' : '✓',
      word: suite.failed > 0 ? 'failed' : 'passed',
      label: suite.name,
      title: '',
      meta: summarize(suite.tests, suite.failed, suite.ms),
      open: suite.failed > 0 || forceOpen,
      expandable: true,
      detail: false,
      fill: (into) => {
        for (const kid of suite.kids) {
          into.append(
            typeof kid === 'number'
              ? testNode(kid, level + 1)
              : suiteNode(kid, level + 1, forceOpen),
          )
        }
      },
    })
  const fileNodes = new Map<number, HTMLLIElement>()
  const fileNode = (
    fileIndex: number,
    list: readonly number[],
    level: number,
    forceOpen: boolean,
  ): HTMLLIElement => {
    const row = fileRow(fileIndex)
    const status = row[1]
    const path = str(row[0])
    const own = fileErrors.get(fileIndex)
    const ran = count(nTests, fileIndex)
    const failed = count(nFailed, fileIndex)
    const meta =
      status === 4
        ? `worker crashed · ${fmtMs(row[2])}`
        : `${plural(ran, 'test')}${failed > 0 ? ` · ${fmtN(failed)} failed` : ''} · ${fmtMs(row[2])}`
    const item = makeNode({
      kind: 'file',
      level,
      tone: KIND[status],
      glyph: GLYPH[status],
      word: FILE_WORD[status],
      label: path.slice(path.lastIndexOf('/') + 1),
      title: path,
      meta,
      open: status === 1 || status === 4 || forceOpen,
      expandable: own !== undefined || list.length > 0,
      detail: false,
      fill: (into) => {
        if (own !== undefined) {
          into.append(
            errorNode(
              status === 4
                ? 'Worker crashed'
                : ran === 0
                  ? 'Test suite failed to run'
                  : 'Errors outside the tests',
              own,
              level + 1,
            ),
          )
        }
        for (const kid of buildSuites(list).kids) {
          into.append(
            typeof kid === 'number'
              ? testNode(kid, level + 1)
              : suiteNode(kid, level + 1, forceOpen),
          )
        }
      },
    })
    fileNodes.set(fileIndex, item)
    return item
  }
  const folderNodes = new Map<Folder, HTMLLIElement>()
  const folderNode = (
    folder: Folder,
    members: readonly number[],
    selected: Map<number, number[]> | null,
    forceOpen: boolean,
  ): HTMLLIElement => {
    const failing = folder.filesFailed > 0
    const item = makeNode({
      kind: 'folder',
      level: 1,
      tone: failing ? 'fail' : 'pass',
      glyph: failing ? '✕' : '✓',
      word: failing ? 'failed' : 'passed',
      label: folder.label,
      title: '',
      meta: `${plural(folder.files.length, 'file')} · ${plural(folder.tests, 'test')}${folder.failed > 0 ? ` · ${fmtN(folder.failed)} failed` : ''} · ${fmtMs(folder.ms)}`,
      open: failing || forceOpen,
      expandable: true,
      detail: false,
      fill: (into) => {
        for (const index of members) {
          into.append(
            fileNode(index, selected?.get(index) ?? testsByFile[index] ?? [], 2, forceOpen),
          )
        }
      },
    })
    folderNodes.set(folder, item)
    return item
  }

  const tree = el('ul', 'tree')
  tree.setAttribute('role', 'tree')
  tree.setAttribute('aria-label', 'Test files and tests')
  const treeNote = el('p', 'tree__note')
  const results = el('div', 'search__results')
  results.setAttribute('role', 'status')
  let treeFocus: HTMLElement | null = null
  const focusItem = (item: HTMLElement): void => {
    if (treeFocus !== null && treeFocus !== item) treeFocus.tabIndex = -1
    item.tabIndex = 0
    treeFocus = item
    item.focus()
  }
  const visibleItems = (): HTMLElement[] =>
    Array.from(tree.querySelectorAll<HTMLElement>('li[role="treeitem"]')).filter(
      (item) => item.parentElement?.closest('[hidden]') == null,
    )
  const renderTree = (selected: Map<number, number[]> | null, forceOpen: boolean): void => {
    tree.textContent = ''
    fileNodes.clear()
    folderNodes.clear()
    treeFocus = null
    for (const folder of folders) {
      const members = selected === null ? folder.files : folder.files.filter((i) => selected.has(i))
      if (members.length > 0) tree.append(folderNode(folder, members, selected, forceOpen))
    }
    if (selected === null && data.runErrors.length > 0) {
      tree.append(errorNode('Errors outside any test file', data.runErrors.join('\n\n'), 1))
    }
    const first = tree.querySelector<HTMLElement>('li[role="treeitem"]')
    if (first !== null) first.tabIndex = 0
    treeFocus = first
  }
  tree.addEventListener('click', (event) => {
    const row = (event.target as Element).closest('.node__row')
    const item = row?.parentElement
    if (item == null) return
    focusItem(item)
    setOpen(item, item.getAttribute('aria-expanded') === 'false')
  })
  tree.addEventListener('keydown', (event) => {
    const item = (event.target as Element).closest<HTMLElement>('li[role="treeitem"]')
    if (item === null || item !== event.target || event.altKey || event.ctrlKey || event.metaKey) {
      return
    }
    const expanded = item.getAttribute('aria-expanded')
    const all = visibleItems()
    const at = all.indexOf(item)
    let to: HTMLElement | null | undefined
    switch (event.key) {
      case 'ArrowDown':
        to = all[at + 1]
        break
      case 'ArrowUp':
        to = all[at - 1]
        break
      case 'Home':
        to = all[0]
        break
      case 'End':
        to = all[all.length - 1]
        break
      case 'ArrowRight':
        if (expanded === 'false') setOpen(item, true)
        else if (expanded === 'true') to = item.querySelector<HTMLElement>('li[role="treeitem"]')
        break
      case 'ArrowLeft':
        if (expanded === 'true') setOpen(item, false)
        else to = item.parentElement?.closest<HTMLElement>('li[role="treeitem"]')
        break
      case 'Enter':
      case ' ':
        if (expanded !== null) setOpen(item, expanded === 'false')
        break
      default:
        return
    }
    event.preventDefault()
    if (to != null) focusItem(to)
  })

  // Search: every word must be in the file's path or the test's titles, in any case. The index is
  // built the first time it is asked, and the search waits for a pause in typing.
  let haystack: string[] | null = null
  const index = (): string[] =>
    (haystack ??= tests.map((row) =>
      `${str(fileRow(row[0])[0])} ${row[1].map(str).join(' ')}`.toLowerCase(),
    ))
  let query = ''
  let failuresOnly = false
  const applyFilter = (): void => {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term !== '')
    if (terms.length === 0 && !failuresOnly) {
      renderTree(null, false)
      treeNote.textContent = ''
      results.textContent = ''
      return
    }
    const lines = index()
    const selected = new Map<number, number[]>()
    let matches = 0
    for (let i = 0; i < tests.length; i++) {
      const row = testRow(i)
      if (failuresOnly && row[2] !== 1) continue
      const line = lines[i] ?? ''
      if (!terms.every((term) => line.includes(term))) continue
      matches++
      if (matches > MAX_RESULTS) continue
      const list = selected.get(row[0])
      if (list === undefined) selected.set(row[0], [i])
      else list.push(i)
    }
    // A file with no test to show (a crash, a collection error) is found by its path.
    files.forEach((row, fileIndex) => {
      if (count(nTests, fileIndex) > 0 || selected.has(fileIndex)) return
      if (
        row[1] !== 1 &&
        row[1] !== 4 &&
        (failuresOnly || fileErrors.get(fileIndex) === undefined)
      ) {
        return
      }
      const path = str(row[0]).toLowerCase()
      if (terms.every((term) => path.includes(term))) selected.set(fileIndex, [])
    })
    renderTree(selected, true)
    const what = `${fmtN(matches)} ${failuresOnly ? 'failed ' : ''}${matches === 1 ? 'test' : 'tests'}`
    const where = `in ${plural(selected.size, 'file')}`
    results.textContent =
      terms.length > 0 ? `${what} match “${query.trim()}” ${where}` : `${what} ${where}`
    treeNote.textContent =
      matches > MAX_RESULTS
        ? `Showing the first ${fmtN(MAX_RESULTS)} of ${fmtN(matches)} tests. Narrow the search to see the rest.`
        : ''
    if (selected.size === 0) {
      tree.append(el('li', 'tree__empty', 'Nothing matches.'))
    }
  }
  let pause: ReturnType<typeof setTimeout> | undefined
  const searchInput = el('input', 'search__input')
  searchInput.type = 'search'
  searchInput.id = 'search'
  searchInput.autocomplete = 'off'
  searchInput.addEventListener('input', () => {
    clearTimeout(pause)
    pause = setTimeout(() => {
      query = searchInput.value
      applyFilter()
    }, 150)
  })
  const failuresBox = el('input', 'search__checkbox')
  failuresBox.type = 'checkbox'
  failuresBox.id = 'failures-only'
  failuresBox.addEventListener('change', () => {
    failuresOnly = failuresBox.checked
    applyFilter()
  })

  const buildTests = (panel: HTMLElement): void => {
    const bar = el('div', 'search')
    const label = el('label', 'search__label', 'Search tests and files')
    label.htmlFor = searchInput.id
    const checkLabel = el('label', 'search__check')
    checkLabel.htmlFor = failuresBox.id
    checkLabel.append(failuresBox, el('span', 'search__check-text', ' Failures only'))
    bar.append(label, searchInput, checkLabel)
    panel.append(bar, results, treeNote, tree)
    if (data.omitted > 0) {
      panel.append(
        el(
          'p',
          'tree__note',
          `${plural(data.omitted, 'more failed test')} ${data.omitted === 1 ? 'is' : 'are'} listed without text: the report keeps the text of the first ${fmtN(failedTests - data.omitted)}.`,
        ),
      )
    }
    renderTree(null, false)
  }
  const revealFile = (fileIndex: number): void => {
    if (query !== '' || failuresOnly) {
      query = ''
      failuresOnly = false
      searchInput.value = ''
      failuresBox.checked = false
      applyFilter()
    }
    const folder = folderOf.get(fileIndex)
    const folderItem = folder === undefined ? undefined : folderNodes.get(folder)
    if (folderItem === undefined) return
    setOpen(folderItem, true)
    const item = fileNodes.get(fileIndex)
    if (item === undefined) return
    setOpen(item, true)
    focusItem(item)
    if (typeof item.scrollIntoView === 'function') item.scrollIntoView({ block: 'center' })
  }

  // ---- The status map
  const buildMap = (panel: HTMLElement): void => {
    const legend = el('ul', 'legend')
    KIND.forEach((kind, i) => {
      const item = el('li', `legend__item legend__item--${kind}`)
      item.append(
        el('span', `cell cell--${kind} cell--legend`, GLYPH[i]),
        el('span', 'legend__word', ` ${FILE_WORD[i]}`),
      )
      legend.append(item)
    })
    panel.append(legend)
    const cells: HTMLButtonElement[] = []
    for (const folder of folders) {
      const section = el('section', 'map__folder')
      section.append(el('h3', 'map__title', folder.label))
      const group = el('div', 'map__cells')
      group.setAttribute('role', 'group')
      group.setAttribute('aria-label', `${folder.label}: ${plural(folder.files.length, 'file')}`)
      for (const fileIndex of folder.files) {
        const row = fileRow(fileIndex)
        const detail = `${str(row[0])}: ${FILE_WORD[row[1]]}, ${plural(count(nTests, fileIndex), 'test')}, ${fmtMs(row[2])}`
        const cell = el('button', `cell cell--${KIND[row[1]]}`, GLYPH[row[1]])
        cell.type = 'button'
        cell.title = detail
        cell.setAttribute('aria-label', detail)
        cell.tabIndex = cells.length === 0 ? 0 : -1
        cell.dataset.file = String(fileIndex)
        cells.push(cell)
        group.append(cell)
      }
      section.append(group)
      panel.append(section)
    }
    let current = 0
    const move = (to: number): void => {
      const next = cells[Math.max(0, Math.min(cells.length - 1, to))]
      if (next === undefined) return
      const previous = cells[current]
      if (previous !== undefined) previous.tabIndex = -1
      next.tabIndex = 0
      current = cells.indexOf(next)
      next.focus()
    }
    panel.addEventListener('keydown', (event) => {
      const at = cells.indexOf(event.target as HTMLButtonElement)
      if (at === -1) return
      const keys: Record<string, number> = {
        ArrowRight: at + 1,
        ArrowDown: at + 1,
        ArrowLeft: at - 1,
        ArrowUp: at - 1,
        Home: 0,
        End: cells.length - 1,
      }
      const to = keys[event.key]
      if (to === undefined) return
      event.preventDefault()
      move(to)
    })
    panel.addEventListener('click', (event) => {
      const cell = (event.target as Element).closest<HTMLButtonElement>('button.cell')
      if (cell === null || cell.dataset.file === undefined) return
      current = cells.indexOf(cell)
      showTab('tests', false)
      revealFile(Number(cell.dataset.file))
    })
  }

  // ---- Time by folder
  const buildFolders = (panel: HTMLElement): void => {
    const ordered = [...folders].sort((a, b) => b.ms - a.ms || compare(a.label, b.label))
    const wrap = scrollRegion('Time by folder')
    const table = el('table', 'folders')
    table.append(
      el(
        'caption',
        'folders__caption',
        `Time by folder: the sum of its files' times, ${fmtMs(totalFileMs)} in all`,
      ),
    )
    const head = el('tr')
    for (const name of ['Folder', 'Time', 'Share', '', 'Files', 'Tests', 'Failed']) {
      const cell = el('th', '', name)
      cell.scope = 'col'
      if (name === '') cell.className = 'sr-only'
      head.append(cell)
    }
    const thead = el('thead')
    thead.append(head)
    const body = el('tbody')
    table.append(thead, body)
    const rows = (list: readonly Folder[]): void => {
      for (const folder of list) {
        const share = totalFileMs > 0 ? (folder.ms / totalFileMs) * 100 : 0
        const row = el('tr', `folders__row${folder.filesFailed > 0 ? ' folders__row--fail' : ''}`)
        const name = el('th', 'folders__name', folder.label)
        name.scope = 'row'
        const bar = el('td', 'folders__bar')
        const track = el('span', 'bar')
        track.setAttribute('aria-hidden', 'true')
        const fill = el('span', 'bar__fill')
        fill.style.setProperty('--share', share.toFixed(2))
        track.append(fill)
        bar.append(track)
        row.append(
          name,
          el('td', 'folders__time', fmtMs(folder.ms)),
          el('td', 'folders__share', `${share < 10 ? share.toFixed(1) : Math.round(share)}%`),
          bar,
          el('td', 'folders__files', fmtN(folder.files.length)),
          el('td', 'folders__tests', fmtN(folder.tests)),
          el('td', 'folders__failed', fmtN(folder.failed)),
        )
        body.append(row)
      }
    }
    rows(ordered.slice(0, MAX_FOLDER_ROWS))
    wrap.append(table)
    panel.append(wrap)
    if (ordered.length > MAX_FOLDER_ROWS) {
      const more = el('button', 'folders__more', `Show all ${fmtN(ordered.length)} folders`)
      more.type = 'button'
      more.addEventListener('click', () => {
        rows(ordered.slice(MAX_FOLDER_ROWS))
        more.remove()
      })
      panel.append(more)
    }
  }

  // ---- The timeline
  const buildTimeline = (panel: HTMLElement): void => {
    const total = Math.max(1, latestEnd, data.durationMs)
    const byWorker = new Map<number, number[]>()
    let unplaced = 0
    files.forEach((row, fileIndex) => {
      if (row[3] < 0 || row[4] < 0 || row[5] < 0) {
        unplaced++
        return
      }
      const list = byWorker.get(row[3])
      if (list === undefined) byWorker.set(row[3], [fileIndex])
      else list.push(fileIndex)
    })
    const workers = [...byWorker.keys()].sort((a, b) => a - b)
    const switcher = el('div', 'timeline__switch')
    switcher.setAttribute('role', 'group')
    switcher.setAttribute('aria-label', 'Timeline view')
    const chartButton = el('button', 'timeline__button', 'Chart')
    const tableButton = el('button', 'timeline__button', 'Table')
    chartButton.type = 'button'
    tableButton.type = 'button'
    switcher.append(chartButton, tableButton)
    panel.append(
      el(
        'p',
        'timeline__summary',
        `${plural(workers.length, 'worker')} ran ${plural(files.length - unplaced, 'file')} in ${fmtMs(total)}. Gaps are idle workers; a worker that was replaced has a row of its own. The table has the same data as the chart.`,
      ),
      switcher,
    )
    const chart = el('div', 'timeline__chart')
    const defs = svgEl('svg', 'timeline__defs')
    defs.setAttribute('width', '0')
    defs.setAttribute('height', '0')
    defs.setAttribute('aria-hidden', 'true')
    defs.setAttribute('focusable', 'false')
    for (const kind of ['fail', 'crash']) {
      const pattern = svgEl('pattern')
      pattern.id = `hatch-${kind}`
      pattern.setAttribute('width', kind === 'fail' ? '6' : '4')
      pattern.setAttribute('height', kind === 'fail' ? '6' : '4')
      pattern.setAttribute('patternUnits', 'userSpaceOnUse')
      if (kind === 'fail') pattern.setAttribute('patternTransform', 'rotate(45)')
      const back = svgEl('rect', `hatch__back hatch__back--${kind}`)
      back.setAttribute('width', '100%')
      back.setAttribute('height', '100%')
      const line = svgEl('rect', `hatch__line hatch__line--${kind}`)
      line.setAttribute('width', kind === 'fail' ? '2' : '1.5')
      line.setAttribute('height', kind === 'fail' ? '6' : '1.5')
      pattern.append(back, line)
      defs.append(pattern)
    }
    chart.append(defs)
    for (const worker of workers) {
      const list = byWorker.get(worker) ?? []
      let busy = 0
      const row = el('div', 'timeline__row')
      const label = el('div', 'timeline__label')
      const track = svgEl('svg', 'timeline__track')
      track.setAttribute('viewBox', '0 0 1000 20')
      track.setAttribute('preserveAspectRatio', 'none')
      track.setAttribute('role', 'img')
      track.setAttribute('aria-label', `Worker ${worker}: ${plural(list.length, 'file')}`)
      for (const fileIndex of list) {
        const file = fileRow(fileIndex)
        busy += Math.max(0, file[5] - file[4])
        const rect = svgEl('rect', `rect rect--${KIND[file[1]]}`)
        rect.setAttribute('x', ((file[4] / total) * 1000).toFixed(2))
        rect.setAttribute('y', '2')
        rect.setAttribute('width', Math.max(1.5, ((file[5] - file[4]) / total) * 1000).toFixed(2))
        rect.setAttribute('height', '16')
        const tip = svgEl('title')
        tip.textContent = `${str(file[0])}: ${FILE_WORD[file[1]]}, ${fmtMs(file[2])} (worker ${worker}, ${fmtMs(file[4])} to ${fmtMs(file[5])})`
        rect.append(tip)
        track.append(rect)
      }
      label.append(
        el('span', 'timeline__worker', `Worker ${worker}`),
        el('span', 'timeline__busy', ` ${Math.round((busy / total) * 100)}% busy`),
      )
      row.append(label, track)
      chart.append(row)
    }
    const axis = el('div', 'timeline__axis')
    axis.setAttribute('aria-hidden', 'true')
    for (let i = 0; i <= 4; i++) axis.append(el('span', 'timeline__tick', fmtMs((total * i) / 4)))
    chart.append(axis)
    if (unplaced > 0) {
      chart.append(
        el(
          'p',
          'timeline__note',
          `${plural(unplaced, 'file')} ran with no start time and are not on the chart.`,
        ),
      )
    }
    const tableWrap = scrollRegion('Timeline as a table')
    tableWrap.classList.add('timeline__tablewrap')
    tableWrap.hidden = true
    let tableBuilt = false
    const buildTable = (): void => {
      const table = el('table', 'timeline__table')
      table.append(el('caption', 'timeline__caption', 'Files by worker and start time'))
      const head = el('tr')
      for (const name of ['Worker', 'File', 'Status', 'Start', 'End', 'Time', 'Expected']) {
        const cell = el('th', '', name)
        cell.scope = 'col'
        head.append(cell)
      }
      const thead = el('thead')
      thead.append(head)
      const body = el('tbody')
      const placed: number[] = []
      for (const worker of workers) placed.push(...(byWorker.get(worker) ?? []))
      placed.sort((a, b) => fileRow(a)[3] - fileRow(b)[3] || fileRow(a)[4] - fileRow(b)[4])
      for (const fileIndex of placed) {
        const file = fileRow(fileIndex)
        const row = el('tr', `timeline__line timeline__line--${KIND[file[1]]}`)
        row.append(
          el('td', '', String(file[3])),
          el('td', 'timeline__path', str(file[0])),
          el('td', '', FILE_WORD[file[1]]),
          el('td', '', fmtMs(file[4])),
          el('td', '', fmtMs(file[5])),
          el('td', '', fmtMs(file[2])),
          el('td', '', file[6] < 0 ? '–' : fmtMs(file[6])),
        )
        body.append(row)
      }
      table.append(thead, body)
      tableWrap.append(table)
    }
    const showChart = (isChart: boolean): void => {
      chart.hidden = !isChart
      tableWrap.hidden = isChart
      chartButton.setAttribute('aria-pressed', String(isChart))
      tableButton.setAttribute('aria-pressed', String(!isChart))
      if (!isChart && !tableBuilt) {
        tableBuilt = true
        buildTable()
      }
    }
    chartButton.addEventListener('click', () => showChart(true))
    tableButton.addEventListener('click', () => showChart(false))
    panel.append(chart, tableWrap)
    showChart(true)
  }

  // ---- The tabs
  const views = [
    { id: 'tests', label: 'Tests', build: buildTests },
    { id: 'map', label: 'Status map', build: buildMap },
    { id: 'folders', label: 'Time by folder', build: buildFolders },
    { id: 'timeline', label: 'Timeline', build: buildTimeline },
  ]
  const tablist = el('div', 'tabs')
  tablist.setAttribute('role', 'tablist')
  tablist.setAttribute('aria-label', 'Report views')
  const panels = el('div', 'panels')
  const tabButtons: HTMLButtonElement[] = []
  const panelBoxes: HTMLElement[] = []
  const built: boolean[] = []
  views.forEach((view) => {
    const tab = el('button', 'tab', view.label)
    tab.type = 'button'
    tab.id = `tab-${view.id}`
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-controls', `panel-${view.id}`)
    const panel = el('div', `panel panel--${view.id}`)
    panel.id = `panel-${view.id}`
    panel.setAttribute('role', 'tabpanel')
    panel.setAttribute('aria-labelledby', tab.id)
    tabButtons.push(tab)
    panelBoxes.push(panel)
    built.push(false)
    tab.addEventListener('click', () => showTab(view.id, false))
    tablist.append(tab)
    panels.append(panel)
  })
  function showTab(id: string, focus: boolean): void {
    views.forEach((view, at) => {
      const active = view.id === id
      const tab = tabButtons[at] as HTMLButtonElement
      const panel = panelBoxes[at] as HTMLElement
      tab.setAttribute('aria-selected', String(active))
      tab.tabIndex = active ? 0 : -1
      panel.hidden = !active
      if (active) {
        if (built[at] !== true) {
          built[at] = true
          view.build(panel)
        }
        if (focus) tab.focus()
      }
    })
  }
  tablist.addEventListener('keydown', (event) => {
    const at = tabButtons.indexOf(event.target as HTMLButtonElement)
    if (at === -1) return
    const last = views.length - 1
    const to =
      event.key === 'ArrowRight'
        ? (at + 1) % views.length
        : event.key === 'ArrowLeft'
          ? (at + last) % views.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : -1
    const view = views[to]
    if (view === undefined) return
    event.preventDefault()
    showTab(view.id, true)
  })
  mount.append(tablist, panels)
  showTab('tests', false)
}
