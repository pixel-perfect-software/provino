import * as dep from './dep.ts'

const label = 'pure'
const sum = 1 + 2
export const exported = 'pure-exported'

jest.mock('./dep.ts', () => ({ label, sum, exported }))

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('a pure const read by a factory that ran at the static import', () => ({
  label: dep.label,
  sum: dep.sum,
}))

c('an exported pure const read by the same factory', () => ({ exported: dep.exported }))
