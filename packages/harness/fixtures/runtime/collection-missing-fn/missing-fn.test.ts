trace('file start')

test('runs before')

test('runs after', () => trace('test runs after'))

trace('file end')
