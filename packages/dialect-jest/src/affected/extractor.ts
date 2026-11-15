// jest-haste-map 30.5.2 `src/lib/dependencyExtractor.ts` L10-L91 (30.5.1 is the build Jest 30.5.2 installs), the regexes and their order
// exactly: comments stripped, then `import`/`export` (not `type`/`typeof`), then `require(` and
// `import(` with a literal (not after a dot), then `jest.requireActual`, `requireMock` and
// `createMockFromModule`. Compat: which edges count decides which tests `-o` selects.
import type { DependencyExtractor } from '@provino/types'

const NOT_A_DOT = '(?<!\\.\\s*)'
const CAPTURE_STRING_LITERAL = (pos: number): string => `([\`'"])([^'"\`]*?)(?:\\${pos})`
const WORD_SEPARATOR = '\\b'
const LEFT_PARENTHESIS = '\\('
const RIGHT_PARENTHESIS = '\\)'
const WHITESPACE = '\\s*'
const OPTIONAL_COMMA = '(:?,\\s*)?'

function createRegExp(parts: readonly string[], flags: string): RegExp {
  return new RegExp(parts.join(''), flags)
}

function alternatives(...parts: readonly string[]): string {
  return `(?:${parts.join('|')})`
}

function functionCallStart(...names: readonly string[]): string[] {
  return [
    NOT_A_DOT,
    WORD_SEPARATOR,
    alternatives(...names),
    WHITESPACE,
    LEFT_PARENTHESIS,
    WHITESPACE,
  ]
}

// Haste writes `[^]` (any character); `[\s\S]` is the same class in a form Biome accepts.
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g
const LINE_COMMENT_RE = /\/\/.*/g

const REQUIRE_OR_DYNAMIC_IMPORT_RE = createRegExp(
  [
    ...functionCallStart('require', 'import'),
    CAPTURE_STRING_LITERAL(1),
    WHITESPACE,
    OPTIONAL_COMMA,
    RIGHT_PARENTHESIS,
  ],
  'g',
)

const IMPORT_OR_EXPORT_RE = createRegExp(
  [
    '\\b(?:import|export)\\s+(?!type(?:of)?\\s+)(?:[^\'"]+\\s+from\\s+)?',
    CAPTURE_STRING_LITERAL(1),
  ],
  'g',
)

const JEST_EXTENSIONS_RE = createRegExp(
  [
    ...functionCallStart('jest\\s*\\.\\s*(?:requireActual|requireMock|createMockFromModule)'),
    CAPTURE_STRING_LITERAL(1),
    WHITESPACE,
    OPTIONAL_COMMA,
    RIGHT_PARENTHESIS,
  ],
  'g',
)

/** Haste's extractor: the specifiers `code` names, in the order the regexes find them. */
export function extractHasteDependencies(code: string): Set<string> {
  const dependencies = new Set<string>()
  const addDependency = (match: string, _quote: string, dep: string): string => {
    dependencies.add(dep)
    return match
  }
  code
    .replaceAll(BLOCK_COMMENT_RE, '')
    .replaceAll(LINE_COMMENT_RE, '')
    .replace(IMPORT_OR_EXPORT_RE, addDependency)
    .replace(REQUIRE_OR_DYNAMIC_IMPORT_RE, addDependency)
    .replace(JEST_EXTENSIONS_RE, addDependency)
  return dependencies
}

/** The extractor object (`DependencyExtractor`): haste's own, with no fallback to call. */
export const hasteExtractor: DependencyExtractor = {
  extract: (code) => extractHasteDependencies(code),
  cacheKey: 'jest-haste-map@30.5.1',
}
