// The `per-file-graph` command of `bench:loader`: a React component suite whose UI library graph is
// evaluated per file. A generated `node_modules` tree of about 3,000 CommonJS modules shaped like a
// UI library: a barrel re-exporting `ICONS` icon modules (each importing a shared util), a core
// package, a components package, and a "dom" package at the bottom that reads `document` while it
// loads (D129's trigger), so everything above it is evaluated again in every test file. N test
// files each import the barrel and a few components, under `jest-environment-jsdom`.
//
// `provino jest -w 1` and Jest 30.5.2 (`jest -w 1`) run the same project, interleaved, warm (each
// keeps its cache directory between runs; one discarded warm-up each). From each run's `--json`
// results: file 1's time and the median of files 2..N. Each test file's last test appends the
// process's `pid`, RSS, `heapUsed` and `arrayBuffers` (no collection forced, but with `--esm`) to a log the run names: the memory of
// the worker that ran it, and with `--idle-memory-limit` how often a worker was replaced. A
// `--baseline <checkout>` runs that tree's `provino jest` too, for a change's before and after. No
// bar; every number is `local`.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveRunnerPackage, runProcess } from '@provino/harness'
import { median } from '../stats.ts'

/** Icon modules behind the barrel. */
export const PER_FILE_ICONS = 2000
const CORE_MODULES = 300
const COMPONENTS = 600
const DOM_MODULES = 40
/** Test files in the project, by default. */
export const PER_FILE_TESTS = 12

/** The options of `bench:loader per-file-graph`. */
export interface PerFileGraphOptions {
  readonly files: number
  readonly runs: number
  /** Keep the generated project (its path is printed) instead of removing it. */
  readonly keep: boolean
  /** Run only these subjects (both by default). */
  readonly subjects: readonly Subject[]
  /**
   * Another checkout of this repository, whose `provino jest` runs as a third subject
   * (`baseline`), interleaved with the others: how a change is measured against the code before it.
   */
  readonly baseline?: string
  /**
   * The project's `workerIdleMemoryLimit` (Jest's units), so a worker that passes it after a file is
   * replaced, as a project that sets one sees. Unset, both run in band.
   */
  readonly idleMemoryLimit?: string
  /**
   * The graph as ES modules in the project's `src/` (`esmLibraryFiles`), with a collection before
   * each memory row. Provino's subjects only: Jest's default transform leaves ES modules as they are.
   */
  readonly esm: boolean
}

/** Who runs: Jest, this tree's `provino jest`, or the baseline tree's. */
export type Subject = 'provino' | 'jest' | 'baseline'

/** The variable that names a run's memory log. */
const MEMORY_LOG = 'PER_FILE_GRAPH_MEMORY_LOG'
/** Set (`--esm`) when the memory row collects first: the subject runs with `--expose-gc`. */
const MEMORY_GC = 'PER_FILE_GRAPH_MEMORY_GC'

const pad = (index: number): string => String(index).padStart(4, '0')

async function writeTree(root: string, files: Map<string, string>): Promise<void> {
  const dirs = new Set<string>()
  for (const path of files.keys()) dirs.add(dirname(join(root, path)))
  for (const dir of dirs) mkdirSync(dir, { recursive: true })
  await Promise.all([...files].map(([path, text]) => writeFile(join(root, path), text)))
}

