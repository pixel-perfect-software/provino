// What Jest does with the results after the run: the processor's return replaces them, `--json`
// writes them where `--outputFile` says (or to stdout), and Jest says where.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { makeEmptyAggregatedTestResult } from '@provino/dialect-jest/results'
import { processJestResults } from './process-results.ts'

class Sink {
  text = ''
  write(chunk: string): void {
    this.text += chunk
  }
}

async function inTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'provino-process-results-')))
  try {
    await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const globalConfig = {
  json: false,
  outputFile: undefined,
  testResultsProcessor: undefined,
  testFailureExitCode: 1,
}

describe('processJestResults', () => {
  it('does nothing without --json, and says whether the run succeeded', async () => {
    const aggregated = makeEmptyAggregatedTestResult()
    const stdout = new Sink()
    const outputStream = new Sink()
    const success = await processJestResults({
      aggregated,
      globalConfig,
      cwd: '/',
      stdout,
      outputStream,
    })
    assert.equal(success, true)
    assert.equal(stdout.text + outputStream.text, '')
  })

  it('prints the JSON and a newline on stdout without an output file', async () => {
    const aggregated = makeEmptyAggregatedTestResult()
    const stdout = new Sink()
    await processJestResults({
      aggregated,
      globalConfig: { ...globalConfig, json: true },
      cwd: '/',
      stdout,
      outputStream: new Sink(),
    })
    assert.equal(stdout.text.endsWith('\n'), true)
    assert.equal((JSON.parse(stdout.text) as { success: boolean }).success, true)
  })

  it('writes the output file against the working directory and says where, relative to it', async () => {
    await inTempDir(async (dir) => {
      const outputStream = new Sink()
      await processJestResults({
        aggregated: makeEmptyAggregatedTestResult(),
        globalConfig: { ...globalConfig, json: true, outputFile: 'out.json' },
        cwd: dir,
        stdout: new Sink(),
        outputStream,
      })
      assert.equal(outputStream.text, 'Test results written to: out.json\n')
      assert.equal(
        (JSON.parse(await readFile(join(dir, 'out.json'), 'utf8')) as { success: boolean }).success,
        true,
      )
    })
  })

  it('lets a processor replace the results, and judges the run by what it returns', async () => {
    await inTempDir(async (dir) => {
      const processor = join(dir, 'processor.cjs')
      await writeFile(
        processor,
        'module.exports = async (results) => ({ ...results, success: false, added: 1 })\n',
      )
      const stdout = new Sink()
      const success = await processJestResults({
        aggregated: makeEmptyAggregatedTestResult(),
        globalConfig: { ...globalConfig, json: true, testResultsProcessor: processor },
        cwd: dir,
        stdout,
        outputStream: new Sink(),
      })
      assert.equal(success, false)
      assert.equal((JSON.parse(stdout.text) as { added: number }).added, 1)
    })
  })

  it('judges a run successful when the processor returns nothing and --json is off', async () => {
    await inTempDir(async (dir) => {
      const processor = join(dir, 'processor.cjs')
      await writeFile(processor, 'module.exports = () => undefined\n')
      const success = await processJestResults({
        aggregated: makeEmptyAggregatedTestResult(),
        globalConfig: { ...globalConfig, testResultsProcessor: processor },
        cwd: dir,
        stdout: new Sink(),
        outputStream: new Sink(),
      })
      assert.equal(success, true)
    })
  })

  it('throws, as Jest does, when --json meets a processor that returns nothing', async () => {
    await inTempDir(async (dir) => {
      const processor = join(dir, 'processor.cjs')
      await writeFile(processor, 'module.exports = () => undefined\n')
      const stdout = new Sink()
      await assert.rejects(
        processJestResults({
          aggregated: makeEmptyAggregatedTestResult(),
          globalConfig: { ...globalConfig, json: true, testResultsProcessor: processor },
          cwd: dir,
          stdout,
          outputStream: new Sink(),
        }),
        TypeError,
      )
      assert.equal(stdout.text, '')
    })
  })

  it('lets the error of a processor that throws as it loads out as it is, not as a config error', async () => {
    await inTempDir(async (dir) => {
      const processor = join(dir, 'processor.cjs')
      await writeFile(processor, "throw new RangeError('boom at import')\n")
      await assert.rejects(
        processJestResults({
          aggregated: makeEmptyAggregatedTestResult(),
          globalConfig: { ...globalConfig, testResultsProcessor: processor },
          cwd: dir,
          stdout: new Sink(),
          outputStream: new Sink(),
        }),
        (error) => error instanceof RangeError && error.message === 'boom at import',
      )
    })
  })
})
