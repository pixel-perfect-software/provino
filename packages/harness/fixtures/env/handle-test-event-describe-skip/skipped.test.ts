declare const __log: (marker: string) => void

describe.skip('skipped block', () => {
  beforeAll(() => __log('beforeAll skipped block'))
  afterAll(() => __log('afterAll skipped block'))
  test('inside', () => __log('body inside'))
  describe('nested', () => {
    test('deeper', () => __log('body deeper'))
  })
})

test('beside', () => __log('body beside'))
