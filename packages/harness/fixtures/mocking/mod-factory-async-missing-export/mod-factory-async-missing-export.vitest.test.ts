vi.mock('./target.ts', async () => ({ present: 'mock-present' }))

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('the export the async factory returned', async () => {
  const target = (await import('./target.ts')) as { present?: string }
  return { present: target.present }
})

c('the export the async factory left out', async () => {
  const target = (await import('./target.ts')) as { missing?: string }
  return { missing: target.missing }
})
