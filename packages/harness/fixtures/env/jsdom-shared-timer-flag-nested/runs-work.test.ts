import { schedule } from 'pending-flag'

test('runs-work: work queued here runs', async () => {
  let ran = false
  schedule(() => {
    ran = true
  })
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(ran).toBe(true)
})
