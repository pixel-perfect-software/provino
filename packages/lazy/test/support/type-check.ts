// T6.2's check on the type tests: every `@ts-expect-error` directive names the code and a substring of
// the message it expects, `// @ts-expect-error TS2339 Property 'nope' does not exist`. The check strips
// the directives, compiles, and requires each removed directive's next line to fail with that code and
// text, and nothing else to fail.
import { type Compiler, compileFiles, type Diagnostic } from './tsc.ts'

/** One directive: where it is (1-based) and what the line after it must say. */
export interface Directive {
  readonly line: number
  readonly code: string
  readonly text: string
}

const DIRECTIVE = /^\s*\/\/ @ts-expect-error (TS\d+) (\S.*)$/
const BARE_DIRECTIVE = /^\s*\/\/ @ts-expect-error\b/

/** The directives in `source`; a directive with no code and text is an error. */
export function parseDirectives(source: string): Directive[] {
  const directives: Directive[] = []
  source.split('\n').forEach((text, index) => {
    const match = DIRECTIVE.exec(text)
    if (match !== null) {
      directives.push({ line: index + 1, code: match[1] ?? '', text: match[2] ?? '' })
    } else if (BARE_DIRECTIVE.test(text)) {
      throw new Error(
        `line ${index + 1}: a @ts-expect-error directive must name its error code and a substring of its message`,
      )
    }
  })
  return directives
}

/** `source` with every directive line blanked, so line numbers stay where they were. */
export function stripDirectives(source: string): string {
  return source
    .split('\n')
    .map((text) => (DIRECTIVE.test(text) ? '' : text))
    .join('\n')
}

/** What differs between the directives and what the compiler said. */
export function compareDiagnostics(
  directives: readonly Directive[],
  diagnostics: readonly Diagnostic[],
): string[] {
  const problems: string[] = []
  const used = new Set<Diagnostic>()
  for (const directive of directives) {
    const onLine = diagnostics.filter((entry) => entry.line === directive.line + 1)
    const match = onLine.find(
      (entry) => entry.code === directive.code && entry.message.includes(directive.text),
    )
    if (match === undefined) {
      const said = onLine.map((entry) => `${entry.code} ${entry.message}`).join(' | ')
      problems.push(
        `line ${directive.line}: expected ${directive.code} containing ${JSON.stringify(directive.text)} on the next line, got ${said === '' ? 'no error' : said}`,
      )
    } else {
      used.add(match)
    }
  }
  for (const entry of diagnostics) {
    if (!used.has(entry)) {
      problems.push(`line ${entry.line}: unexpected ${entry.code} ${entry.message}`)
    }
  }
  return problems
}

/** Strips the directives of `source`, compiles it on `compiler`, and returns every problem found. */
export function checkTypeErrors(compiler: Compiler, source: string): string[] {
  const directives = parseDirectives(source)
  const result = compileFiles(compiler, { 'case.test-d.ts': stripDirectives(source) })
  return compareDiagnostics(directives, result.diagnostics)
}
