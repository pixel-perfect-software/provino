// The package is installed by the fixture (`packages`), so the boundary check can't resolve it.
const specifier = 'dual'

test('the package resolves to its node variant', async () => {
  const loaded: { readonly default: unknown } = await import(/* @vite-ignore */ specifier)
  expect(loaded.default).toBe('node')
})
