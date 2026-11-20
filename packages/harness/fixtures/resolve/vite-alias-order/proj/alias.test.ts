import { expect, test } from 'vitest'

const specs: string[] = ['@first/v.js', '@both/v.js', '@only-test/v.js']

for (const spec of specs) {
  test(`${spec} -> ${await load(spec)}`, () => {
    expect(true).toBe(true)
  })
}

async function load(spec: string): Promise<string> {
  try {
    const loaded: { readonly default: unknown } = await import(/* @vite-ignore */ spec)
    return String(loaded.default)
  } catch {
    return 'unresolved'
  }
}
