// T9.12: what a file imports, as specifiers. The extractor is the policy's (`affected.extractor`,
// Jest's haste regexes under the Jest dialect), the project's own (`NeutralProject.affected`, Jest's
// `dependencyExtractor`) before it, and the lexer of `@provino/loader/graph` when neither is set.
import { extname, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { scanSource } from '@provino/loader/graph'
import { callBehaviour, createBehaviourLoader } from '@provino/policy'
import type {
  Behaviour,
  DependencyExtractor,
  DependencyExtractorFactory,
  ModuleRef,
} from '@provino/types'
import { OrchestratorError } from '../errors.ts'

/**
 * Reads the specifiers of one file's code.
 * @internal
 */
export interface EdgeExtractor {
  /** What the extractor is, for the edge cache: another identity reads nothing the cache holds. */
  readonly identity: string
  extract(code: string, path: string): readonly string[]
}

/** The lexer's edges: static imports and re-exports, `import()` and `require(` with a literal. */
function lexerSpecifiers(code: string): readonly string[] {
  return scanSource(code).edges.map((edge) => edge.specifier)
}

/**
 * The neutral extractor: `scanSource` (es-module-lexer and a `require` scan). Speed: the lexer is
 * the faster option over haste's regexes, and reads the same edges for source a lexer can read.
 * @internal
 */
export function lexerExtractor(): EdgeExtractor {
  return { identity: 'lexer', extract: (code) => lexerSpecifiers(code) }
}

/**
 * A `DependencyExtractor` (Jest's custom `dependencyExtractor` shape) as an `EdgeExtractor`: it
 * is given the lexer's as its fallback, and its `cacheKey` is part of its identity.
 * @internal
 */
export function customExtractor(extractor: DependencyExtractor, source: string): EdgeExtractor {
  return {
    identity: `custom:${source}:${extractor.cacheKey ?? ''}`,
    extract: (code, path) => [...extractor.extract(code, path, lexerSpecifiers)],
  }
}

/** A file whose dependencies are not read: JSON has none, and a `.snap` is not code (haste's blacklist). */
export function hasEdges(path: string): boolean {
  const extension = extname(path).toLowerCase()
  return extension !== '.json' && extension !== '.snap'
}

function sourceOf(ref: Behaviour<DependencyExtractorFactory>): string {
  return typeof ref === 'function' ? 'function' : `${ref.module}#${ref.export}`
}

function isExtractor(value: unknown): value is DependencyExtractor {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { extract?: unknown }).extract === 'function'
  )
}

/**
 * A project's own extractor: a Jest `dependencyExtractor` module exports an object, not a
 * function, so the behaviour loader can't load it. It is imported plainly: the ref's export, else
 * `default` (also the `default` of a CommonJS module), else the namespace itself.
 */
async function importProjectExtractor(ref: ModuleRef): Promise<DependencyExtractor> {
  const location = isAbsolute(ref.module) ? pathToFileURL(ref.module).href : ref.module
  const namespace: Record<string, unknown> = await import(location)
  for (const candidate of [namespace[ref.export], namespace.default, namespace]) {
    if (isExtractor(candidate)) return candidate
  }
  throw new OrchestratorError(
    'ORCH_BAD_OPTION',
    `the dependency extractor "${ref.module}" must export an object with an extract function`,
  )
}

/**
 * The extractor of a project: its own (`projectRef`, imported as an object) first, then the
 * policy's `affected.extractor` (a factory the behaviour loader calls once), then the lexer.
 * @internal
 */
export async function loadExtractor(
  policyExtractor: Behaviour<DependencyExtractorFactory> | null,
  projectRef?: ModuleRef,
): Promise<EdgeExtractor> {
  if (projectRef !== undefined) {
    return customExtractor(await importProjectExtractor(projectRef), `${projectRef.module}`)
  }
  if (policyExtractor === null) return lexerExtractor()
  const extractor = await callBehaviour(createBehaviourLoader(), policyExtractor)
  return customExtractor(extractor, sourceOf(policyExtractor))
}
