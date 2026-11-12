// The seeded TypeScript corpus of `bench:runner-fuzz` (T2.4), shared with `bench:runner-diff`.

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
const BROKEN_SHARE = 0.02
const JSX_SNIPPET = 'export const el@@ = <div className="a">{1}</div>'
const BROKEN_SNIPPET = 'export const = ;'

export interface Generated {
  readonly filename: string
  readonly source: string
  readonly broken: boolean
  /**
   * The file has two `export default` declarations by accident of the generator: invalid
   * JavaScript. oxc's runner transform let it through when it parsed the stripped code as
   * TypeScript (overloads); ours parses JavaScript and reports it (B20).
   */
  readonly duplicateDefault: boolean
}

/** The corpus of `files` files from `seed`; 2% are broken on purpose. */
export function generateFuzzCorpus(files: number, seed: number): Generated[] {
  const next = random(seed)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T
  const corpus: Generated[] = []
  for (let i = 0; i < files; i++) {
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
      duplicateDefault: parts.filter((part) => part.startsWith('export default')).length > 1,
    })
  }
  return corpus
}
