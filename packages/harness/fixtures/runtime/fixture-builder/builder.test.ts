const myTest = test
  .extend('base', () => {
    trace('base built')
    return 1
  })
  .extend('plus', ({ base }) => base + 1)
  .extend('withCleanup', async ({ plus }, { onCleanup }) => {
    trace('withCleanup built')
    onCleanup(() => trace('withCleanup cleanup'))
    return plus * 10
  })
  .extend('fileValue', { scope: 'file' }, () => {
    trace('fileValue built')
    return 'file'
  })

myTest('builder values', ({ base, plus, withCleanup }) => {
  trace(`values ${base} ${plus} ${withCleanup}`)
})

myTest('a file value', ({ fileValue }) => {
  trace(`file ${fileValue}`)
})

myTest('the same file value', ({ fileValue }) => {
  trace(`file again ${fileValue}`)
})
