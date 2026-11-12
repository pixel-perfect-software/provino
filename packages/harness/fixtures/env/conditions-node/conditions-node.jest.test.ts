// The package is installed by the fixture (`packages`), so the boundary check can't resolve it.
const specifier = 'dual'

test('the package resolves to its node variant', () => {
  expect(require(specifier)).toBe('node')
})
