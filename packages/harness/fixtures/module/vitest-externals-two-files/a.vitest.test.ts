// File a of two in one worker. The packages are installed by the fixture, so the specifiers
// are variables the boundary check can't resolve.
const hookerName = 'hooker'
const patcherName = 'patcher'
const hooker: { readonly default: { runs(): number } } = await import(/* @vite-ignore */ hookerName)
await import(/* @vite-ignore */ patcherName)
declare const __patched: string | undefined
declare const __patcherLoads: number | undefined

test('the package hook ran once before the first test', () => {
  expect(hooker.default.runs()).toBe(1)
})

test('the patched global is there', () => {
  expect(typeof __patched === 'undefined' ? 'absent' : __patched).toBe('yes')
})

test('the patching package was evaluated once for this file', () => {
  expect(__patcherLoads).toBe(1)
})
