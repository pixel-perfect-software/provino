trace('file start')

describe.only('focused describe', () => {
  trace('focused body')
  test('sibling before', () => trace('test sibling before'))
  test.only('focused test', () => trace('test focused'))
  test('sibling after', () => trace('test sibling after'))
})

describe('unfocused describe', () => {
  test('hidden', () => trace('test hidden'))
  test.only('focused elsewhere', () => trace('test focused elsewhere'))
})

describe('plain describe', () => {
  test('never runs', () => trace('test never runs'))
})

trace('file end')
