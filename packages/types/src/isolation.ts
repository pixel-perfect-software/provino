/**
 * How strongly test files are isolated from each other in a worker (Track 2): no isolation, a
 * fresh module registry per file, a fresh realm per file, or a process per file.
 * @public
 */
export type IsolationTier = 'none' | 'registry' | 'realm' | 'process'
