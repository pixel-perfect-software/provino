const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function busyWait(ms: number): void {
  const end = Date.now() + ms
  while (Date.now() < end) {
    // hold the thread
  }
}

test('sync busy-wait overrun', () => {
  trace('test busy start')
  busyWait(200)
  trace('test busy end')
}, 50)

test('test over its timeout', async () => {
  trace('test slow start')
  await sleep(300)
  trace('test slow late end')
}, 50)

describe('hook over its timeout', () => {
  beforeEach(async () => {
    trace('beforeEach slow start')
    await sleep(300)
    trace('beforeEach slow late end')
  }, 50)
  afterEach(() => trace('afterEach after slow hook'))

  test('test after a slow hook', () => trace('test after slow hook'))
})

test('waits for the late work', async () => {
  trace('wait start')
  await sleep(700)
  trace('wait end')
})
