// No import, export or require: the file's only module syntax is the import() calls below.
const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('import() from a file with no other module syntax loads the module and its imports', async () => {
  const target = (await import('./target.ts')) as {
    value: string
    default: () => string
  }
  return { value: target.value, described: target.default() }
})

c('a second import() of the same module gets the same instance', async () => {
  const first = await import('./target.ts')
  const second = await import('./target.ts')
  return first === second
})
