jest.mock('./fn.ts', () => {
  const bare = () => 'called'
  return bare
})

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('a bare function as the module', () => {
  const loaded = require('./fn.ts')
  return { type: typeof loaded, result: typeof loaded === 'function' ? loaded() : undefined }
})
