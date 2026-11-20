import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

test('sees the variables the CLI set', () => {
  const seen = Object.fromEntries(
    ['TEST', 'VITEST', 'NODE_ENV', 'VITEST_MODE'].map((name) => [name, process.env[name] ?? null]),
  )
  writeFileSync(join(import.meta.dirname, 'env.json'), `${JSON.stringify(seen)}\n`)
})
