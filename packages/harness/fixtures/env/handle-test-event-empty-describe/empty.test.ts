declare const __log: (marker: string) => void

describe('empty', () => {
  beforeAll(() => __log('beforeAll empty'))
  afterEach(() => __log('afterEach empty'))
})

test('beside', () => __log('body beside'))
