const order: string[] = []

describe('hooks', () => {
  beforeAll(() => {
    order.push('beforeAll')
  })
  beforeEach(() => {
    order.push('beforeEach')
  })
  afterEach(() => {
    order.push('afterEach')
  })
  afterAll(() => {
    order.push('afterAll')
  })

  it('first', () => {
    expect(order).toEqual(['beforeAll', 'beforeEach'])
  })

  it('second', () => {
    expect(order).toEqual(['beforeAll', 'beforeEach', 'afterEach', 'beforeEach'])
  })
})
