// Each test leaves a promise chain that rejects, with no handler, some microtask turns after its body
// returned: fewer than the turns to the next test, more than them, and from an async test. Nothing
// in the file waits for a timer, so the microtask queue never drains while the file runs and Node
// reports each rejection only after the run.
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

test('leaves a chain that rejects 300 turns later', () => {
  leaveRejection(300, 'rejected 300 turns after a sync test')
})

test('an async test leaves a chain that rejects 40 turns later', async () => {
  await Promise.resolve()
  leaveRejection(40, 'rejected 40 turns after an async test')
})

test('runs after them', () => {})
