import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { toGolden } from '../golden.ts'
import { parseCommandLine } from '../internal/cli-args.ts'
import { parseNormalizedRun } from '../parse-normalized-run.ts'
import { makeFile, makeRun, makeTest } from '../test-support.ts'
import { convertCommand } from './convert.ts'

const RECORDED = path.resolve(import.meta.dirname, '..', '..', 'sample', '__recorded__')

let dir = ''
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'provino-harness-convert-'))
})
after(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function convert(...args: string[]): Promise<{ code: number; stderr: string }> {
  const command = parseCommandLine(['convert', ...args])
  if (command.command !== 'convert') throw new Error('not a convert command')
  let stderr = ''
  const code = await convertCommand(command, {
    out: () => undefined,
    err: (text) => {
      stderr += text
    },
  })
  return { code, stderr }
}

for (const runner of ['jest', 'vitest'] as const) {
  test(`converts the recorded ${runner} JSON and sidecar to the committed run`, async () => {
    const out = path.join(dir, `${runner}.json`)
    const committed = parseNormalizedRun(
      await readFile(path.join(RECORDED, `${runner}.normalized.json`), 'utf8'),
      'committed',
    )
    const { code } = await convert(
      ...['--runner', runner, '--input', path.join(RECORDED, `${runner}.raw.json`)],
      ...['--sidecar', path.join(RECORDED, `${runner}.console.jsonl`), '--root', '/__root__'],
      ...['--suite', committed.suite, '--out', out, '--runner-version', committed.runnerVersion],
    )
    assert.equal(code, 0)
    const written = parseNormalizedRun(await readFile(out, 'utf8'), out)
    // convert hashes no snapshot files (runSubject does, after its run), so they are left out.
    const golden = (run: typeof written): string => {
      const { snapshots: _, ...rest } = toGolden(run)
      return JSON.stringify(rest, null, 2)
    }
    assert.equal(golden(written), golden(committed))
  })
}

test('converts a Provino run, with the suite it is given', async () => {
  const input = path.join(dir, 'provino.raw.json')
  await writeFile(
    input,
    JSON.stringify(
      makeRun([makeFile('a.test.ts', [makeTest('a.test.ts', ['t'])])], { runner: 'provino:jest' }),
    ),
  )
  const out = path.join(dir, 'provino.json')
  const { code } = await convert(
    ...['--runner', 'provino', '--input', input, '--root', dir, '--suite', 'mine', '--out', out],
  )
  assert.equal(code, 0)
  const run = parseNormalizedRun(await readFile(out, 'utf8'), out)
  assert.equal(run.suite, 'mine')
  assert.equal(run.runner, 'provino:jest')
})

test('an unreadable input, a bad file or an unknown runner version exits 2', async () => {
  const args = ['--root', dir, '--suite', 's', '--out', path.join(dir, 'x.json')]
  const missing = await convert('--runner', 'jest', '--input', path.join(dir, 'nope'), ...args)
  assert.equal(missing.code, 2)
  assert.match(missing.stderr, /can't read the input/)
  const bad = path.join(dir, 'bad.json')
  await writeFile(bad, '{"testResults":3}')
  const invalid = await convert(
    '--runner',
    'vitest',
    '--input',
    bad,
    ...args,
    '--runner-version',
    '5',
  )
  assert.equal(invalid.code, 2)
  assert.match(invalid.stderr, /HARNESS_RESULT_INVALID/)
  const unversioned = await convert('--runner', 'jest', '--input', bad, ...args)
  assert.equal(unversioned.code, 2)
  assert.match(unversioned.stderr, /pass --runner-version/)
})