/** The generated packages, as `path -> text`. Plain CommonJS, as a UI library's `cjs` build ships. */
function libraryFiles(): Map<string, string> {
  const files = new Map<string, string>()
  const pkg = (name: string): void => {
    files.set(`node_modules/${name}/package.json`, `{"name":"${name}","main":"index.js"}\n`)
  }
  // The dom package: its index reads `document` at load (the D129 trigger); its helpers don't.
  pkg('ui-dom')
  const domRequires: string[] = []
  for (let index = 0; index < DOM_MODULES; index++) {
    files.set(
      `node_modules/ui-dom/helper${pad(index)}.js`,
      `'use strict';\nexports.name = 'helper${index}';\nexports.apply = function apply(node, value) {\n  node.setAttribute('data-h${index}', String(value));\n  return node;\n};\n`,
    )
    domRequires.push(`exports.helper${index} = require('./helper${pad(index)}.js');`)
  }
  files.set(
    'node_modules/ui-dom/index.js',
    `'use strict';\nvar doc = document;\nvar canUseDom = typeof doc.createElement === 'function';\n${domRequires.join('\n')}\nexports.canUseDom = canUseDom;\nexports.createElement = function createElement(tag) {\n  return doc.createElement(tag);\n};\n`,
  )
  // The core package: a web of modules, with cycles, each reaching the dom package.
  pkg('ui-core')
  const coreRequires: string[] = []
  for (let index = 0; index < CORE_MODULES; index++) {
    const next = (index + 1) % CORE_MODULES
    const back = Math.floor(index / 2)
    files.set(
      `node_modules/ui-core/m${pad(index)}.js`,
      `'use strict';\nObject.defineProperty(exports, '__esModule', { value: true });\nvar dom = require('ui-dom');\nvar back = require('./m${pad(back)}.js');\nexports.id = ${index};\nexports.style = function style(props) {\n  var out = {};\n  for (var key in props) out[key + '${index}'] = props[key];\n  return out;\n};\nexports.next = function next() {\n  return require('./m${pad(next)}.js').id;\n};\nexports.canUseDom = function canUseDom() {\n  return dom.canUseDom && back.id >= 0;\n};\n`,
    )
    coreRequires.push(`exports.m${index} = require('./m${pad(index)}.js');`)
  }
  files.set(
    'node_modules/ui-core/index.js',
    `'use strict';\nvar dom = require('ui-dom');\n${coreRequires.join('\n')}\nexports.createElement = dom.createElement;\n`,
  )
  // The icons package: a barrel of `PER_FILE_ICONS` icons, each importing the shared util.
  pkg('ui-icons')
  files.set(
    'node_modules/ui-icons/util.js',
    `'use strict';\nvar core = require('ui-core');\nexports.createIcon = function createIcon(path, name) {\n  function Icon(props) {\n    var node = core.createElement('svg');\n    node.setAttribute('data-icon', name);\n    node.setAttribute('d', path);\n    return node;\n  }\n  Icon.displayName = name + 'Icon';\n  return Icon;\n};\n`,
  )
  const barrel: string[] = [
    "'use strict';",
    "Object.defineProperty(exports, '__esModule', { value: true });",
    'function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }',
  ]
  for (let index = 0; index < PER_FILE_ICONS; index++) {
    files.set(
      `node_modules/ui-icons/Icon${pad(index)}.js`,
      `'use strict';\nObject.defineProperty(exports, '__esModule', { value: true });\nexports.default = void 0;\nvar _util = require('./util.js');\nvar _default = (0, _util.createIcon)('M${index} 20v-6h4v6h5v-8h3L12 3 2 12h3v8z', 'Icon${pad(index)}');\nexports.default = _default;\n`,
    )
    barrel.push(
      `Object.defineProperty(exports, 'Icon${pad(index)}', { enumerable: true, get: function () { return _Icon${pad(index)}.default; } });`,
      `var _Icon${pad(index)} = _interopRequireDefault(require('./Icon${pad(index)}.js'));`,
    )
  }
  files.set('node_modules/ui-icons/index.js', `${barrel.join('\n')}\n`)
  // The components package: each component reaches core, dom and two siblings.
  pkg('ui-lib')
  for (let index = 0; index < COMPONENTS; index++) {
    const sibling = (index * 7 + 3) % COMPONENTS
    const below = Math.floor(index / 3)
    files.set(
      `node_modules/ui-lib/C${pad(index)}.js`,
      `'use strict';\nObject.defineProperty(exports, '__esModule', { value: true });\nvar core = require('ui-core');\nvar dom = require('ui-dom');\nvar sibling = require('./C${pad(sibling)}.js');\nvar below = require('./C${pad(below)}.js');\nexports.render = function render(label) {\n  var node = dom.createElement('div');\n  node.setAttribute('data-c', '${index}');\n  node.textContent = String(label);\n  return node;\n};\nexports.related = function related() {\n  return [sibling.render, below.render, core.m${index % CORE_MODULES}.id];\n};\n`,
    )
  }
  return files
}

