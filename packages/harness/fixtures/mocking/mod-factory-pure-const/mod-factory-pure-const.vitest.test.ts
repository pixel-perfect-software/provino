const label = 'pure'
const sum = 1 + 2
export const exported = 'pure-exported'

vi.mock('./dep.ts', () => ({ label, sum, exported }))

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

// A static import would run the factory above `label`; a test-time import runs it after.
c('a pure const read by a factory that runs at a test-time import', async () => {
  const dep = await import('./dep.ts')
  return { label: dep.label, sum: dep.sum }
})

c('an exported pure const read by the same factory', async () => {
  const dep = await import('./dep.ts')
  return { exported: dep.exported }
})
