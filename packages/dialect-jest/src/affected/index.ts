// @provino/dialect-jest/affected: Jest's changed-files provider and haste's dependency extractor
// (B23c, T9.16, T9.12). A coordinator leaf, loaded by ref like `/global-setup`, with `@provino/types`
// and Node's built-ins as its only imports.
import type { ChangedFilesProvider, DependencyExtractorFactory } from '@provino/types'
import { createChangedFilesProvider } from './changed-files.ts'
import { hasteExtractor } from './extractor.ts'

/**
 * The one provider of this process: the behaviour loader imports this leaf once (Node caches the
 * module), so the provider, and what its `sl` adapter learned, lives as long as the coordinator.
 */
const provider = createChangedFilesProvider()

/**
 * Jest's changed files (`orchestrator.changedFiles`): jest-changed-files 30.5.1's
 * `getChangedFilesForRoots` rebuilt over git, hg and sl. A command that fails rejects with execa's
 * message, which Jest prints, and the code `JEST_SCM_COMMAND_FAILED`.
 * @public
 */
export const jestChangedFiles: ChangedFilesProvider = (options) => provider(options)

/**
 * Haste's dependency extractor (`orchestrator.affected.extractor`): jest-haste-map 30.5.2's regexes.
 * @public
 */
export const jestDependencyExtractor: DependencyExtractorFactory = () => hasteExtractor