/**
 * The same graph as ES modules in the project's own `src/ui/` (`--esm`): user modules, so each is
 * transformed, kept in its module-runner form by the transform cache, and evaluated per file.
 */
function esmLibraryFiles(): Map<string, string> {
  const files = new Map<string, string>()
  const domExports: string[] = []
  for (let index = 0; index < DOM_MODULES; index++) {
    files.set(
      `src/ui/dom/helper${pad(index)}.js`,
      `export const name = 'helper${index}';\nexport function apply(node, value) {\n  node.setAttribute('data-h${index}', String(value));\n  return node;\n}\n`,
    )
    domExports.push(`export * as helper${index} from './helper${pad(index)}.js';`)
  }
  files.set(
    'src/ui/dom/index.js',
    `${domExports.join('\n')}\nexport const canUseDom = typeof document.createElement === 'function';\nexport function createElement(tag) {\n  return document.createElement(tag);\n}\n`,
  )
  const coreExports: string[] = []
  for (let index = 0; index < CORE_MODULES; index++) {
    const next = (index + 1) % CORE_MODULES
    const back = Math.floor(index / 2)
    files.set(
      `src/ui/core/m${pad(index)}.js`,
      `import * as dom from '../dom/index.js';\nimport * as back from './m${pad(back)}.js';\nimport * as nextModule from './m${pad(next)}.js';\nexport const id = ${index};\nexport function style(props) {\n  const out = {};\n  for (const key in props) out[key + '${index}'] = props[key];\n  return out;\n}\nexport function next() {\n  return nextModule.id;\n}\nexport function canUseDom() {\n  return dom.canUseDom && back.id >= 0;\n}\n`,
    )
    coreExports.push(`export * as m${index} from './m${pad(index)}.js';`)
  }
  files.set(
    'src/ui/core/index.js',
    `${coreExports.join('\n')}\nexport { createElement } from '../dom/index.js';\n`,
  )
  files.set(
    'src/ui/icons/util.js',
    `import { createElement } from '../core/index.js';\nexport function createIcon(path, name) {\n  function Icon(props) {\n    const node = createElement('svg');\n    node.setAttribute('data-icon', name);\n    node.setAttribute('d', path);\n    return node;\n  }\n  Icon.displayName = name + 'Icon';\n  return Icon;\n}\n`,
  )
  const barrel: string[] = []
  for (let index = 0; index < PER_FILE_ICONS; index++) {
    files.set(
      `src/ui/icons/Icon${pad(index)}.js`,
      `import { createIcon } from './util.js';\nexport default createIcon('M${index} 20v-6h4v6h5v-8h3L12 3 2 12h3v8z', 'Icon${pad(index)}');\n`,
    )
    barrel.push(`export { default as Icon${pad(index)} } from './Icon${pad(index)}.js';`)
  }
  files.set('src/ui/icons/index.js', `${barrel.join('\n')}\n`)
  for (let index = 0; index < COMPONENTS; index++) {
    const sibling = (index * 7 + 3) % COMPONENTS
    const below = Math.floor(index / 3)
    files.set(
      `src/ui/lib/C${pad(index)}.js`,
      `import * as core from '../core/index.js';\nimport * as dom from '../dom/index.js';\nimport * as sibling from './C${pad(sibling)}.js';\nimport * as below from './C${pad(below)}.js';\nexport function render(label) {\n  const node = dom.createElement('div');\n  node.setAttribute('data-c', '${index}');\n  node.textContent = String(label);\n  return node;\n}\nexport function related() {\n  return [sibling.render, below.render, core.m${index % CORE_MODULES}.id];\n}\n`,
    )
  }
  return files
}

