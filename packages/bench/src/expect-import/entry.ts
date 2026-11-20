#!/usr/bin/env node
// One fresh process of `bench:expect-import` (T7.12): imports the built `provino` entry, then the
// built worker-side expect (a dialect's worker runtime: `worker/jest-runtime.js` is the engine, the
// Jest dialect's `expect` table and pretty-format; `worker/vitest-runtime.js` the Vitest one's,
// B25b), and prints `PROVINO_SAMPLE {"entry": ms, "engine": ms, "total": ms}`. Usage:
// entry.ts <provino dist directory> <worker runtime file>. It runs with no `provino-source`
// condition, so it measures the files a user installs, and imports only Node's own modules before
// the clock starts.
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

const [, , dist, runtime] = process.argv
if (dist === undefined || runtime === undefined) {
  throw new Error('usage: entry.ts <provino dist directory> <worker runtime file>')
}
const url = (file: string): string => pathToFileURL(`${dist}/${file}`).href

const start = performance.now()
await import(url('index.js'))
const afterEntry = performance.now()
await import(url(runtime))
const end = performance.now()

console.log(
  `PROVINO_SAMPLE ${JSON.stringify({ entry: afterEntry - start, engine: end - afterEntry, total: end - start })}`,
)
