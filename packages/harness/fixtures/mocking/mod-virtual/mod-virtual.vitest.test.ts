vi.mock('./not-on-disk.ts', () => ({ who: 'virtual-relative' }))
vi.mock('not-installed-anywhere', () => ({ who: 'virtual-bare' }))

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

// Vitest's error names the importing file by its absolute path; only the part before it is kept.
c('a virtual module at a relative path that is not on disk, loaded lazily', async () => {
  try {
    const loaded = (await import('./not-on-disk.ts')) as { who: string }
    return { who: loaded.who }
  } catch (error) {
    return { threw: String((error as Error).message).split(' imported from ')[0] }
  }
})

c('a virtual module with a bare name, loaded lazily', async () => {
  const loaded = (await import('not-installed-anywhere')) as { who: string }
  return { who: loaded.who }
})
