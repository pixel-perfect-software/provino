#!/usr/bin/env node
// One fresh process of `bench:expect-import` (T7.12): imports the built `provino` entry, then the
// built worker-side expect (the Jest dialect's runtime: the engine, its `expect` table and
// pretty-format), and prints `PROVINO_SAMPLE {"entry": ms, "engine": ms, "total": ms}`. Usage:
// entry.ts <provino dist directory>. It runs with no `provino-source` condition, so it measures the
// files a user installs, and imports only Node's own modules before the clock starts.
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

const dist = process.argv[2]
if (dist === undefined) throw new Error('usage: entry.ts <provino dist directory>')
const url = (file: string): string => pathToFileURL(`${dist}/${file}`).href

const start = performance.now()
await import(url('index.js'))
const afterEntry = performance.now()
await import(url('worker/jest-runtime.js'))
const end = performance.now()

console.log(
  `PROVINO_SAMPLE ${JSON.stringify({ entry: afterEntry - start, engine: end - afterEntry, total: end - start })}`,
)
