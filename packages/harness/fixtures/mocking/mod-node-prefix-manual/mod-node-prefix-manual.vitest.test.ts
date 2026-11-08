const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

const fresh = (): void => {
  vi.resetModules()
  vi.doUnmock('node:fs')
  vi.doUnmock('fs')
}
// biome-ignore lint/style/useNodejsImportProtocol: the unprefixed spelling is what this case pins
const fsMarker = async (): Promise<unknown> => ((await import('fs')) as { marker?: string }).marker
const nodeFsMarker = async (): Promise<unknown> =>
  ((await import('node:fs')) as { marker?: string }).marker

c('no mock call: the built-in is real', async () => {
  fresh()
  return { fs: await fsMarker(), nodeFs: await nodeFsMarker() }
})

c('mock of node:fs uses the manual file', async () => {
  fresh()
  vi.doMock('node:fs')
  return { nodeFs: await nodeFsMarker() }
})

c('mock of node:fs, then a load of the unprefixed name', async () => {
  fresh()
  vi.doMock('node:fs')
  return { fs: await fsMarker() }
})

c('mock of fs, then a load of node:fs', async () => {
  fresh()
  vi.doMock('fs')
  return { nodeFs: await nodeFsMarker() }
})

c('mock of fs, then a load of fs', async () => {
  fresh()
  vi.doMock('fs')
  return { fs: await fsMarker() }
})
