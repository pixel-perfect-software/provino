// The larger file, so it runs first: the work it queues is still pending when it ends, and the
// package's flag is still set with it.
import { schedule } from 'pending-flag'

test('leaves-work: the queued work is still pending at the end', () => {
  let ran = false
  schedule(() => {
    ran = true
  })
  expect(ran).toBe(false)
})
