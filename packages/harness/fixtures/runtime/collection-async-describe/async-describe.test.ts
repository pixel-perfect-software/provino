trace('file start')

describe('async body', async () => {
  trace('body start')
  test('before await', () => trace('test before await'))
  await Promise.resolve()
  trace('body after await')
  test('after await', () => trace('test after await'))
})

trace('file end')
