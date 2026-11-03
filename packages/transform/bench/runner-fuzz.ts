// T2.4's acceptance check: 10,000 generated TypeScript files go through the pipeline and then the
// guarded module-runner transform (`toModuleRunner`) in this one process. The TS conformance
// corpus isn't vendored, so the brief's fallback applies: a seeded generator mixes TS constructs,
// including type-only re-exports (oxc's runner transform aborts the process on those when they
// are left unstripped), and makes 2% of the files deliberately broken.
// Bar: the process finishes, and every failure comes back as a per-file error naming the file.
//
// Usage: node --conditions=provino-source packages/transform/bench/runner-fuzz.ts
//          [--files 10000] [--seed 1] [--json]
import { parseArgs } from 'node:util'
import { createPipeline, TransformError, toModuleRunner } from '@provino/transform'

const { values: args } = parseArgs({
  options: {
    files: { type: 'string', default: '10000' },
    seed: { type: 'string', default: '1' },
    json: { type: 'boolean', default: false },
  },
})
const FILES = Number(args.files)
const BROKEN_SHARE = 0.02

/** mulberry32: a small seeded PRNG, so the corpus is the same on every run. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Snippets of TS syntax; `@@` is replaced with a per-file unique suffix. */
const SNIPPETS: readonly string[] = [
  'export type T@@ = { readonly a: number; b?: string }',
  'export interface I@@ { x: number; f(y: string): void }',
  "import type { Foo@@ } from './types.js'\nexport type UsesFoo@@ = Foo@@",
  "import { type Bar@@, baz@@ } from './bar.js'\nexport const useBaz@@ = baz@@ as unknown as Bar@@",
  "export type { Re@@ } from './types.js'",
  "export { type Mixed@@, value@@ } from './mixed.js'",
  "export * as ns@@ from './x.js'",
  "export { default as d@@ } from './y.js'",
  "export enum E@@ { A, B = 'b', C = 3 }",
  'export const enum CE@@ { X = 1 }\nexport const ce@@ = CE@@.X',
  'export namespace N@@ { export const v = 1 }',
  'export abstract class A@@<T> {\n  constructor(private readonly t: T, public n: number) {}\n  abstract run(): T\n}',
  'export function over@@(a: string): string\nexport function over@@(a: number): number\nexport function over@@(a: unknown) { return a }',
  'export const sat@@ = { a: 1 } satisfies Record<string, number>',
  "export const tuple@@ = [1, 'a'] as const",
  'declare const dg@@: number\nexport declare function df@@(): void',
  'declare function dec@@(target: unknown): void\n@dec@@\nexport class Decorated@@ {}',
  'export default async function main@@() { await Promise.resolve() }',
  'export const tla@@ = await Promise.resolve(1)',
  'export function id@@<T extends object = {}>(x: T): T { return x }',
  'export class Acc@@ { accessor v = 1 }',
  'export class P@@ { #x = 1; static { void this } get x() { return this.#x } }',
  'let u@@: unknown = 1 as unknown as string\nexport { u@@ }',
  'export const nn@@ = (globalThis as { x?: number })!.x',
  'let da@@!: number\nexport const readDa@@ = () => da@@',
  'export type TL@@ = `a-$' + '{string}`',
  'export function useIt@@() { using r = { [Symbol.dispose]() {} }; return r }',
  'export class Base@@ { m(): void {} }\nexport class Over@@ extends Base@@ { override m(): void {} }',
  'export const opt@@ = (o?: { a?: { b?: number } }) => o?.a?.b ?? 0',
  'import def@@, * as all@@ from "./star.js"\nexport const both@@ = [def@@, all@@]',
  'export const dyn@@ = () => import("./lazy.js")',
  'export const meta@@ = import.meta.url',
]
const JSX_SNIPPET = 'export const el@@ = <div className="a">{1}</div>'
const BROKEN_SNIPPET = 'export const = ;'

const next = random(Number(args.seed))
const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T

interface Generated {
  readonly filename: string
  readonly source: string
  readonly broken: boolean
}

const corpus: Generated[] = []
for (let i = 0; i < FILES; i++) {
  const tsx = next() < 0.1
  const parts: string[] = []
  const count = 3 + Math.floor(next() * 6)
  for (let j = 0; j < count; j++) parts.push(pick(SNIPPETS).replaceAll('@@', `_${i}_${j}`))
  if (tsx) parts.push(JSX_SNIPPET.replaceAll('@@', `_${i}`))
  const broken = next() < BROKEN_SHARE
  if (broken) parts.splice(Math.floor(next() * parts.length), 0, BROKEN_SNIPPET)
  corpus.push({
    filename: `/fuzz/f${String(i).padStart(5, '0')}.${tsx ? 'tsx' : 'ts'}`,
    source: `${parts.join('\n')}\n`,
    broken,
  })
}

const pipeline = createPipeline({
  root: '/fuzz',
  typescript: 'oxc',
  tsconfig: false,
  hoist: null,
  cache: false,
})

const failures: { readonly file: string; readonly stage: string; readonly message: string }[] = []
const uncoded: string[] = []
let transformed = 0
const start = process.hrtime.bigint()
for (const file of corpus) {
  try {
    const record = pipeline.transform({
      filename: file.filename,
      source: file.source,
      role: 'test',
      consumer: 'import',
      instrument: false,
    })
    const error = record.diagnostics.find((diagnostic) => diagnostic.severity === 'error')
    if (error !== undefined) {
      failures.push({ file: file.filename, stage: 'strip', message: error.message })
      continue
    }
    toModuleRunner(file.filename, record)
    transformed++
  } catch (error) {
    if (error instanceof TransformError && error.message.includes(file.filename)) {
      failures.push({ file: file.filename, stage: 'runner', message: error.message })
    } else uncoded.push(`${file.filename}: ${String(error)}`)
  }
}
const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6

const failed = new Set(failures.map((failure) => failure.file))
const brokenFiles = corpus.filter((file) => file.broken)
const brokenMissed = brokenFiles.filter((file) => !failed.has(file.filename))
const unexpected = failures.filter(
  (failure) => !brokenFiles.some((file) => file.filename === failure.file),
)
const problems: string[] = []
if (brokenMissed.length > 0) problems.push(`${brokenMissed.length} broken files were not reported`)
if (uncoded.length > 0)
  problems.push(`${uncoded.length} failures were not per-file TransformErrors`)

const report = {
  label: 'local',
  node: process.version,
  files: corpus.length,
  transformed,
  failedPerFile: failures.length,
  brokenOnPurpose: brokenFiles.length,
  unexpectedFailures: unexpected.slice(0, 20),
  uncoded: uncoded.slice(0, 20),
  elapsedMs: Math.round(elapsedMs),
  problems,
}
if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
else {
  process.stdout.write(
    [
      `runner fuzz (local, Node ${process.version}, seed ${args.seed})`,
      `  files ${corpus.length}: transformed ${transformed}, failed per file ${failures.length} (${brokenFiles.length} broken on purpose)`,
      `  unexpected failures ${unexpected.length}`,
      ...unexpected.slice(0, 10).map((failure) => `    ${failure.stage} ${failure.message}`),
      `  ${Math.round(elapsedMs)} ms total; the process did not abort`,
      ...problems.map((problem) => `FAIL ${problem}`),
      '',
    ].join('\n'),
  )
}
process.exitCode = problems.length === 0 ? 0 : 1
