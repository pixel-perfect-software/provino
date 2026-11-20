#!/usr/bin/env node
// pnpm drift [--jest <from>..<to>] [--vitest <from>..<to>] (T7.15): for each range, the upstream
// files the vendor directories copied that differ between the two tags, each with the `UPSTREAM.md`
// that names it. A local command (open question 12): it downloads the tags' tarballs. Exit 0 with
// the report, 2 on bad usage, 1 when a tarball can't be had, a source is in neither tag or a range
// checked no file (a report that read nothing is no all-clear).
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { isNodeModules, walkFiles } from '../internal/walk.ts'
import { driftBetween, driftFails, formatDrift } from './drift.ts'
import { treeAt } from './tarball.ts'
import { parseUpstream, REPOSITORIES, type Repository } from './upstream.ts'

const USAGE = 'usage: pnpm drift [--jest <from>..<to>] [--vitest <from>..<to>]'

/** The ranges asked for, or a usage error. */
export function parseDriftArgs(
  args: readonly string[],
): { readonly repository: Repository; readonly from: string; readonly to: string }[] | string {
  const range = { type: 'string', multiple: true } as const
  const tokens = (() => {
    try {
      return parseArgs({
        args: [...args],
        options: Object.fromEntries(Object.keys(REPOSITORIES).map((name) => [name, range])),
        strict: true,
        tokens: true,
      }).tokens
    } catch (error) {
      return error instanceof Error ? error.message : 'bad arguments'
    }
  })()
  if (typeof tokens === 'string') return tokens
  const ranges: { repository: Repository; from: string; to: string }[] = []
  // In the order given, as the report prints them.
  for (const token of tokens) {
    if (token.kind !== 'option') continue
    const [from, to, ...rest] = (token.value ?? '').split('..')
    if (!from || !to || rest.length > 0) return `${token.rawName} needs <from>..<to>`
    ranges.push({ repository: token.name as Repository, from, to })
  }
  return ranges.length > 0 ? ranges : 'name at least one range'
}

const root = fileURLToPath(new URL('../../../..', import.meta.url))

async function main(args: readonly string[]): Promise<number> {
  const ranges = parseDriftArgs(args)
  if (typeof ranges === 'string') {
    console.error(`${ranges}\n${USAGE}`)
    return 2
  }
  const upstreams = []
  const packages = join(root, 'packages')
  const found = await walkFiles(packages, {
    skipDir: (dir) => isNodeModules(dir) || dir.endsWith('/dist'),
    keep: (file) => file.endsWith('UPSTREAM.md'),
  })
  for (const file of found) {
    const full = join(packages, file)
    upstreams.push(parseUpstream(relative(root, full), readFileSync(full, 'utf8')))
  }
  let failed = false
  for (const { repository, from, to } of ranges) {
    let trees: { from: string; to: string }
    try {
      trees = { from: await treeAt(repository, from), to: await treeAt(repository, to) }
    } catch (error) {
      console.error(`drift: ${repository} ${from}..${to}: ${(error as Error).message}`)
      return 1
    }
    const report = await driftBetween(repository, { from, to }, trees, upstreams)
    console.log(formatDrift(report))
    if (driftFails(report)) failed = true
  }
  return failed ? 1 : 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
