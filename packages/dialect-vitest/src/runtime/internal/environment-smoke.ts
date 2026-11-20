// One Vitest environment through its ref, in a process of its own (it populates this process's
// global): `vitest-environment.test.ts` hands it a spec and the checks (expressions, each the
// condition of one recorded test), and reads one JSON line back.
import type { EnvironmentRef, JsonValue } from '@provino/types'
import { vitestEnvironmentFor, vitestEnvironmentRef } from '../vitest-environment.ts'

/** Which environment: a project's, or a docblock's over a project's. */
export type SmokeSpec =
  | {
      readonly kind: 'project'
      readonly name: string
      readonly environmentOptions: { readonly [key: string]: JsonValue }
      readonly rootDir: string
    }
  | {
      readonly kind: 'docblock'
      readonly name: string
      readonly options: JsonValue
      readonly base: {
        readonly name: string
        readonly environmentOptions: { readonly [key: string]: JsonValue }
      }
      readonly rootDir: string
    }

/** What the child prints. */
export interface SmokeResult {
  readonly results: Readonly<Record<string, boolean | string>>
  /** Global keys the teardown left that were not there before. */
  readonly leaked: readonly string[]
  /** Global keys that were there before and are gone after. */
  readonly missing: readonly string[]
  readonly documentAfter: string
}

async function refOf(spec: SmokeSpec): Promise<EnvironmentRef> {
  if (spec.kind === 'project') {
    return vitestEnvironmentRef(spec.name, spec.environmentOptions, spec.rootDir)
  }
  // The project's whole `environmentOptions` rides on the ref, as the reader and config put it there.
  const base = {
    ...vitestEnvironmentRef(spec.base.name, spec.base.environmentOptions, spec.rootDir),
    resolverOptions: spec.base.environmentOptions,
  }
  return vitestEnvironmentFor({
    name: spec.name,
    options: spec.options,
    rootDir: spec.rootDir,
    testPath: `${spec.rootDir}/smoke.test.ts`,
    base,
  })
}

interface Loaded {
  prepare?(options: unknown): unknown
  setup(context: object, prepared: unknown): Promise<{ teardown(): Promise<unknown> }>
}

const [specText, checksText] = process.argv.slice(2)
const spec = JSON.parse(specText ?? '') as SmokeSpec
const checks = JSON.parse(checksText ?? '') as Record<string, string>
const ref = await refOf(spec)
const namespace = (await import(ref.module)) as Record<string, unknown>
const environment = namespace[ref.export] as Loaded
const prepared = await environment.prepare?.(ref.options)
const before = new Set(Reflect.ownKeys(globalThis).map(String))
const instance = await environment.setup(
  {
    options: ref.options,
    realm: 'worker',
    scope: 'file',
    testPath: `${spec.rootDir}/smoke.test.ts`,
    pragmas: {},
    console,
    signal: new AbortController().signal,
  },
  prepared,
)
const results: Record<string, boolean | string> = {}
for (const [title, code] of Object.entries(checks)) {
  try {
    results[title] = new Function(`return (${code})`)() === true
  } catch (error) {
    results[title] = String(error)
  }
}
await instance.teardown()
const after = new Set(Reflect.ownKeys(globalThis).map(String))
const output: SmokeResult = {
  results,
  leaked: [...after].filter((key) => !before.has(key)),
  missing: [...before].filter((key) => !after.has(key)),
  documentAfter: typeof (globalThis as { document?: unknown }).document,
}
process.stdout.write(`${JSON.stringify(output)}\n`)
