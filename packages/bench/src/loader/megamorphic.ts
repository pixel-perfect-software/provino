// The `megamorphic` command of `bench:loader`: whether a module evaluated per file keeps its
// speed from the first files to the last, with no React in sight. A generated CommonJS package in
// `node_modules` reads `document` while it loads (D129's trigger, as `ui-library`'s dom package
// does), so it is evaluated again in every test file under the Jest dialect; it defines a class and
// a hot function that reads six properties of that class's instances, and calls one of its
// methods, in a loop. N test files each build fresh instances of their own evaluation's class and
// time the hot loop with `performance.now()`.
//
// Each evaluation's class is new, so its instances have a new hidden class. When every evaluation
// runs the same wrapper function object, the hot function's closures share one feedback vector
// across files, and its property loads see one more map per file: past V8's polymorphic limit they
// are megamorphic, and every later file runs the loop slower. With a fresh wrapper per evaluation
// (Jest compiles each module afresh for every test file) the loop costs the same in every file.
//
// `provino jest -w 1`, Jest 30.5.2 (`jest -w 1`) and optionally a `--baseline <checkout>`'s
// `provino jest` run the same project, interleaved, warm (one discarded warm-up each). Reported per
// subject: the hot loop's median over files 2-5 against its median over the last 5 files, the same
// for each file's time from `--json`, and the hot loop of every file position. No bar; every
// number is `local`.
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@provino/harness'
import { median } from '../stats.ts'
import { writePackage } from './packages.ts'
import {
  linkJsdomEnvironment,
  type Subject,
  subjectArgs,
  subjectLabel,
  writeTree,
} from './subjects.ts'

/** Test files in the project, by default: well past the polymorphic limit of 4 maps. */
export const MEGAMORPHIC_TESTS = 24
/** Instances each file builds, and how many times the hot loop walks them. */
const ITEMS = 5000
const ROUNDS = 400

/** The options of `bench:loader megamorphic`. */
export interface MegamorphicOptions {
  readonly files: number
  readonly runs: number
  /** Keep the generated project (its path is printed) instead of removing it. */
  readonly keep: boolean
  /** The subjects to run, interleaved in this order. */
  readonly subjects: readonly Subject[]
  /** Another checkout of this repository, whose `provino jest` runs as the `baseline` subject. */
  readonly baseline?: string
}

/** The variable that names a run's hot-loop log. */
const LOOP_LOG = 'MEGAMORPHIC_LOOP_LOG'

const pad = (index: number): string => String(index).padStart(4, '0')

/** The per-file package: CommonJS, read `document` at load, one class and a hot loop over it. */
const LIBRARY = `'use strict';
// Read at load: a per-file global, so the module is evaluated again in every test file (D129).
var canUseDom = typeof document.createElement === 'function';
class Item {
  constructor(index) {
    this.a = index;
    this.b = index + 1;
    this.c = index + 2;
    this.d = index + 3;
    this.e = index + 4;
    this.f = index + 5;
  }
  weight() {
    return this.a + this.f;
  }
}
function build(count) {
  var items = [];
  for (var index = 0; index < count; index++) items.push(new Item(index));
  return items;
}
function score(items, rounds) {
  var sum = 0;
  for (var round = 0; round < rounds; round++) {
    for (var index = 0; index < items.length; index++) {
      var item = items[index];
      sum += item.a + item.b + item.c + item.d + item.e + item.weight();
    }
  }
  return sum;
}
exports.canUseDom = canUseDom;
exports.Item = Item;
exports.build = build;
exports.score = score;
`

/** What `score(build(ITEMS), ROUNDS)` returns. */
function expectedScore(): number {
  let perRound = 0
  for (let index = 0; index < ITEMS; index++) perRound += 5 * index + 10 + 2 * index + 5
  return perRound * ROUNDS
}

function testFile(index: number): string {
  return [
    "const lib = require('mega-lib');",
    '',
    `test('hot loop, file ${index}', () => {`,
    '  expect(lib.canUseDom).toBe(true);',
    `  const items = lib.build(${ITEMS});`,
    '  const start = performance.now();',
    `  const sum = lib.score(items, ${ROUNDS});`,
    '  const ms = performance.now() - start;',
    `  expect(sum).toBe(${expectedScore()});`,
    `  const log = process.env.${LOOP_LOG};`,
    '  if (log === undefined) return;',
    `  const row = { file: ${index}, pid: process.pid, ms };`,
    "  require('fs').appendFileSync(log, JSON.stringify(row) + '\\n');",
    '});',
    '',
  ].join('\n')
}

