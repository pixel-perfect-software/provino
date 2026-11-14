// @provino/loader: the module loader (Track 2). The contract (`Loader`, `FileRegistry`,
// `LoaderOptions`, `CreateLoader`) lives in @provino/types. `createProjectLoader` builds a worker's
// loader, with its resolver and transform pipeline, from the project's clone-safe settings.
export type { CoordinatorLoader } from './coordinator.ts'
export { createCoordinatorLoader } from './coordinator.ts'
export type { LoaderErrorCode } from './errors.ts'
export { LoaderError, ModuleNotFoundError } from './errors.ts'
export { createLoader } from './loader.ts'
export type { ProjectCoverage, ProjectLoaderOptions } from './project.ts'
export { createProjectLoader } from './project.ts'
export { installSourceMappedStacks, type StackOptions } from './stacks.ts'
export {
  ISOLATE_PRAGMA,
  isIsolationTier,
  isolatePragmaOf,
  readIsolatePragma,
  tierFor,
} from './tier.ts'