function testFile(index: number, esm: boolean): string {
  const component = (offset: number): string => pad((index * 37 + offset * 101) % COMPONENTS)
  const imports = esm
    ? [
        "import * as icons from '../src/ui/icons/index.js';",
        `import * as first from '../src/ui/lib/C${component(0)}.js';`,
        `import * as second from '../src/ui/lib/C${component(1)}.js';`,
        `import * as third from '../src/ui/lib/C${component(2)}.js';`,
      ]
    : [
        "const icons = require('ui-icons');",
        `const first = require('ui-lib/C${component(0)}.js');`,
        `const second = require('ui-lib/C${component(1)}.js');`,
        `const third = require('ui-lib/C${component(2)}.js');`,
      ]
  return [
    ...imports,
    '',
    `test('renders file ${index}', () => {`,
    `  const node = first.render('t${index}');`,
    '  document.body.appendChild(node);',
    `  expect(document.querySelector('[data-c]')).toBe(node);`,
    `  expect(icons.Icon${pad(index % PER_FILE_ICONS)}({}).getAttribute('data-icon')).toBe('Icon${pad(index % PER_FILE_ICONS)}');`,
    '  expect(typeof second.related()[0]).toBe("function");',
    '  expect(third.render(1).textContent).toBe("1");',
    '})',
    '',
    "test('memory', () => {",
    `  const log = process.env.${MEMORY_LOG}`,
    '  if (log === undefined) return',
    `  if (process.env.${MEMORY_GC} === '1' && typeof gc === 'function') gc()`,
    '  const usage = process.memoryUsage()',
    `  const row = { file: ${index}, pid: process.pid, rss: usage.rss, heapUsed: usage.heapUsed, arrayBuffers: usage.arrayBuffers }`,
    "  require('fs').appendFileSync(log, JSON.stringify(row) + '\\n')",
    '})',
    '',
  ].join('\n')
}

/** Writes the project; returns its directory. */
export async function writePerFileProject(
  root: string,
  testFiles: number,
  idleMemoryLimit: string | undefined,
  esm: boolean,
): Promise<void> {
  const files = esm ? esmLibraryFiles() : libraryFiles()
  for (let index = 0; index < testFiles; index++) {
    files.set(`tests/t${pad(index)}.test.js`, testFile(index, esm))
  }
  files.set(
    'jest.config.json',
    `${JSON.stringify({
      rootDir: root,
      testMatch: ['<rootDir>/tests/*.test.js'],
      testEnvironment: 'jsdom',
      cacheDirectory: join(root, '.cache'),
      ...(idleMemoryLimit === undefined ? {} : { workerIdleMemoryLimit: idleMemoryLimit }),
    })}\n`,
  )
  files.set('package.json', '{"name":"per-file-graph","private":true}\n')
  await writeTree(root, files)
  // The project's own jsdom environment, as a component suite installs it.
  const harness = createRequire(
    fileURLToPath(new URL('../../../harness/package.json', import.meta.url)),
  )
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  symlinkSync(
    dirname(harness.resolve('jest-environment-jsdom/package.json')),
    join(root, 'node_modules', 'jest-environment-jsdom'),
    'dir',
  )
}

/** One file of a run: its time, and the memory of the process that ran it, after it. */
interface FileNumbers {
  readonly ms: number
  readonly pid: number
  readonly rssMb: number
  readonly heapMb: number
  readonly buffersMb: number
}

/** One run's per-file numbers, in the order the files ran. */
interface RunNumbers {
  readonly wallMs: number
  readonly files: readonly FileNumbers[]
}

type Memory = Omit<FileNumbers, 'ms'>

const MB = 2 ** 20

