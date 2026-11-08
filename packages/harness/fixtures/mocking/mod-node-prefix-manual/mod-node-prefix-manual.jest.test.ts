const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

const fresh = (): void => {
  jest.resetModules()
  jest.dontMock('node:fs')
  jest.dontMock('fs')
}
const markerOf = (specifier: 'fs' | 'node:fs'): unknown =>
  (require(specifier) as { marker?: string }).marker

c('no mock call: the built-in is real', () => {
  fresh()
  return { fs: markerOf('fs'), nodeFs: markerOf('node:fs') }
})

c('mock of node:fs uses the manual file', () => {
  fresh()
  jest.doMock('node:fs')
  return { nodeFs: markerOf('node:fs') }
})

c('mock of node:fs, then a load of the unprefixed name', () => {
  fresh()
  jest.doMock('node:fs')
  return { fs: markerOf('fs') }
})

c('mock of fs, then a load of node:fs', () => {
  fresh()
  jest.doMock('fs')
  return { nodeFs: markerOf('node:fs') }
})

c('mock of fs, then a load of fs', () => {
  fresh()
  jest.doMock('fs')
  return { fs: markerOf('fs') }
})
