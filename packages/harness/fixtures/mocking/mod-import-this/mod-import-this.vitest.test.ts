import * as ns from './lib.ts'
import dflt, { tag, whoAmI } from './lib.ts'
import { other } from './other.ts'

vi.mock('./other.ts', () => ({ other: 'mock' }))

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('the mock is registered, so the file hoists', () => ({ other }))

c('a bare call through a named import', () => whoAmI())

c('a call through the namespace', () => ns.whoAmI())

c('a call through a default-import member', () => dflt.whoAmI())

c('a tagged template through a named import', () => tag`x`)

c('a tagged template through the namespace', () => ns.tag`x`)

c('a parenthesized member call keeps its object', () => ns.whoAmI())