function readMemory(path: string): Map<number, Memory> {
  const rows = new Map<number, Memory>()
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line === '') continue
    const row = JSON.parse(line) as {
      file: number
      pid: number
      rss: number
      heapUsed: number
      arrayBuffers: number
    }
    rows.set(row.file, {
      pid: row.pid,
      rssMb: row.rss / MB,
      heapMb: row.heapUsed / MB,
      buffersMb: row.arrayBuffers / MB,
    })
  }
  return rows
}

function readResults(path: string, memory: ReadonlyMap<number, Memory>): FileNumbers[] {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const results =
    typeof parsed === 'object' && parsed !== null && 'testResults' in parsed
      ? parsed.testResults
      : undefined
  if (!Array.isArray(results)) throw new Error(`${path} has no testResults`)
  const rows = results.map((entry: unknown) => {
    const result = entry as {
      status?: unknown
      startTime?: unknown
      endTime?: unknown
      name?: unknown
    }
    const name = String(result.name)
    if (result.status !== 'passed') throw new Error(`${name} did not pass`)
    const start = Number(result.startTime)
    const end = Number(result.endTime)
    const used = memory.get(Number(/t(\d+)\.test\.js$/.exec(name)?.[1]))
    if (!Number.isFinite(start) || !Number.isFinite(end) || used === undefined) {
      throw new Error(`${name} has no times or no memory row`)
    }
    return { start, file: { ms: end - start, ...used } }
  })
  rows.sort((a, b) => a.start - b.start)
  return rows.map((row) => row.file)
}

async function runOnce(
  subject: Subject,
  root: string,
  name: string,
  baseline: string | undefined,
  esm: boolean,
): Promise<RunNumbers> {
  const out = join(root, `${name}.json`)
  const log = join(root, `${name}.memory.jsonl`)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NO_COLOR: '1',
    CI: '1',
    [MEMORY_LOG]: log,
    ...(esm ? { [MEMORY_GC]: '1' } : {}),
  }
  for (const key of ['CLAUDECODE', 'AI_AGENT', 'GITHUB_ACTIONS']) delete env[key]
  const flags = ['-w', '1', '--ci', '--json', '--outputFile', out]
  const cli =
    subject === 'baseline' && baseline !== undefined
      ? join(baseline, 'packages', 'provino', 'src', 'cli.ts')
      : fileURLToPath(new URL('../../../provino/src/cli.ts', import.meta.url))
  const args =
    subject === 'jest'
      ? [
          resolveRunnerPackage('jest', import.meta.url).bin,
          '--config',
          'jest.config.json',
          ...flags,
        ]
      : [
          ...(esm ? ['--expose-gc'] : []),
          '--conditions=provino-source',
          cli,
          'jest',
          '--config',
          'jest.config.json',
          ...flags,
        ]
  const result = await runProcess(process.execPath, args, { cwd: root, env, timeoutMs: 900_000 })
  if (result.exitCode !== 0) {
    throw new Error(`${subject} exited with ${result.exitCode}:\n${result.output}`)
  }
  return { wallMs: result.wallMs, files: readResults(out, readMemory(log)) }
}

interface Summary {
  readonly wallMs: number
  readonly firstMs: number
  readonly restMs: number
  /** Per file position: the medians over the runs. */
  readonly rssMb: readonly number[]
  readonly heapMb: readonly number[]
  readonly buffersMb: readonly number[]
  /** The worker processes a run used, the median over the runs. */
  readonly workers: number
}

function summarize(runs: readonly RunNumbers[]): Summary {
  const count = Math.min(...runs.map((run) => run.files.length))
  const at = (pick: (file: FileNumbers) => number): number[] =>
    Array.from({ length: count }, (_, index) =>
      median(runs.map((run) => pick(run.files[index] as FileNumbers))),
    )
  return {
    wallMs: median(runs.map((run) => run.wallMs)),
    firstMs: median(runs.map((run) => run.files[0]?.ms ?? Number.NaN)),
    restMs: median(runs.map((run) => median(run.files.slice(1).map((file) => file.ms)))),
    rssMb: at((file) => file.rssMb),
    heapMb: at((file) => file.heapMb),
    buffersMb: at((file) => file.buffersMb),
    workers: median(runs.map((run) => new Set(run.files.map((file) => file.pid)).size)),
  }
}

