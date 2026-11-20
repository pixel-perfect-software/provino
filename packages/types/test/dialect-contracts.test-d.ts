// B25 Phase 1's contracts: the policy keys and the project data the Vitest dialect's lanes fill in
// (`SnapshotPolicy.mismatch`, `CorePolicy.definitions`) and `NeutralProject.importMetaEnv`.
import type {
  Behaviour,
  CorePolicy,
  DataOnly,
  DefinitionErrorInfo,
  FormatDefinitionError,
  ModuleRef,
  NeutralProject,
  SnapshotPolicy,
} from '@provino/types'
import { expectTypeOf } from 'expect-type'

// A snapshot mismatch fails at the end of the test or at the call, nothing else.
expectTypeOf<SnapshotPolicy['mismatch']>().toEqualTypeOf<'end-of-test' | 'throw'>()
export const atEnd: SnapshotPolicy['mismatch'] = 'end-of-test'
// @ts-expect-error a mismatch is never ignored
export const ignored: SnapshotPolicy['mismatch'] = 'ignore'

// `test.extend` is on the test API or it isn't.
expectTypeOf<CorePolicy['definitions']['extendApi']>().toEqualTypeOf<'expose' | 'absent'>()
// @ts-expect-error a boolean is not one of the two values
export const extendOn: CorePolicy['definitions']['extendApi'] = true

// The words of a definition error are a behaviour, which crosses to a worker as a ref.
expectTypeOf<
  CorePolicy['definitions']['messages']
>().toEqualTypeOf<Behaviour<FormatDefinitionError> | null>()
expectTypeOf<
  DataOnly<CorePolicy>['definitions']['messages']
>().toEqualTypeOf<ModuleRef<FormatDefinitionError> | null>()
expectTypeOf<DefinitionErrorInfo['kind']>().toEqualTypeOf<'parse' | 'dependency' | 'access'>()
export const words: FormatDefinitionError = (error) => ({
  name: 'FixtureDependencyError',
  message: error.message,
})
// @ts-expect-error a definition error is worded with its name, not only a message
export const bare: FormatDefinitionError = (error) => error.message
// @ts-expect-error `fixture` is not one of core's checks
export const unknownKind: DefinitionErrorInfo['kind'] = 'fixture'

// `import.meta.env` is data: strings and booleans only.
expectTypeOf<NeutralProject['importMetaEnv']>().toEqualTypeOf<
  Readonly<Record<string, string | boolean>> | undefined
>()
export const env: NonNullable<NeutralProject['importMetaEnv']> = { MODE: 'test', DEV: true }
// @ts-expect-error a number is not an env value (Vite's are strings and booleans)
export const numeric: NonNullable<NeutralProject['importMetaEnv']> = { PORT: 3000 }
