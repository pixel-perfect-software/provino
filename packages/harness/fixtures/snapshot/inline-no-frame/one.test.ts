const { run } = require('frame-free') as { run(): Promise<void> }

test('the call has no frame outside node_modules', async () => {
  await run()
})
