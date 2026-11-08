// Jest's spyOn and replaceProperty errors the other fixtures don't reach.
const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}
const thrown = (run: () => unknown): unknown => {
  try {
    run()
    return 'did not throw'
  } catch (error) {
    return error
  }
}
const spyOn = jest.spyOn as unknown as (object: unknown, key: unknown) => unknown
const replaceProperty = jest.replaceProperty as unknown as (
  object: unknown,
  key: unknown,
  value: unknown,
) => unknown

c('spyOn with no property name', () => thrown(() => spyOn({}, undefined)))

c('spyOn on a property that is not a function', () => thrown(() => spyOn({ value: {} }, 'value')))

c('replaceProperty with no property name', () => thrown(() => replaceProperty({}, undefined, 1)))

c('replaceProperty on a property that is not configurable', () => {
  const target = {}
  Object.defineProperty(target, 'fixed', { value: 1, configurable: false })
  return thrown(() => replaceProperty(target, 'fixed', 2))
})

c('replaceProperty on a property with only a setter', () => {
  const target = {}
  Object.defineProperty(target, 'written', { set() {}, configurable: true })
  return thrown(() => replaceProperty(target, 'written', 2))
})
