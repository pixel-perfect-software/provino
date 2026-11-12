#!/usr/bin/env node
import path from 'node:path'
import { convertCommand } from './commands/convert.ts'
import { corpusCommand } from './commands/corpus.ts'
import { diffCommand } from './commands/diff.ts'
import { processIo } from './commands/io.ts'
import { selfTestCommand } from './commands/self-test.ts'
import { HarnessError } from './errors.ts'
import { defaultFixturesRoot, findFixtures, readFixture, resolveFixtureDirs } from './fixture.ts'
import {
  type HarnessCommand,
  type PolicyDiffCommand,
  parseCommandLine,
  type RecordCommand,
  USAGE,
} from './internal/cli-args.ts'
import { findStaleGoldens } from './internal/stale-goldens.ts'
import { formatDialectDiff } from './policy-truth/diff.ts'
import { recordRead } from './record.ts'
import { exitOnSignals } from './spawn-in-group.ts'

// provino-harness policy-diff <jest|vitest> <jest|vitest>: the dialects' differing keys (T1.8).
function policyDiff(command: PolicyDiffCommand): number {
  console.log(formatDialectDiff(command.a, command.b))
  return 0
}

// provino-harness record [--check] [--keep] [<fixture dir>...]
async function record(command: RecordCommand): Promise<number> {
  const dirs =
    command.fixtures.length > 0 ? await resolveFixtureDirs(command.fixtures) : await findFixtures()
  if (dirs.length === 0) {
    console.error('no fixtures found')
    return 1
  }

  let failed = false
  const produced = new Set<string>()
  for (const dir of dirs) {
    const fixture = await readFixture(dir)
    for (const profile of fixture.manifest.runners) {
      const result = await recordRead(fixture, profile, {
        check: command.check,
        keepWorkDir: command.keepWorkDir,
      })
      produced.add(result.goldenPath)
      console.log(`${result.outcome.padEnd(9)} ${result.fixture} (${profile})`)
      if (result.workDir !== undefined) console.log(`          kept ${result.workDir}`)
      if (result.outcome === 'drift') {
        failed = true
        console.log(`${result.diff ?? ''}\n`)
      } else if (result.outcome === 'missing') {
        failed = true
        console.log(`          no golden at ${result.goldenPath}\n`)
      }
    }
  }
  if (failed) console.error('goldens are out of date: run `pnpm provino-harness record`')

  // A golden no fixture and runner produced would never be checked again: a runner dropped from
  // `fixture.json`, a fixture that lost its manifest, a stray file. Only a full check can say so.
  if (command.check) {
    const roots = command.fixtures.length > 0 ? command.fixtures : [defaultFixturesRoot()]
    const stale = await findStaleGoldens(roots, produced)
    for (const file of stale)
      console.log(`${'stale'.padEnd(9)} ${path.relative(process.cwd(), file)}`)
    if (stale.length > 0) {
      console.error('stale goldens: delete them, or restore the fixture and runner they belong to')
      failed = true
    }
  }
  return failed ? 1 : 0
}

async function main(argv: readonly string[]): Promise<number> {
  let command: HarnessCommand
  try {
    command = parseCommandLine(argv)
  } catch (error) {
    if (error instanceof HarnessError && error.code === 'HARNESS_USAGE') {
      console.error(`${error.message}\n\n${USAGE}`)
      return 2
    }
    throw error
  }
  switch (command.command) {
    case 'record':
      return record(command)
    case 'diff':
      return diffCommand(command, processIo)
    case 'convert':
      return convertCommand(command, processIo)
    case 'self-test':
      return selfTestCommand(command, processIo)
    case 'policy-diff':
      return policyDiff(command)
    case 'corpus':
      return corpusCommand(command, processIo)
    default: {
      const unexpected: never = command
      throw new Error(`unhandled command ${JSON.stringify(unexpected)}`)
    }
  }
}

// Each runner is spawned in its own process group, which Ctrl-C no longer reaches; a signal must
// end this process normally so those groups are taken down with it.
exitOnSignals()

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  if (error instanceof HarnessError) console.error(`${error.code}: ${error.message}`)
  else console.error(error)
  process.exitCode = 1
}
