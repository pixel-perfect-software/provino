// `@provino/loader/graph` (D52): the node_modules graph. It runs in a worker (T2.6's inlining) and
// can run in the coordinator (Track 9's affected-test selection), so it imports only
// `@provino/types` and `es-module-lexer`, never the loader's root.
export type { GraphEntry, GraphOptions, ThirdPartyGraph } from './build.ts'
export { buildThirdPartyGraph, inGraph } from './build.ts'
export type { EdgeTarget, GraphEdge, GraphNode } from './cache.ts'
export { graphCacheKey } from './cache.ts'
export { importersOf } from './query.ts'
export type { EdgeKind, Scan, ScannedEdge } from './scan.ts'
export { initLexer, scanSource } from './scan.ts'
