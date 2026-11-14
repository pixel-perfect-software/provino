// Contracts for changed-file and affected-test selection (B23c, T9.12, T9.16): where the files a
// change touched come from, how a file's dependencies are read, and what a run is asked to select.

/**
 * The files a change touched, as absolute paths: all of them, and by the repository kind that
 * reported them.
 * @public
 */
export interface ChangedFiles {
  readonly changedFiles: readonly string[]
  readonly repos: {
    readonly git: readonly string[]
    readonly hg: readonly string[]
    readonly sl: readonly string[]
  }
}

/**
 * What a `ChangedFilesProvider` is asked. `roots` are absolute: one set across every project.
 * @public
 */
export interface ChangedFilesOptions {
  readonly roots: readonly string[]
  /** Files changed since this ref (`--changedSince`). */
  readonly changedSince?: string
  /** Only the files of the last commit (`--lastCommit`). */
  readonly lastCommit?: boolean
  /** With `changedSince`: the ancestor's files too (`--changedFilesWithAncestor`). */
  readonly withAncestor?: boolean
}

/**
 * Finds the changed files under some roots. The dialect supplies it
 * (`orchestrator.changedFiles`); it runs in the coordinator.
 * @public
 */
export type ChangedFilesProvider = (options: ChangedFilesOptions) => Promise<ChangedFiles>

/**
 * Reads the specifiers a file's code depends on. This is the shape of Jest's custom
 * `dependencyExtractor`: `fallback` is the default extractor over the same code, and `cacheKey`
 * names the extractor's version for the edge cache.
 * @public
 */
export interface DependencyExtractor {
  extract(
    code: string,
    path: string,
    fallback: (code: string) => Iterable<string>,
  ): Iterable<string>
  readonly cacheKey?: string
}

/**
 * What `orchestrator.affected.extractor` refs: a function the behaviour loader calls once (it
 * loads functions, not objects) to get the extractor.
 * @public
 */
export type DependencyExtractorFactory = () => DependencyExtractor

/**
 * What a run is asked to select, in place of its file filters: the tests related to some paths
 * (`--findRelatedTests`), or the ones a set of changed files reaches.
 * @public
 */
export type AffectedSelection =
  | { readonly kind: 'related'; readonly paths: readonly string[] }
  | { readonly kind: 'changed'; readonly changed: ChangedFiles }
