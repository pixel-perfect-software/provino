// A plugin the test file adds: it prints any object with a `secret` key as `Redacted<name>`.
expect.addSnapshotSerializer({
  test: (value: unknown) => typeof value === 'object' && value !== null && 'secret' in value,
  serialize: (
    value: { name: string },
    config: unknown,
    indentation: string,
    depth: number,
    refs: unknown,
    printer: (...args: unknown[]) => string,
  ) => `Redacted<${printer(value.name, config, indentation, depth, refs)}>`,
})

describe('serializers', () => {
  test('jest-serializer-vue, from the config', () => {
    expect('<div class="a"><span>hi</span><b>there</b></div>').toMatchSnapshot()
    expect({ html: () => '<ul><li>1</li><li>2</li></ul>' }).toMatchSnapshot()
  })

  test('a plugin added by the file', () => {
    expect({ name: 'x', secret: 1 }).toMatchSnapshot()
    expect({ outer: { name: 'y', secret: 2 }, list: [{ name: 'z', secret: 3 }] }).toMatchSnapshot()
  })

  test('the plugin added last is tried first', () => {
    expect.addSnapshotSerializer({
      test: (value: unknown) => typeof value === 'object' && value !== null && 'secret' in value,
      serialize: () => 'Later',
    })
    expect({ name: 'x', secret: 1 }).toMatchSnapshot()
  })

  test('plain values are untouched', () => {
    expect({ name: 'plain' }).toMatchSnapshot()
  })
})
