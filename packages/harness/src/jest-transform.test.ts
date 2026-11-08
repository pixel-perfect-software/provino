import assert from 'node:assert/strict'
import { test } from 'node:test'
import transformer from './jest-transform.ts'

// The transform options Jest hands `process`; babel-jest reads only what these name.
// A full `ProjectConfig` has dozens of fields, so the object is cast to the options type.
type ProcessOptions = Parameters<
  NonNullable<Awaited<ReturnType<typeof transformer.createTransformer>>['process']>
>[2]
const OPTIONS = {
  config: { rootDir: '/', cwd: '/', transform: [], extensionsToTreatAsEsm: [] },
  supportsStaticESM: false,
  supportsDynamicImport: false,
  supportsExportNamespaceFrom: false,
  supportsTopLevelAwait: false,
  instrument: false,
  configString: '{}',
  transformerConfig: {},
  cacheFS: new Map(),
} as unknown as ProcessOptions

function codeOf(result: unknown): string {
  if (typeof result === 'object' && result !== null && 'code' in result) return String(result.code)
  throw new Error('transformer returned no code')
}

const SOURCE = "import { a } from './a.ts'\nexport const b: number = a\n"

test('without jestEsm an import is left alone; with it, it becomes require', async () => {
  const plain = await transformer.createTransformer()
  const esm = await transformer.createTransformer({ jestEsm: true })
  const file = '/work/x.test.ts'
  assert.match(codeOf(plain.process?.(SOURCE, file, OPTIONS)), /^import /m)
  const converted = codeOf(esm.process?.(SOURCE, file, OPTIONS))
  assert.match(converted, /require\(["']\.\/a\.ts["']\)/)
  assert.doesNotMatch(converted, /^import /m)
})

test('a config without jestEsm: true is the plain transformer', async () => {
  const other = await transformer.createTransformer({ jestEsm: false })
  assert.match(codeOf(other.process?.(SOURCE, '/work/x.test.ts', OPTIONS)), /^import /m)
})
