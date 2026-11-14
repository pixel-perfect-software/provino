// D116 on the corpora: every file the in-place strip takes is the program Oxc's TypeScript
// transform makes, with every kept character at its offset; with imports elided and under
// `verbatimModuleSyntax`. The fuzz corpus always runs (10,000 files, seed 1, as `bench:runner-fuzz`);
// excalidraw runs when `.refs/excalidraw` is there (CI downloads it), and the test says when not.
// `pnpm bench:blank check` prints the same counts.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { describe, test } from 'node:test'
import {
  blankPipelines,
  type CorpusFile,
  checkBlankCorpus,
  generateAsiCorpus,
} from './blank-corpus.ts'
import { DEFAULT_ROOT, readSources } from './corpus.ts'
import { generateFuzzCorpus } from './fuzz-corpus.ts'

function check(files: readonly CorpusFile[], verbatimModuleSyntax: boolean) {
  // Node 22.15 (CI's floor) parses no `using`.
  const pipelines = blankPipelines({ verbatimModuleSyntax })
  try {
    return checkBlankCorpus(files, pipelines)
  } finally {
    pipelines[Symbol.dispose]()
  }
}

describe('the in-place strip makes the program Oxc makes, file by file', () => {
  const fuzz = generateFuzzCorpus(10_000, 1)
  for (const verbatimModuleSyntax of [false, true]) {
    test(`the fuzz corpus (verbatimModuleSyntax: ${verbatimModuleSyntax})`, () => {
      const report = check(fuzz, verbatimModuleSyntax)
      assert.deepEqual(report.different, [])
      assert.deepEqual(report.moved, [])
      // The generator's own mix (enums, namespaces and parameter properties fall back).
      assert.equal(report.valid, 8770)
      assert.equal(report.blanked, 4262)
    })
  }

  const asi = generateAsiCorpus()
  for (const verbatimModuleSyntax of [false, true]) {
    test(`the statement-tail ASI corpus (verbatimModuleSyntax: ${verbatimModuleSyntax})`, () => {
      const report = check(asi, verbatimModuleSyntax)
      assert.deepEqual(report.different, [])
      assert.deepEqual(report.moved, [])
      assert.equal(report.requested, 2520)
      assert.equal(report.valid, 2448)
      assert.equal(report.blanked, 2448)
    })
  }

  const real = existsSync(DEFAULT_ROOT)
  for (const verbatimModuleSyntax of [false, true]) {
    test(`excalidraw (verbatimModuleSyntax: ${verbatimModuleSyntax})`, {
      skip: real ? false : `${DEFAULT_ROOT} is not there`,
    }, () => {
      const report = check(readSources(DEFAULT_ROOT), verbatimModuleSyntax)
      assert.deepEqual(report.different, [])
      assert.deepEqual(report.moved, [])
      assert.equal(report.valid, 352)
      assert.equal(report.blanked, 319)
    })
  }
})
