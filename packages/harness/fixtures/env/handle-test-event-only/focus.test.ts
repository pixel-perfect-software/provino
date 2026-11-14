declare const __log: (marker: string) => void

test('top level, not focused', () => __log('body top level'))

describe('focused block', () => {
  beforeAll(() => __log('beforeAll focused block'))
  test('not focused', () => __log('body not focused'))
  test.only('focused', () => __log('body focused'))
  test.skip('skipped', () => __log('body skipped'))
  test.todo('todo item')
})

describe('unfocused block', () => {
  beforeAll(() => __log('beforeAll unfocused block'))
  test('never runs', () => __log('body never runs'))
})
