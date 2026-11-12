const attempt = (name: string) => () => {
  try {
    require(name)
    return { threw: false }
  } catch (error) {
    const e = error as Error
    return {
      threw: {
        name: e.name,
        message: e.message.replaceAll(process.cwd(), '<root>'),
        code: (e as { code?: string }).code,
      },
    }
  }
}

test('a single target that does not resolve', () => observe('single', attempt('@app/missing')))
test('an array of targets, none resolving', () => observe('array', attempt('@multi/missing')))
test('the first matching rule decides, even when a later one would resolve', () =>
  observe('first', attempt('@first/special')))
test('a hit on the real file still works', () => observe('hit', attempt('@app/real')))
