// `--shard=i/n`, the timings file and `--update-timings` (T9.6), end to end. `provino jest --shard`
// runs the files Jest 30.5.2 runs for each shard (the recordings `cli/shard-1-of-3` to `3-of-3`);
// `run()` and `provino run` cut by the timings file when there is one.
import assert from 'node:assert/strict'
import { hash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { type RunOptions, type RunResult, run } from 'provino/node'
import { loadFixture, materialize } from './recorded.ts'
import {
  Collect,
  jestConfigJson,
  passing,
  QUIET_ENV,
  spawnCli,
  trackedProjects,
  withoutNodeNoise,
} from './support.ts'

const makeProject = trackedProjects()

/** The files a run's PASS lines name, sorted, as the recording keeps them (`./` before a root file). */
function passed(stderr: string): string[] {
  return stderr
    .split('\n')
    .filter((line) => line.startsWith('PASS '))
    .toSorted()
}

describe('provino jest --shard against Jest 30.5.2 (the sha1 split)', () => {
  for (const index of [1, 2, 3]) {
    const id = `cli/shard-${index}-of-3`
    it(`${id}: runs the files Jest runs, and says what Jest says`, async () => {
      const fixture = await loadFixture(id)
      const project = await materialize(fixture)
      try {
        const ended = await spawnCli(
          ['jest', `--config=${join(project.root, 'jest.config.json')}`, `--shard=${index}/3`],
          { cwd: project.root },
        )
        const recorded = (fixture.golden.observed?.stderr ?? '').split('\n')
        assert.equal(ended.code, fixture.golden.observed?.exitCode, ended.stderr)
        assert.deepEqual(
          passed(withoutNodeNoise(ended.stderr)),
          recorded.filter((line) => line.startsWith('PASS ')),
        )
        assert.equal(
          withoutNodeNoise(ended.stderr)
            .split('\n')
            .find((line) => line.startsWith('Test Suites:')),
          recorded.find((line) => line.startsWith('Test Suites:')),
        )
      } finally {
        await project.dispose()
      }
    })
  }

  it('--listTests --shard lists the shard’s files: the three shards are the whole list, once each', async () => {
    const fixture = await loadFixture('cli/shard-1-of-3')
    const project = await materialize(fixture)
    try {
      const config = `--config=${join(project.root, 'jest.config.json')}`
      const listed: string[] = []
      for (const index of [1, 2, 3]) {
        const ended = await spawnCli(
          ['jest', config, '--listTests', '--json', `--shard=${index}/3`],
          {
            cwd: project.root,
          },
        )
        assert.equal(ended.code, 0, ended.stderr)
        const files = JSON.parse(ended.stdout) as string[]
        assert.deepEqual(files.length, [3, 3, 2][index - 1], `shard ${index}`)
        listed.push(...files.map((file) => file.replace(`${project.root}/`, '')))
      }
      assert.deepEqual(listed.toSorted(), [
        'alpha.test.ts',
        'bravo.test.ts',
        'charlie.test.ts',
        'delta.test.ts',
        'echo.test.ts',
        'foxtrot.test.ts',
        'golf.test.ts',
        'sub/hotel.test.ts',
      ])
      // The first shard is the recorded one.
      const first = await spawnCli(['jest', config, '--listTests', '--json', '--shard=1/3'], {
        cwd: project.root,
      })
      assert.deepEqual(
        (JSON.parse(first.stdout) as string[])
          .map((file) => file.replace(`${project.root}/`, ''))
          .toSorted(),
        ['alpha.test.ts', 'foxtrot.test.ts', 'golf.test.ts'],
      )
    } finally {
      await project.dispose()
    }
  })

  it('refuses a shard Jest refuses, with Jest’s text and its exit code', async () => {
    const fixture = await loadFixture('cli/shard-1-of-3')
    const project = await materialize(fixture)
    try {
      const config = `--config=${join(project.root, 'jest.config.json')}`
      for (const [flag, text] of [
        ['--shard=4/3', 'The shard option <n> must be less or equal than <m>.'],
        ['--shard=0/3', 'The shard option <n> requires a positive integer.'],
        ['--shard=1/0', 'The shard option <m> requires a positive integer.'],
        ['--shard=x', 'The shard option requires a string in the format of <n>/<m>.'],
      ] as const) {
        const ended = await spawnCli(['jest', config, flag], { cwd: project.root })
        assert.equal(ended.code, 1, `${flag}: ${ended.stderr}`)
        assert.ok(ended.stderr.includes(text), `${flag}: ${ended.stderr}`)
        assert.doesNotMatch(ended.stderr, /PASS/)
      }
    } finally {
      await project.dispose()
    }
  })
})

interface Ran extends RunResult {
  readonly stderr: string
}

async function runWith(config: string, options: Partial<RunOptions> = {}): Promise<Ran> {
  const stderr = new Collect()
  const result = await run({ config, stdout: new Collect(), stderr, env: QUIET_ENV, ...options })
  return { ...result, stderr: stderr.text }
}

const FILES = {
  'tests/a.test.js': passing('a'),
  'tests/b.test.js': passing('b'),
  'tests/c.test.js': passing('c'),
  'tests/d.test.js': passing('d'),
  'tests/e.test.js': passing('e'),
  'tests/f.test.js': passing('f'),
}

function ranFiles(result: Ran): string[] {
  return (result.summary?.files ?? []).map((file) => file.file.path).toSorted()
}

describe('run() with a shard and a timings file', () => {
  it('without a timings file, the Jest dialect shards as Jest does: the slices of the sha1 order', async () => {
    const project = await makeProject(FILES)
    // Jest hashes the path relative to the project root.
    const bySha1 = Object.keys(FILES).toSorted((a, b) => {
      const [ha, hb] = [hash('sha1', a), hash('sha1', b)]
      return ha < hb ? -1 : 1
    })
    const shards: string[][] = []
    for (const index of [1, 2, 3]) {
      const ran = await runWith(project.config, { shard: { index, count: 3 }, cache: false })
      assert.equal(ran.exitCode, 0, ran.stderr)
      shards.push(ranFiles(ran))
    }
    assert.deepEqual(
      shards.map((files) => files.toSorted()),
      [bySha1.slice(0, 2), bySha1.slice(2, 4), bySha1.slice(4, 6)].map((files) => files.toSorted()),
    )
  })

  it('cuts by predicted time when provino.timings.json is there', async () => {
    const project = await makeProject(FILES)
    // a is as slow as the other five together: two shards, a alone against the rest.
    await writeFile(
      project.path('provino.timings.json'),
      JSON.stringify({
        version: 1,
        files: {
          'tests/a.test.js': 5000,
          'tests/b.test.js': 1000,
          'tests/c.test.js': 1000,
          'tests/d.test.js': 1000,
          'tests/e.test.js': 1000,
          'tests/f.test.js': 1000,
        },
      }),
    )
    const first = await runWith(project.config, { shard: { index: 1, count: 2 }, cache: false })
    const second = await runWith(project.config, { shard: { index: 2, count: 2 }, cache: false })
    assert.deepEqual(ranFiles(first), ['tests/a.test.js'])
    assert.deepEqual(ranFiles(second), [
      'tests/b.test.js',
      'tests/c.test.js',
      'tests/d.test.js',
      'tests/e.test.js',
      'tests/f.test.js',
    ])
  })

  it('reads the file named by timingsFile', async () => {
    const project = await makeProject(FILES)
    await writeFile(
      project.path('elsewhere.json'),
      JSON.stringify({
        version: 1,
        files: {
          'tests/a.test.js': 9000,
          'tests/b.test.js': 1000,
          'tests/c.test.js': 1000,
          'tests/d.test.js': 1000,
          'tests/e.test.js': 1000,
          'tests/f.test.js': 1000,
        },
      }),
    )
    const ran = await runWith(project.config, {
      shard: { index: 1, count: 2 },
      timingsFile: project.path('elsewhere.json'),
      cache: false,
    })
    assert.deepEqual(ranFiles(ran), ['tests/a.test.js'])
  })

  it('stops with a usage error for a timings file that is not one, and for a bad shard', async () => {
    const project = await makeProject(FILES)
    await writeFile(project.path('provino.timings.json'), '{"version":2,"files":{}}')
    const bad = await runWith(project.config, { shard: { index: 1, count: 2 } })
    assert.equal(bad.exitCode, 2)
    assert.equal(bad.summary, null)
    assert.match(
      bad.stderr,
      /provino\.timings\.json is not a Provino timings file: its version is 2/,
    )
    const badShard = await runWith(project.config, { shard: { index: 3, count: 2 } })
    assert.equal(badShard.exitCode, 2)
    assert.match(badShard.stderr, /shard\.index .* from 1 to 2 \(got 3\)/)
  })

  it('--update-timings writes what ran, merges into what was there, and keeps the other shards’ entries', async () => {
    const project = await makeProject(FILES)
    const file = project.path('provino.timings.json')
    await writeFile(
      file,
      JSON.stringify({ version: 1, files: { 'tests/f.test.js': 7, 'tests/gone.test.js': 9 } }),
    )
    // A shard: only its files are measured; every other entry stays, a removed file's included.
    const shard = await runWith(project.config, {
      shard: { index: 1, count: 3 },
      updateTimings: true,
      cache: false,
    })
    assert.equal(shard.exitCode, 0, shard.stderr)
    const afterShard = JSON.parse(await readFile(file, 'utf8')) as {
      version: number
      files: Record<string, number>
    }
    assert.equal(afterShard.version, 1)
    assert.deepEqual(Object.keys(afterShard.files).toSorted(), [
      'tests/a.test.js',
      'tests/b.test.js',
      'tests/f.test.js',
      'tests/gone.test.js',
    ])
    assert.equal(afterShard.files['tests/f.test.js'], 7)
    assert.ok(Number.isInteger(afterShard.files['tests/a.test.js']))
    // A whole run measures every file, and drops the entry of a file that is gone.
    const whole = await runWith(project.config, { updateTimings: true, cache: false })
    assert.equal(whole.exitCode, 0, whole.stderr)
    const afterWhole = JSON.parse(await readFile(file, 'utf8')) as { files: Record<string, number> }
    assert.deepEqual(Object.keys(afterWhole.files), [
      'tests/a.test.js',
      'tests/b.test.js',
      'tests/c.test.js',
      'tests/d.test.js',
      'tests/e.test.js',
      'tests/f.test.js',
    ])
    // The text is stable: sorted keys, whole milliseconds, a final newline.
    const text = await readFile(file, 'utf8')
    assert.match(text, /^\{\n {2}"version": 1,\n {2}"files": \{\n {4}"tests\/a\.test\.js": \d+,\n/)
    assert.ok(text.endsWith('}\n'))
  })

  it('--update-timings with -t writes nothing: a run of some of each file’s tests times no file', async () => {
    const project = await makeProject(FILES)
    const file = project.path('provino.timings.json')
    await writeFile(file, JSON.stringify({ version: 1, files: { 'tests/a.test.js': 4000 } }))
    const before = await readFile(file, 'utf8')
    const partial = await runWith(project.config, {
      testNamePattern: 'a',
      updateTimings: true,
      cache: false,
    })
    assert.equal(partial.exitCode, 0, partial.stderr)
    assert.match(partial.stderr, /Provino: not updating the timings file: -t runs only some/)
    assert.equal(await readFile(file, 'utf8'), before)
    // The same run without -t does write.
    const whole = await runWith(project.config, { updateTimings: true, cache: false })
    assert.equal(whole.exitCode, 0, whole.stderr)
    assert.doesNotMatch(whole.stderr, /not updating the timings file/)
    assert.notEqual(await readFile(file, 'utf8'), before)
  })

  it('--update-timings replaces a timings file that is not one, and says so', async () => {
    const project = await makeProject(FILES)
    await writeFile(project.path('provino.timings.json'), 'not json')
    const ran = await runWith(project.config, { updateTimings: true, cache: false })
    assert.equal(ran.exitCode, 0, ran.stderr)
    assert.match(ran.stderr, /Provino: replacing the timings file: .*not a Provino timings file/)
    const written = JSON.parse(await readFile(project.path('provino.timings.json'), 'utf8')) as {
      files: Record<string, number>
    }
    assert.equal(Object.keys(written.files).length, 6)
  })
})

describe('provino run --shard and --update-timings (the bin)', () => {
  it('takes the flags, and refuses a malformed shard with exit 2', async () => {
    const project = await makeProject(FILES)
    const first = await spawnCli(['run', '--config', project.config, '--shard=1/3', '--no-cache'])
    assert.equal(first.code, 0, first.stderr)
    assert.equal(passed(withoutNodeNoise(first.stderr)).length, 2)
    for (const bad of ['--shard=0/3', '--shard=4/3', '--shard=2', '--shard=a/b', '--shard=1/0']) {
      const ended = await spawnCli(['run', '--config', project.config, bad])
      assert.equal(ended.code, 2, `${bad}: ${ended.stderr}`)
      assert.match(ended.stderr, /--shard must be <index>\/<count>/)
    }
  })

  it('--update-timings writes the file --timings names', async () => {
    const project = await makeProject(FILES)
    const target = project.path('out/timings.json')
    const ended = await spawnCli([
      'run',
      '--config',
      project.config,
      '--update-timings',
      '--timings',
      target,
      '--no-cache',
    ])
    assert.equal(ended.code, 0, ended.stderr)
    const written = JSON.parse(await readFile(target, 'utf8')) as { files: Record<string, number> }
    assert.equal(Object.keys(written.files).length, 6)
  })
})

describe('provino jest takes --timings and --update-timings out of the command line, and only those', () => {
  it('refuses a --timings with no path: nothing, another flag or an empty value', async () => {
    const project = await makeProject(FILES)
    const config = jestConfigJson(project.dir)
    for (const args of [['--timings'], ['--timings', '--ci'], ['--timings=']]) {
      const ended = await spawnCli(['jest', '--config', config, ...args], { cwd: project.dir })
      assert.equal(ended.code, 1, `${args.join(' ')}: ${ended.stderr}`)
      assert.match(ended.stderr, /--timings needs the path of a timings file/)
      assert.doesNotMatch(ended.stderr, /PASS/)
    }
  })

  it('leaves what follows -- alone: a path pattern named like the flag is a pattern', async () => {
    const project = await makeProject(FILES)
    const ended = await spawnCli(
      ['jest', '--config', jestConfigJson(project.dir), '--', '--update-timings'],
      { cwd: project.dir },
    )
    // No file matches the pattern `--update-timings`, so Jest has nothing to run (exit 1) and the
    // timings file is not written.
    assert.equal(ended.code, 1, ended.stderr)
    assert.doesNotMatch(ended.stderr, /PASS/)
    await assert.rejects(readFile(project.path('provino.timings.json'), 'utf8'), { code: 'ENOENT' })
  })
})
