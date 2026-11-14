// @provino/dialect-jest/affected: Jest's changed-files provider and haste's dependency extractor
// (B23c, T9.16, T9.12). A coordinator leaf, loaded by ref like `/global-setup`, with `@provino/types`
// as its only import. Phase 1 holds the exports the policy names; they throw until Phase 5 builds them.
import type { ChangedFilesProvider, DependencyExtractorFactory } from '@provino/types'

/** The error a stub throws: the orchestrator's `ORCH_NOT_IMPLEMENTED`, which this leaf can't import. */
function notImplemented(what: string): Error & { readonly code: 'ORCH_NOT_IMPLEMENTED' } {
  return Object.assign(new Error(`${what} is not implemented yet (B23c Phase 5)`), {
    code: 'ORCH_NOT_IMPLEMENTED' as const,
  })
}

/**
 * Jest's changed files (`orchestrator.changedFiles`): jest-changed-files rebuilt over git, hg and sl.
 * @public
 */
export const jestChangedFiles: ChangedFilesProvider = () => {
  return Promise.reject(notImplemented('jestChangedFiles'))
}

/**
 * Haste's dependency extractor (`orchestrator.affected.extractor`).
 * @public
 */
export const jestDependencyExtractor: DependencyExtractorFactory = () => {
  throw notImplemented('jestDependencyExtractor')
}
