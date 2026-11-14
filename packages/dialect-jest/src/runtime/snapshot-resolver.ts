// `snapshot.resolverFactory` (B23d B1): jest-snapshot 30.5.2's `createCustomSnapshotResolver`
// (`SnapshotResolver.ts` L79-L131), rebuilt. The worker hands it the project's resolver module as
// its file registry loaded it (the project's transform applied, as `createTranspilingRequire`
// does); it checks the three members and that the two functions invert each other, with Jest's
// texts. Jest prints both in bold (chalk); here they are plain.
import type { SnapshotResolver, SnapshotResolverFactory } from '@provino/types'

/** jest-util's `interopRequireDefault(x).default`, over what an `import()` of the module gave. */
function defaultOf(exports: unknown): unknown {
  if (typeof exports === 'object' && exports !== null && 'default' in exports) {
    const inner: unknown = exports.default
    // A CommonJS module that set `__esModule` keeps its own `default` (Babel's interop).
    if (typeof inner === 'object' && inner !== null && Reflect.get(inner, '__esModule') === true) {
      return Reflect.get(inner, 'default')
    }
    return inner
  }
  return exports
}

/** `mustImplement` (L111-L115). */
function mustImplement(propName: string, requiredType: string): string {
  return `Custom snapshot resolver must implement a \`${propName}\` as a ${requiredType}.\nDocumentation: https://jestjs.io/docs/configuration#snapshotresolver-string`
}

const MEMBERS: readonly (readonly [keyof SnapshotResolver, string])[] = [
  ['resolveSnapshotPath', 'function'],
  ['resolveTestPath', 'function'],
  ['testPathForConsistencyCheck', 'string'],
]

/**
 * Builds the Jest resolver of a project's `snapshotResolver` module. Throws Jest's `TypeError`
 * for a missing member and its `Error` for functions that don't invert each other.
 * @public
 */
export const jestSnapshotResolver: SnapshotResolverFactory = (
  exports: unknown,
  extension: string,
): SnapshotResolver => {
  const custom = defaultOf(exports)
  const member = (name: string): unknown =>
    typeof custom === 'object' && custom !== null ? Reflect.get(custom, name) : undefined
  for (const [propName, requiredType] of MEMBERS) {
    if (typeof member(propName) !== requiredType) {
      throw new TypeError(mustImplement(propName, requiredType))
    }
  }
  const resolveSnapshot = member('resolveSnapshotPath') as (path: string, ext: string) => string
  const resolveTest = member('resolveTestPath') as (path: string, ext: string) => string
  const resolver: SnapshotResolver = {
    resolveSnapshotPath: (testPath) => resolveSnapshot.call(custom, testPath, extension),
    resolveTestPath: (snapshotPath) => resolveTest.call(custom, snapshotPath, extension),
    testPathForConsistencyCheck: member('testPathForConsistencyCheck') as string,
  }
  // `verifyConsistentTransformations` (L117-L131).
  const { testPathForConsistencyCheck } = resolver
  const resolvedTestPath = resolver.resolveTestPath(
    resolver.resolveSnapshotPath(testPathForConsistencyCheck),
  )
  if (resolvedTestPath !== testPathForConsistencyCheck) {
    throw new Error(
      `Custom snapshot resolver functions must transform paths consistently, i.e. expects resolveTestPath(resolveSnapshotPath('${testPathForConsistencyCheck}')) === ${resolvedTestPath}`,
    )
  }
  return resolver
}
