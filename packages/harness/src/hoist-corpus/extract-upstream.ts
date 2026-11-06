#!/usr/bin/env node
// `pnpm hoist:extract`: reads the two upstream hoist test files from `.refs/` (pinned, DECISIONS
// S3) and writes their inputs to `vendor/jest.json` and `vendor/vitest.json`. Local only, because
// `.refs/` isn't on CI; the JSON is committed and `hoist-corpus.test.ts` reads only it. Running it
// twice writes identical bytes.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { extractJestCases, extractVitestCases } from './extract.ts'

const JEST_SOURCE =
  '.refs/jest/packages/babel-plugin-jest-hoist/src/__tests__/hoistPlugin.nodejs18.test.ts'
const VITEST_SOURCE = '.refs/vitest/test/unit/test/injector-mock.test.ts'

const repoRoot = new URL('../../../../', import.meta.url)
const vendor = new URL('vendor/', import.meta.url)

// JSON can't carry the upstream's license header, so each file names it (see `UPSTREAM.md`).
const JEST_LICENSE = 'MIT, Copyright (c) Meta Platforms, Inc. and affiliates (Jest)'
const VITEST_LICENSE = 'MIT, Copyright (c) 2021-Present VoidZero Inc. and Vitest contributors'

function write(name: string, license: string, source: string, cases: readonly unknown[]): void {
  const text = `${JSON.stringify({ license, source, cases }, null, 2)}\n`
  writeFileSync(fileURLToPath(new URL(name, vendor)), text)
  process.stdout.write(`hoist:extract: ${name}: ${cases.length} cases from ${source}\n`)
}

const jest = extractJestCases(readFileSync(fileURLToPath(new URL(JEST_SOURCE, repoRoot)), 'utf8'))
const vitest = extractVitestCases(
  readFileSync(fileURLToPath(new URL(VITEST_SOURCE, repoRoot)), 'utf8'),
)
write('jest.json', JEST_LICENSE, JEST_SOURCE, jest)
write('vitest.json', VITEST_LICENSE, VITEST_SOURCE, vitest)
