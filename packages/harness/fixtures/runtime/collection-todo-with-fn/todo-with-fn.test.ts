trace('file start')

test.todo('todo with a function', () => trace('test todo body'))

test('runs after', () => trace('test runs after'))

trace('file end')
