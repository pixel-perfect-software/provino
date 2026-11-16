// The larger file, so it runs first. The work is queued from the callback of the test's own timer,
// so the package's timer is set there; the test waits for that callback and ends while the
// package's timer is still pending, with the package's flag still set.
import { schedule } from 'pending-flag'

test('leaves-work: work queued from a timer is still pending at the end', async () => {
  let ran = false
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      schedule(() => {
        ran = true
      })
      resolve()
    }, 0)
  })
  expect(ran).toBe(false)
})
