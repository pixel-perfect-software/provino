import { greet, who } from './dep.ts'

jest.mock('./dep.ts', () => ({
  who: 'mock-dep',
  greet: (name: string) => `hello ${name} from the mock`,
}))

const g = globalThis as { __helperLoads?: number }
g.__helperLoads = (g.__helperLoads ?? 0) + 1

export const seen = { who, greeting: greet('ada') }
