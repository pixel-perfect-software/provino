// What Vitest 5.0.5's worker resolved for this project, one test a key, the value in the title.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { __INTERNAL } from 'vitest/runtime'

const config: object = __INTERNAL.getWorkerState().config
// The recorder's work directory has a random name: the project at the root reads as <root>.
const rootName = existsSync(join(String(Reflect.get(config, 'root')), 'vitest.config.ts'))
  ? '<root>'
  : String(Reflect.get(config, 'root')).split('/').pop()

function read(path: string): unknown {
  if (path === 'rootName') return rootName
  let value: unknown = config
  for (const part of path.split('.')) {
    value = typeof value === 'object' && value !== null ? Reflect.get(value, part) : undefined
  }
  return value
}

for (const key of ['name', 'testTimeout']) {
  test(`${key}=${JSON.stringify(read(key)) ?? 'undefined'}`, () => {
    expect(true).toBe(true)
  })
}
