// `provino.timings.json` (T9.6): its shape is Bun's, read strictly, merged and written stably.
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { formatTimings, mergeTimings, parseTimings, readTimings, writeTimings } from './timings.ts'

const dirs: string[] = []
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'provino-timings-'))
  dirs.push(dir)
  return dir
}
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('parseTimings', () => {
  it('reads version 1: files by path, in ms', () => {
    assert.deepEqual(
      parseTimings('{"version":1,"files":{"a.test.ts":12.5,"b/c.test.ts":0}}', 'f'),
      {
        version: 1,
        files: { 'a.test.ts': 12.5, 'b/c.test.ts': 0 },
      },
    )
    assert.deepEqual(parseTimings('{"version":1,"files":{}}', 'f'), { version: 1, files: {} })
  })

  it('ignores keys it does not know, as Bun’s file may carry its own', () => {
    assert.deepEqual(parseTimings('{"version":1,"files":{"a":1},"generatedBy":"x"}', 'f').files, {
      a: 1,
    })
  })

  it('refuses anything else with a coded error that names the file and what is wrong', () => {
    for (const [text, why] of [
      ['not json', /it is not JSON/],
      ['[]', /top level is not an object/],
      ['null', /top level is not an object/],
      ['{"files":{}}', /its version is undefined/],
      ['{"version":2,"files":{}}', /its version is 2/],
      ['{"version":1}', /"files" is not an object/],
      ['{"version":1,"files":[]}', /"files" is not an object/],
      ['{"version":1,"files":{"a":"1"}}', /the time of "a" is not a number/],
      ['{"version":1,"files":{"a":-1}}', /the time of "a" is not a number/],
      ['{"version":1,"files":{"a":null}}', /the time of "a" is not a number/],
    ] as const) {
      assert.throws(
        () => parseTimings(text, 'ci/provino.timings.json'),
        (error: Error & { code?: string }) =>
          error.code === 'ORCH_BAD_TIMINGS' &&
          error.message.startsWith('ci/provino.timings.json is not a Provino timings file') &&
          why.test(error.message),
        text,
      )
    }
  })
})

describe('mergeTimings', () => {
  const existing = {
    version: 1,
    files: { 'a.test.ts': 10, 'b.test.ts': 20, 'gone.test.ts': 30 },
  } as const

  it('puts this run’s files on top and keeps every other entry', () => {
    assert.deepEqual(
      mergeTimings(
        existing,
        new Map([
          ['a.test.ts', 99.6],
          ['c.test.ts', 5],
        ]),
      ),
      {
        version: 1,
        files: { 'a.test.ts': 100, 'b.test.ts': 20, 'gone.test.ts': 30, 'c.test.ts': 5 },
      },
    )
  })

  it('drops the entries of files that are gone when the run saw every file', () => {
    assert.deepEqual(
      mergeTimings(existing, new Map([['a.test.ts', 1]]), new Set(['a.test.ts', 'b.test.ts'])),
      { version: 1, files: { 'a.test.ts': 1, 'b.test.ts': 20 } },
    )
  })

  it('starts a file from nothing', () => {
    assert.deepEqual(mergeTimings(undefined, new Map([['a', 3.2]])), {
      version: 1,
      files: { a: 3 },
    })
  })
})

describe('formatTimings, readTimings and writeTimings', () => {
  it('writes the keys sorted, one file to a line, whole ms, and a final newline', () => {
    assert.equal(
      formatTimings({ version: 1, files: { 'b.test.ts': 2.4, 'a.test.ts': 1.6, 'B.test.ts': 3 } }),
      '{\n  "version": 1,\n  "files": {\n    "B.test.ts": 3,\n    "a.test.ts": 2,\n    "b.test.ts": 2\n  }\n}\n',
    )
    assert.equal(formatTimings({ version: 1, files: {} }), '{\n  "version": 1,\n  "files": {}\n}\n')
  })

  it('round-trips through the disk, creating the directory, and leaves no temporary file', async () => {
    const dir = await scratch()
    const file = join(dir, 'ci', 'provino.timings.json')
    assert.equal(await readTimings(file), undefined, 'a missing file is no timings, not an error')
    await writeTimings(file, { version: 1, files: { 'a.test.ts': 12, 'b.test.ts': 34 } })
    assert.deepEqual(await readTimings(file), {
      version: 1,
      files: { 'a.test.ts': 12, 'b.test.ts': 34 },
    })
    assert.deepEqual(await readdir(join(dir, 'ci')), ['provino.timings.json'])
    // Writing the same data twice gives the same bytes.
    const first = await readFile(file, 'utf8')
    await writeTimings(file, (await readTimings(file)) ?? { version: 1, files: {} })
    assert.equal(await readFile(file, 'utf8'), first)
  })

  it('throws ORCH_BAD_TIMINGS for a file that is there and wrong, naming it', async () => {
    const dir = await scratch()
    const file = join(dir, 'provino.timings.json')
    await writeFile(file, '{"version":3}')
    await assert.rejects(readTimings(file), {
      code: 'ORCH_BAD_TIMINGS',
      message: new RegExp(file.replaceAll('/', '\\/')),
    })
    // A directory where the file should be is a file that can't be read.
    await assert.rejects(readTimings(dir), {
      code: 'ORCH_BAD_TIMINGS',
      message: /could not be read/,
    })
  })
})
