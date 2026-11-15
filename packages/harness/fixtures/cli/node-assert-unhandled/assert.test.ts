import assert from 'node:assert'

const failure = (): unknown => {
  try {
    assert.strictEqual('received', 'expected')
  } catch (error) {
    return error
  }
  return undefined
}

it('rejects a promise nobody awaits while it runs', async () => {
  void Promise.reject(failure())
  await new Promise((resolve) => setTimeout(resolve, 20))
})
