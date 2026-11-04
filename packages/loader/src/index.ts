// @provino/loader: the module loader (Track 2). The contract (`Loader`, `FileRegistry`,
// `LoaderOptions`, `CreateLoader`) lives in @provino/types. `createProjectLoader` builds a worker's
// loader, with its resolver and transform pipeline, from the project's clone-safe settings.
export type { LoaderErrorCode } from './errors.ts'
export { LoaderError } from './errors.ts'
export { createLoader } from './loader.ts'
export { createProjectLoader } from './project.ts'