const row = (values: readonly number[]): string => values.map((value) => value.toFixed(0)).join(' ')

/** Runs the comparison; returns the lines to print. */
export async function perFileGraphLines(options: PerFileGraphOptions): Promise<string[]> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'provino-per-file-graph-')))
  try {
    if (options.esm && options.subjects.includes('jest')) {
      throw new Error('--esm runs Provino only: Jest leaves ES modules untransformed')
    }
    await writePerFileProject(root, options.files, options.idleMemoryLimit, options.esm)
    const runs: Record<Subject, RunNumbers[]> = { provino: [], jest: [], baseline: [] }
    for (let run = 0; run <= options.runs; run++) {
      // The first side alternates, so none always runs on a machine another just warmed.
      const order = run % 2 === 0 ? options.subjects : [...options.subjects].reverse()
      for (const subject of order) {
        const numbers = await runOnce(
          subject,
          root,
          `${subject}-${run}`,
          options.baseline,
          options.esm,
        )
        if (run > 0) runs[subject].push(numbers)
      }
    }
    const jestVersion = resolveRunnerPackage('jest', import.meta.url).version
    const limit =
      options.idleMemoryLimit === undefined
        ? 'in band'
        : `workerIdleMemoryLimit ${options.idleMemoryLimit}`
    const shape = options.esm
      ? 'ES modules in src/, heapUsed after a collection'
      : 'CommonJS in node_modules, dom reads document at load'
    const lines = [
      `loader per-file-graph (local, Node ${process.version}, ${options.files} files, -w 1, ${limit}, jsdom through jest-environment-jsdom; median of ${options.runs} warm runs after 1 discarded, interleaved)`,
      `  graph: ${PER_FILE_ICONS} icons + barrel + util, ${CORE_MODULES} core, ${COMPONENTS} components, ${DOM_MODULES + 1} dom (${shape})`,
    ]
    const summaries = new Map<Subject, Summary>()
    for (const subject of options.subjects) {
      const summary = summarize(runs[subject])
      summaries.set(subject, summary)
      const label =
        subject === 'jest'
          ? `jest ${jestVersion}`
          : subject === 'baseline'
            ? 'baseline'
            : 'provino jest'
      lines.push(
        `  ${label.padEnd(12)} wall ${summary.wallMs.toFixed(0)} ms, file 1 ${summary.firstMs.toFixed(0)} ms, files 2..${options.files} median ${summary.restMs.toFixed(0)} ms, ${summary.workers} worker processes`,
        `  ${''.padEnd(12)} RSS MB after each file:      ${row(summary.rssMb)}`,
        `  ${''.padEnd(12)} heapUsed MB after each file: ${row(summary.heapMb)}`,
        `  ${''.padEnd(12)} arrayBuffers MB after each:  ${row(summary.buffersMb)}`,
      )
    }
    const theirs = summaries.get('jest')
    for (const subject of ['provino', 'baseline'] as const) {
      const ours = summaries.get(subject)
      if (ours === undefined || theirs === undefined) continue
      lines.push(
        `  ratio ${subject}/jest: wall ${(ours.wallMs / theirs.wallMs).toFixed(2)}, file 1 ${(ours.firstMs / theirs.firstMs).toFixed(2)}, files 2..N ${(ours.restMs / theirs.restMs).toFixed(2)}`,
      )
    }
    if (options.keep) lines.push(`  project kept at ${root}`)
    return lines
  } finally {
    if (!options.keep) rmSync(root, { recursive: true, force: true })
  }
}
