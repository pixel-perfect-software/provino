import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { describe, it } from 'node:test'
import { main } from './cli.ts'
import { quickAnswer } from './quick.ts'
import { USAGE } from './usage.ts'
import { packageVersion } from './version.ts'

class Sink extends Writable {
  text = ''
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    this.text += chunk.toString()
    done()
  }
}

describe('quickAnswer: the one answer to --version, --help and -h', () => {
  it('is the version, then a newline, for --version', () => {
    assert.equal(quickAnswer(['--version']), `${packageVersion()}\n`)
  })

  it('is the usage text for --help and -h', () => {
    assert.equal(quickAnswer(['--help']), USAGE)
    assert.equal(quickAnswer(['-h']), USAGE)
  })

  it('looks at the first argument only, as the command line does', () => {
    assert.equal(quickAnswer(['--version', '--help']), `${packageVersion()}\n`)
    assert.equal(quickAnswer(['--help', 'jest']), USAGE)
    assert.equal(quickAnswer(['jest', '--help']), undefined)
    assert.equal(quickAnswer(['run', '-h']), undefined)
  })

  it('answers nothing for anything else, and for no arguments', () => {
    for (const argv of [[], ['jest'], ['-v'], ['--versions'], ['version'], ['--dialect', 'jest']]) {
      assert.equal(quickAnswer(argv), undefined, argv.join(' '))
    }
  })
})

describe('main answers through quickAnswer, so the bin and main cannot differ', () => {
  it('writes exactly the quick answer to stdout, exit 0, nothing to stderr', async () => {
    for (const argv of [['--version'], ['--help'], ['-h']]) {
      const stdout = new Sink()
      const stderr = new Sink()
      assert.equal(await main(argv, { stdout, stderr }), 0, argv.join(' '))
      assert.equal(stdout.text, quickAnswer(argv), argv.join(' '))
      assert.equal(stderr.text, '')
    }
  })
})
