// What a fork's stderr watch remembers. V8 prints its heap fatal error and then about 8 KB of
// native stack, so the line must outlive any fixed-size tail of the stream.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createStderrWatch } from './stderr-watch.ts'

const FATAL = '<--- Last few GCs --->\n\nFATAL ERROR: Reached heap limit Allocation failed\n'

describe('createStderrWatch', () => {
  it('has seen nothing before anything arrives, and for ordinary output', () => {
    const watch = createStderrWatch()
    assert.equal(watch.sawHeapOom, false)
    watch.push('warning: something\n')
    assert.equal(watch.sawHeapOom, false)
  })

  it('remembers the fatal error after more than 8 KB of native stack followed it', () => {
    const watch = createStderrWatch()
    watch.push(FATAL)
    for (let i = 0; i < 4; i++) watch.push(`${'0x00007ff8 node::native::frame '.repeat(100)}\n`)
    assert.equal(watch.sawHeapOom, true)
  })

  it('remembers a fatal error that came in one chunk with the stack after it', () => {
    const watch = createStderrWatch()
    watch.push(`${FATAL}${'x'.repeat(20_000)}`)
    assert.equal(watch.sawHeapOom, true)
  })

  it('finds a line split across two chunks, at every split point', () => {
    for (let at = 1; at < FATAL.length; at++) {
      const watch = createStderrWatch()
      watch.push(FATAL.slice(0, at))
      watch.push(FATAL.slice(at))
      assert.equal(watch.sawHeapOom, true, `split at ${at}`)
    }
  })

  it('recognises the other two lines V8 prints', () => {
    for (const line of [
      'JavaScript heap out of memory',
      'Ineffective mark-compacts near heap limit',
    ]) {
      const watch = createStderrWatch()
      watch.push(`${line}\n`)
      assert.equal(watch.sawHeapOom, true, line)
    }
  })
})
