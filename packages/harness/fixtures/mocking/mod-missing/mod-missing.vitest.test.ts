vi.mock('./does-not-exist.ts', () => ({ who: 'mock-of-nothing' }))
vi.mock('does-not-exist-either', () => ({ who: 'mock-of-nothing-bare' }))

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

// Vitest's error names the importing file by its absolute path; only the part before it is kept.
c('a mock of a relative path that does not exist, no virtual flag', async () => {
  try {
    const loaded = (await import('./does-not-exist.ts')) as { who: string }
    return { who: loaded.who }
  } catch (error) {
    return { threw: String((error as Error).message).split(' imported from ')[0] }
  }
})

c('a mock of a bare name that is not installed, no virtual flag', async () => {
  const loaded = (await import('does-not-exist-either')) as { who: string }
  return { who: loaded.who }
})
