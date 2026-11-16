import { label, pathname } from './location.ts'

const suffix = String('!')

jest.mock('./location.ts', () => ({
  pathname: () => window.location.pathname,
  label: () => `${window.location.pathname}${suffix}`,
}))

test('a mock factory reads window', () => {
  expect(pathname()).toBe('/')
})

test('a mock factory reads a module-scope variable not prefixed mock', () => {
  expect(label()).toBe('/!')
})
