// The first test leaves a promise chain that rejects, with no handler, 5 microtask turns after it
// returned. The second waits for a timer, so the microtask queue drains while it runs and Node
// reports the rejection then, while circus is listening, in the first test's async context.
function leaveRejection(turns: number, message: string): void {
  let chain: Promise<void> = Promise.resolve()
  for (let turn = 0; turn < turns; turn++) chain = chain.then(() => undefined)
  void chain.then(() => {
    throw new Error(message)
  })
}

test('leaves a chain that rejects 5 turns later', () => {
  leaveRejection(5, 'rejected 5 turns after a sync test')
})

test('waits for a timer while the rejection is reported', async () => {
  await new Promise((resolve) => setTimeout(resolve, 30))
})

test('runs after them', () => {})
