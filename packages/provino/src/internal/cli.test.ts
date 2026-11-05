import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { describe, it } from 'node:test'
import { main, parseRunArgs, USAGE } from './cli.ts'
import { UsageError } from './usage-error.ts'

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
    usageError(['--config', 'c.mjs', '--outputFile', 'o.json'], /needs --reporter normalized-json/)
    usageError(
      ['--config', 'c.mjs', '--reporter', 'default', '--outputFile', 'o.json'],
      /needs --reporter normalized-json/,
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

  it('is exit code 2 with the message and the usage text on stderr for bad usage', async () => {
    for (const argv of [[], ['jest'], ['run'], ['run', '--config', 'c.mjs', '--bad']]) {
      const stdout = new Sink()
      const stderr = new Sink()
      assert.equal(await main(argv, { stdout, stderr }), 2, argv.join(' '))
      assert.equal(stdout.text, '')
      assert.ok(stderr.text.startsWith('Provino: '), stderr.text)
      assert.ok(stderr.text.endsWith(USAGE), 'the usage text follows the message')
    }
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
