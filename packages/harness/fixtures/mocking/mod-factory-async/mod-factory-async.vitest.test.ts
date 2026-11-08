import * as value from './value.ts'

vi.mock('./value.ts', async () => ({ x: 'mock-x' }))

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('an async factory: the named export, and whether the module is thenable', () => ({
  x: (value as { x?: string }).x,
  thenable: typeof (value as { then?: unknown }).then,
}))

c('awaiting the module after an async factory', async () => {
  const awaited = (await (value as unknown as Promise<{ x?: string }>)) as { x?: string }
  return { x: awaited.x }
})
