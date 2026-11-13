import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { describe, it } from 'node:test'
import { main, parseRunArgs } from './cli.ts'
import { USAGE } from './usage.ts'
import { UsageError } from './usage-error.ts'
import { packageVersion } from './version.ts'

function usageError(args: readonly string[], message: RegExp): void {
  assert.throws(
    () => parseRunArgs(args),
    (error) =>
      error instanceof UsageError && error.code === 'PROVINO_USAGE' && message.test(error.message),
  )
}

describe('parseRunArgs', () => {
  it('takes only --config: every other option is left to the defaults', () => {
    assert.deepEqual(parseRunArgs(['--config', 'p.config.mjs']), {
      type: 'run',
      options: { config: 'p.config.mjs' },
    })
    assert.deepEqual(parseRunArgs(['-c', 'p.config.mjs']), {
      type: 'run',
      options: { config: 'p.config.mjs' },
    })
  })

  it('maps every flag to its option', () => {
    assert.deepEqual(
      parseRunArgs([
        '--config=c.mjs',
        '--maxWorkers',
        '4',
        '--pool',
        'inline',
        '--reporter',
        'default',
        '--reporter',
        'normalized-json',
        '--outputFile',
        'out.json',
        '-t',
        'adds up',
        '--ci',
        '--passWithNoTests',
        '--no-cache',
      ]),
      {
        type: 'run',
        options: {
          config: 'c.mjs',
          maxWorkers: 4,
          pool: 'inline',
          reporters: ['default', ['normalized-json', { outputFile: 'out.json' }]],
          ci: true,
          passWithNoTests: true,
          testNamePattern: 'adds up',
          cache: false,
        },
      },
    )
  })

  it('gives normalized-json by name without an outputFile', () => {
    assert.deepEqual(parseRunArgs(['--config', 'c.mjs', '--reporter', 'normalized-json']), {
      type: 'run',
      options: { config: 'c.mjs', reporters: ['normalized-json'] },
    })
  })

  it('names each built-in reporter, and gives --outputFile to the one document reporter', () => {
    for (const name of ['default', 'verbose', 'dot', 'agent', 'github-actions', 'json', 'junit']) {
      assert.deepEqual(parseRunArgs(['--config', 'c.mjs', '--reporter', name]), {
        type: 'run',
        options: { config: 'c.mjs', reporters: [name] },
      })
    }
    assert.deepEqual(
      parseRunArgs([
        '--config',
        'c.mjs',
        '--reporter',
        'dot',
        '--reporter',
        'junit',
        '--outputFile',
        'r/junit.xml',
      ]),
      {
        type: 'run',
        options: { config: 'c.mjs', reporters: ['dot', ['junit', { outputFile: 'r/junit.xml' }]] },
      },
    )
    assert.deepEqual(
      parseRunArgs(['--config', 'c.mjs', '--reporter', 'json', '--outputFile', 'r.json']),
      {
        type: 'run',
        options: { config: 'c.mjs', reporters: [['json', { outputFile: 'r.json' }]] },
      },
    )
  })

  it('reads -t=<pattern> and -c=<file> as the long options, without the =', () => {
    assert.deepEqual(parseRunArgs(['-c=c.mjs', '-t=adds up']), {
      type: 'run',
      options: { config: 'c.mjs', testNamePattern: 'adds up' },
    })
    // A value that itself holds an =, and the other spellings that already worked.
    assert.deepEqual(parseRunArgs(['-c', 'c.mjs', '-t=a=b']), {
      type: 'run',
      options: { config: 'c.mjs', testNamePattern: 'a=b' },
    })
    assert.deepEqual(parseRunArgs(['-c', 'c.mjs', '-ta']), {
      type: 'run',
      options: { config: 'c.mjs', testNamePattern: 'a' },
    })
    assert.deepEqual(parseRunArgs(['-c', 'c.mjs', '-t', 'a']), {
      type: 'run',
      options: { config: 'c.mjs', testNamePattern: 'a' },
    })
  })

  it('reads --bail with or without a count: --bail, --bail=3 and --bail 3 (T9.10)', () => {
    const bail = (...args: string[]) =>
      (parseRunArgs(['--config', 'c.mjs', ...args]) as { options: { bail?: number } }).options.bail
    assert.equal(bail('--bail'), 1)
    assert.equal(bail('--bail=3'), 3)
    assert.equal(bail('--bail', '3'), 3)
    assert.equal(bail('--bail=0'), 0, 'zero is off, as in Jest')
    assert.equal(bail(), undefined)
    // A flag after a bare --bail is a flag, not its count.
    assert.deepEqual(parseRunArgs(['--config', 'c.mjs', '--bail', '--ci']), {
      type: 'run',
      options: { config: 'c.mjs', bail: 1, ci: true },
    })
    usageError(['--config', 'c.mjs', '--bail=x'], /--bail must be a whole number/)
    usageError(['--config', 'c.mjs', '--bail=-1'], /--bail must be a whole number/)
    usageError(['--config', 'c.mjs', '--bail=1.5'], /--bail must be a whole number/)
  })

  it('reads --forceExit and --detectOpenHandles (T9.10)', () => {
    assert.deepEqual(parseRunArgs(['--config', 'c.mjs', '--forceExit', '--detectOpenHandles']), {
      type: 'run',
      options: { config: 'c.mjs', detectOpenHandles: true },
      forceExit: true,
    })
  })

  it('reads the recycling and deadline flags (T9.5)', () => {
    assert.deepEqual(
      parseRunArgs([
        '--config',
        'c.mjs',
        '--workerMemoryLimit',
        '512MB',
        '--maxFilesPerWorker',
        '3',
        '--fileTimeout',
        '5000',
      ]),
      {
        type: 'run',
        options: {
          config: 'c.mjs',
          workerMemoryLimit: 512_000_000,
          maxFilesPerWorker: 3,
          fileTimeoutMs: 5000,
        },
      },
    )
    const limit = (text: string) =>
      (
        parseRunArgs(['--config', 'c.mjs', '--workerMemoryLimit', text]) as {
          options: { workerMemoryLimit?: number }
        }
      ).options.workerMemoryLimit
    assert.equal(limit('0'), 0, 'every file')
    assert.equal(limit('1024'), 1024)
    assert.equal(limit('1.5gb'), 1_500_000_000)
    assert.equal(limit('2 KB'), 2000)
    assert.equal(limit('512MiB'), 512 * 1024 * 1024)
    usageError(['--config', 'c.mjs', '--workerMemoryLimit', 'lots'], /--workerMemoryLimit must be/)
    usageError(['--config', 'c.mjs', '--workerMemoryLimit=-5'], /--workerMemoryLimit must be/)
    usageError(['--config', 'c.mjs', '--maxFilesPerWorker', '0'], /--maxFilesPerWorker must be/)
    usageError(['--config', 'c.mjs', '--fileTimeout', '0'], /--fileTimeout must be/)
    usageError(['--config', 'c.mjs', '--fileTimeout', '1s'], /--fileTimeout must be/)
  })

  it('refuses a repeated --reporter', () => {
    usageError(
      ['--config', 'c.mjs', '--reporter', 'normalized-json', '--reporter', 'normalized-json'],
      /--reporter normalized-json is given more than once/,
    )
    usageError(
      ['--config', 'c.mjs', '--reporter', 'default', '--reporter', 'default'],
      /--reporter default is given more than once/,
    )
    assert.equal(
      parseRunArgs(['--config', 'c.mjs', '--reporter', 'default', '--reporter', 'normalized-json'])
        .type,
      'run',
    )
  })

  it('is help for --help, even without --config', () => {
    assert.deepEqual(parseRunArgs(['--help']), { type: 'help' })
    assert.deepEqual(parseRunArgs(['-h']), { type: 'help' })
  })

  it('refuses what it does not understand', () => {
    usageError([], /--config <file> is required/)
    usageError(['--config'], /--config/)
    usageError(['--config', 'c.mjs', '--nope'], /--nope/)
    usageError(['--config', 'c.mjs', 'file.test.js'], /file\.test\.js/)
    usageError(['--config', 'c.mjs', '--pool', 'cluster'], /--pool/)
    usageError(['--config', 'c.mjs', '--reporter', 'tap'], /unknown reporter "tap"/)
    // A misspelt name is named as such, not reported as a missing document reporter.
    usageError(
      ['--config', 'c.mjs', '--reporter', 'junitt', '--outputFile', 'o.xml'],
      /unknown reporter "junitt"/,
    )
    usageError(
      ['--config', 'c.mjs', '--outputFile', 'o.json'],
      /needs --reporter json, normalized-json or junit/,
    )
    usageError(
      ['--config', 'c.mjs', '--reporter', 'default', '--outputFile', 'o.json'],
      /needs --reporter json, normalized-json or junit/,
    )
    usageError(
      ['--config', 'c.mjs', '--reporter', 'json', '--reporter', 'junit', '--outputFile', 'o.json'],
      /--outputFile is one path, and json and junit each write a document/,
    )
    for (const bad of ['0', '-1', '1.5', 'abc', '', '1e3', '99999999999999999999']) {
      usageError(['--config', 'c.mjs', '--maxWorkers', bad], /--maxWorkers/)
    }
  })
})

