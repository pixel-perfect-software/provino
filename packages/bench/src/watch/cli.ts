#!/usr/bin/env node
// `pnpm bench:watch [--max-ms 150] [--saves 20] [--runner jest] [--sessions n] [--files n]
// [--settle-ms n] [--keep]`: T9.11's bar. `provino jest --watch` on Spikes B's tree (5,000 `.ts`
// files in 600 directories, 500 of them tests over chains of modules) in a hermetic git
// repository in `$TMPDIR`, started with no terminal. A probe reporter reports each run's first
// file start; the bench saves one leaf `--saves` times (each after the run the last save caused
// has ended) and reports the median of first file start less the save. The selection is Jest's
// `--watch` (the files changed since the last commit), git commands included. `--runner jest`
// runs Jest 30.5.2's `--watch` the same way as a signal and prints the ratio; with it the
// subjects run `--sessions` (default 2) sessions each, alternating which goes first. Every number
// is `local` and no result: `.claude/rules/benchmarks.md`. Exit 0 when nothing missed (or no bar
// is on), 1 on a miss, 2 on bad usage.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exitOnSignals, resolveRunnerPackage } from '@provino/harness'
import { exitCodeFor, parseOrExitUsage } from '../internal/limits.ts'
import { generateWatchTree } from './generate.ts'
import {
  filesNote,
  parseWatchFlags,
  type WatchSubject,
  watchFailures,
  watchLines,
} from './report.ts'
import { runSession, writeWatchProject } from './run.ts'

// Each runner is in its own process group, so Ctrl-C must end them through this hook.
exitOnSignals()

const SESSION_TIMEOUT_MS = 120_000

const flags = parseOrExitUsage('bench:watch', () => parseWatchFlags(process.argv.slice(2)))
const tree = generateWatchTree({ files: flags.files })
const note = filesNote(flags.files, tree.files.size)
if (note !== undefined) process.stderr.write(`bench:watch: warning: ${note}\n`)
const subjects: readonly WatchSubject[] = flags.withJest ? ['provino', 'jest'] : ['provino']
const root = realpathSync(mkdtempSync(join(tmpdir(), 'provino-watch-')))
const samples: Record<WatchSubject, number[]> = { provino: [], jest: [] }
try {
  await writeWatchProject(root, tree)
  for (let session = 0; session < flags.sessions; session++) {
    // The first side alternates, so neither always watches a machine the other just warmed.
    const order = session % 2 === 0 ? subjects : subjects.toReversed()
    for (const subject of order) {
      samples[subject].push(
        ...(await runSession({
          subject,
          root,
          tree,
          saves: flags.saves,
          settleMs: flags.settleMs,
          timeoutMs: SESSION_TIMEOUT_MS,
        })),
      )
    }
  }
} finally {
  if (flags.keep) process.stderr.write(`bench:watch: tree kept at ${root}\n`)
  else rmSync(root, { recursive: true, force: true })
}

const jest = resolveRunnerPackage('jest', import.meta.url)
const names: Record<WatchSubject, string> = {
  provino: 'provino jest --watch',
  jest: `jest ${jest.version} --watch`,
}
const header = `watch bench (local, Node ${process.version}, ${process.platform} ${process.arch}; ${tree.files.size} files${note === undefined ? '' : ` (${flags.files} asked for)`} in ${tree.directories} directories, ${tree.tests} tests over chains of ${tree.chainLength}; save to first file start, no terminal, git selection; ${flags.sessions} session${flags.sessions === 1 ? '' : 's'} of ${flags.saves} saves per subject${flags.withJest ? ', interleaved' : ''})`
const expected = flags.sessions * flags.saves
const missed = watchFailures(samples, expected, flags.maxMs)
process.stdout.write(
  `${[header, ...watchLines(samples, flags, names), ...missed.map((miss) => `FAIL ${miss}`)].join('\n')}\n`,
)
process.exitCode = exitCodeFor(missed)
