#!/usr/bin/env node
// The Provino side of `bench:loader e2e`: one process that loads the loader, runs the first
// `count` fixture files, and exits. Usage: entry.ts <fixture dir> <count> <tier>
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createFixtureLoader, type LoaderTier, runFixture } from './run.ts'

const [dir = '', countText = '0', tierText = 'registry'] = process.argv.slice(2)
const tier: LoaderTier = tierText === 'none' ? 'none' : 'registry'
const files = readdirSync(join(dir, 'tests'))
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .slice(0, Number(countText))
  .map((name) => join(dir, 'tests', name))
const result = await runFixture(createFixtureLoader(dir), files, tier)
process.exitCode = result.failed === 0 ? 0 : 1
if (result.failed > 0) process.stderr.write(`${result.failures.join('\n')}\n`)