/** A writable that keeps what it is given. */
class Sink extends Writable {
  text = ''
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    this.text += chunk.toString()
    done()
  }
}

describe('main', () => {
  it('prints the usage text for --help, to stdout, and passes', async () => {
    const stdout = new Sink()
    const stderr = new Sink()
    assert.equal(await main(['--help'], { stdout, stderr }), 0)
    assert.equal(stdout.text, USAGE)
    assert.equal(stderr.text, '')
  })

  it('prints the package version for --version, to stdout, and passes', async () => {
    const stdout = new Sink()
    const stderr = new Sink()
    assert.equal(await main(['--version'], { stdout, stderr }), 0)
    assert.equal(stdout.text, `${packageVersion()}\n`)
    assert.match(stdout.text, /^\d+\.\d+\.\d+\S*\n$/)
    assert.equal(stderr.text, '')
    assert.match(USAGE, /--version/)
  })

  it('is exit code 2 with the message and the usage text on stderr for bad usage', async () => {
    // `jest` is a command now; `vitest` is a command that is refused, and a bare `provino` in a
    // directory with nothing to run is too.
    for (const argv of [['walk'], ['vitest'], ['run'], ['run', '--config', 'c.mjs', '--bad']]) {
      const stdout = new Sink()
      const stderr = new Sink()
      assert.equal(await main(argv, { stdout, stderr }), 2, argv.join(' '))
      assert.equal(stdout.text, '')
      assert.ok(stderr.text.startsWith('Provino: '), stderr.text)
      assert.ok(stderr.text.endsWith(USAGE), 'the usage text follows the message')
    }
  })

  it('says in the usage text that --pool inline keeps a leaked handle alive', () => {
    assert.match(USAGE, /inline\s+runs in this process, so a leaked handle keeps it alive/)
  })

  it('is exit code 2 for a config file that is not there, without the usage text', async () => {
    const stderr = new Sink()
    assert.equal(
      await main(['run', '--config', '/nonexistent/provino.config.mjs'], {
        stdout: new Sink(),
        stderr,
      }),
      2,
    )
    assert.match(stderr.text, /can't load the config file/)
    assert.doesNotMatch(stderr.text, /Usage:/)
  })
})
