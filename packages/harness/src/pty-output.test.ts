// The output watch `spawnPty` and `spawnPiped` share, with no process: text is appended by hand.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HarnessError } from './errors.ts'
import { watchOutput } from './pty.ts'

test('a wait resolves at the end of its match, so text later in the same chunk is still unread', async () => {
  const watch = watchOutput(undefined)
  // One read from the terminal holds both texts.
  watch.append('Pattern Mode Usage\n pattern › ')
  const first = await watch.waitFor('Pattern Mode Usage')
  assert.equal(first, 'Pattern Mode Usage'.length)
  // A second wait from there finds what came after the first match in the same chunk.
  const second = await watch.waitFor(' pattern ›', first)
  assert.equal(second, 'Pattern Mode Usage\n pattern ›'.length)
})

test('a wait that resolves later also ends at its match, not at the end of the output', async () => {
  const watch = watchOutput(undefined)
  const waiting = watch.waitFor('READY', 0)
  watch.append('booting READY and more')
  assert.equal(await waiting, 'booting READY'.length)
})

test('a predicate gives the position it matched at, or -1 for no match', async () => {
  const watch = watchOutput(undefined)
  watch.append('a1 b2 c3')
  const at = await watch.waitFor((output) => {
    const index = output.indexOf('b2')
    return index === -1 ? -1 : index + 2
  })
  assert.equal(at, 'a1 b2'.length)
  watch.end()
  await assert.rejects(
    watch.waitFor(() => -1),
    (error: unknown) => error instanceof HarnessError && error.code === 'HARNESS_WATCH_FAILED',
  )
})
