// What Vitest 5.0.5's worker resolved for this project, one test a key, the value in the title.
import { __INTERNAL } from 'vitest/runtime'

const config: object = __INTERNAL.getWorkerState().config

function read(path: string): unknown {
  let value: unknown = config
  for (const part of path.split('.')) {
    value = typeof value === 'object' && value !== null ? Reflect.get(value, part) : undefined
  }
  return value
}

for (const key of [
  'testTimeout',
  'hookTimeout',
  'isolate',
  'pool',
  'globals',
  'clearMocks',
  'mockReset',
  'restoreMocks',
  'unstubGlobals',
  'unstubEnvs',
  'maxConcurrency',
  'sequence.hooks',
  'sequence.shuffle',
  'retry',
  'passWithNoTests',
  'environmentOptions',
  'snapshotOptions.snapshotFormat',
]) {
  test(`${key}=${JSON.stringify(read(key)) ?? 'undefined'}`, () => {
    expect(true).toBe(true)
  })
}