async function writeProject(root: string, testFiles: number): Promise<void> {
  writePackage(root, 'mega-lib', [['index.js', LIBRARY]], 'index.js')
  const files = new Map<string, string>()
  for (let index = 0; index < testFiles; index++) {
    files.set(`tests/t${pad(index)}.test.js`, testFile(index))
  }
  files.set(
    'jest.config.json',
    `${JSON.stringify({
      rootDir: root,
      testMatch: ['<rootDir>/tests/*.test.js'],
      testEnvironment: 'jsdom',
      cacheDirectory: join(root, '.cache'),
    })}\n`,
  )
  files.set('package.json', '{"name":"megamorphic","private":true}\n')
  await writeTree(root, files)
  linkJsdomEnvironment(root)
}

/** One file of a run, in the order the files ran: its time, and its hot loop's. */
interface FileNumbers {
  readonly ms: number
  readonly loopMs: number
}

function readLoops(path: string): Map<number, number> {
  const loops = new Map<number, number>()
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line === '') continue
    const row = JSON.parse(line) as { file: number; ms: number }
    loops.set(row.file, row.ms)
  }
  return loops
}

function readResults(path: string, loops: ReadonlyMap<number, number>): FileNumbers[] {
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
    const loopMs = loops.get(Number(/t(\d+)\.test\.js$/.exec(name)?.[1]))
    if (!Number.isFinite(start) || !Number.isFinite(end) || loopMs === undefined) {
      throw new Error(`${name} has no times or no hot-loop row`)
    }
    return { start, file: { ms: end - start, loopMs } }
  })
  rows.sort((a, b) => a.start - b.start)
  return rows.map((row) => row.file)
}

async function runOnce(
  subject: Subject,
  root: string,
  name: string,
  baseline: string | undefined,
): Promise<FileNumbers[]> {
  const out = join(root, `${name}.json`)
  const log = join(root, `${name}.loops.jsonl`)
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', CI: '1', [LOOP_LOG]: log }
  const args = subjectArgs(subject, ['-w', '1', '--ci', '--json', '--outputFile', out], baseline)
  const result = await runProcess(process.execPath, args, { cwd: root, env, timeoutMs: 900_000 })
  if (result.exitCode !== 0) {
    throw new Error(`${subject} exited with ${result.exitCode}:\n${result.output}`)
  }
  return readResults(out, readLoops(log))
}

/** Files 2-5 against the last 5, by file position, for one measure. */
interface Spread {
  readonly early: number
  readonly late: number
}

function spread(values: readonly number[]): Spread {
  return { early: median(values.slice(1, 5)), late: median(values.slice(-5)) }
}

const ms = (value: number): string => value.toFixed(1)

/** Runs the comparison; returns the lines to print. */
export async function megamorphicLines(options: MegamorphicOptions): Promise<string[]> {
  if (options.files < 10) throw new Error('--files must be at least 10: files 2-5 and the last 5')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'provino-megamorphic-')))
  try {
    await writeProject(root, options.files)
    const runs: Record<Subject, FileNumbers[][]> = { provino: [], jest: [], baseline: [] }
    for (let run = 0; run <= options.runs; run++) {
      // The first side alternates, so none always runs on a machine another just warmed.
      const order = run % 2 === 0 ? options.subjects : [...options.subjects].reverse()
      for (const subject of order) {
        const files = await runOnce(subject, root, `${subject}-${run}`, options.baseline)
        if (run > 0) runs[subject].push(files)
      }
    }
    const lines = [
      `loader megamorphic (local, Node ${process.version}, ${options.files} files, -w 1, jsdom through jest-environment-jsdom; median of ${options.runs} warm runs after 1 discarded, interleaved)`,
      `  mega-lib: one class (6 fields, a method), read document at load (evaluated per file); each file's hot loop reads ${ITEMS} instances x ${ROUNDS} rounds`,
    ]
    for (const subject of options.subjects) {
      const subjectRuns = runs[subject]
      const count = Math.min(...subjectRuns.map((files) => files.length))
      // Per file position, the median over the runs.
      const at = (pick: (file: FileNumbers) => number): number[] =>
        Array.from({ length: count }, (_, index) =>
          median(subjectRuns.map((files) => pick(files[index] as FileNumbers))),
        )
      const loops = at((file) => file.loopMs)
      const loop = spread(loops)
      const file = spread(at((numbers) => numbers.ms))
      const label = subjectLabel(subject)
      lines.push(
        `  ${label.padEnd(12)} hot loop ms: files 2-5 ${ms(loop.early)}, last 5 ${ms(loop.late)} (x${(loop.late / loop.early).toFixed(2)}); file ms: files 2-5 ${ms(file.early)}, last 5 ${ms(file.late)} (x${(file.late / file.early).toFixed(2)})`,
        `  ${''.padEnd(12)} hot loop ms by file: ${loops.map((value) => value.toFixed(0)).join(' ')}`,
      )
    }
    if (options.keep) lines.push(`  project kept at ${root}`)
    return lines
  } finally {
    if (!options.keep) rmSync(root, { recursive: true, force: true })
  }
}
