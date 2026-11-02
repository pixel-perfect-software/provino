#!/usr/bin/env node
import { HarnessError } from './errors.ts'
import { findFixtures, readFixture } from './fixture.ts'
import { parseCommandLine, USAGE } from './internal/cli-args.ts'
import { recordFixture } from './record.ts'

// provino-harness record [--check] [--keep] [<fixture dir>...]
async function main(argv: readonly string[]): Promise<number> {
  let command: ReturnType<typeof parseCommandLine>
  try {
    command = parseCommandLine(argv)
  } catch (error) {
    if (error instanceof HarnessError && error.code === 'HARNESS_USAGE') {
      console.error(`${error.message}\n\n${USAGE}`)
      return 2
    }
    throw error
  }

  const dirs = command.fixtures.length > 0 ? command.fixtures : await findFixtures()
  if (dirs.length === 0) {
    console.error('no fixtures found')
    return 1
  }

  let failed = false
  for (const dir of dirs) {
    const fixture = await readFixture(dir)
    for (const runner of fixture.manifest.runners) {
      const result = await recordFixture(dir, runner, {
        check: command.check,
        keepWorkDir: command.keepWorkDir,
      })
      console.log(`${result.outcome.padEnd(9)} ${result.fixture} (${runner})`)
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
  return failed ? 1 : 0
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  if (error instanceof HarnessError) console.error(`${error.code}: ${error.message}`)
  else console.error(error)
  process.exitCode = 1
}
