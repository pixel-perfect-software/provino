// D116's proof that the in-place strip (`typescript: 'blank'`) keeps the program Oxc's TypeScript
// transform makes: for each file it blanks, the blanked text read as JavaScript prints the same
// code as Oxc's TypeScript output does (both through Oxc's own printer, so the formatting can't
// differ), and every character it kept sits at its offset in the source. Both sides go through
// `createPipeline` (no hoisting, no cache), so they get the options a project's tsconfig gives.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPipeline } from '@provino/transform'
import type { Pipeline } from '@provino/types'
import { parseSync } from 'oxc-parser'
import { transformSync } from 'oxc-transform'

/** One file the check reads. */
export interface CorpusFile {
  readonly filename: string
  readonly source: string
}

/** What one corpus gave. */
export interface BlankCorpusReport {
  readonly requested: number
  /** Files Oxc's transform reads without an error: the ones that can be compared. */
  readonly valid: number
  /** Valid files the strip blanked; the rest have syntax that falls back to Oxc's transform. */
  readonly blanked: number
  /** Blanked files whose program differs from Oxc's, with the first difference. */
  readonly different: readonly string[]
  /** Blanked files with a character that moved, changed or is not the source's. */
  readonly moved: readonly string[]
}

/** What the pipeline blanks: `.ts`, `.mts` and `.cts`, not declaration files. */
export const BLANKED_FILE: RegExp = /(?<!\.d)\.[cm]?ts$/

function sourceTypeOf(filename: string): 'module' | 'commonjs' {
  return filename.endsWith('.cts') ? 'commonjs' : 'module'
}

/**
 * Oxc's printing of JavaScript, the common ground of the two sides, without comments: Oxc's
 * TypeScript transform drops a comment with the declaration it removes, and the strip keeps it.
 * A comment becomes spaces with its line breaks kept, so the language reads the lines as before.
 */
function printed(filename: string, code: string): { code: string; errors: number } {
  const name = filename.replace(/\.[cm]?ts$/, '.js')
  const options = { lang: 'js', sourceType: sourceTypeOf(filename), target: 'esnext' } as const
  const first = transformSync(name, code, options)
  const { comments } = parseSync(name, first.code, options)
  let text = ''
  let last = 0
  for (const comment of comments) {
    text +=
      first.code.slice(last, comment.start) +
      first.code.slice(comment.start, comment.end).replace(/[^\n\r\u2028\u2029]/g, ' ')
    last = comment.end
  }
  text += first.code.slice(last)
  const second = transformSync(name, text, options)
  return { code: normalized(second.code), errors: first.errors.length + second.errors.length }
}

/**
 * What the two sides may differ in without a different program: the `export {};` Oxc's TypeScript
 * transform writes when the module syntax it kept is gone (the pipeline reads a file's format from
 * its source, so the loader runs it as a module either way), and `import {} from 'x'`, which is
 * `import 'x'`.
 */
function normalized(code: string): string {
  return code
    .replace(/^export \{\};\n/gm, '')
    .replace(/^import \{\} from ("[^"\n]*");$/gm, 'import $1;')
}

function isLineBreak(char: string): boolean {
  return char === '\n' || char === '\r' || char === '\u2028' || char === '\u2029'
}

/** The first offset where the blanked text is not the source with spaces, `;` or `)` in it. */
function firstMoved(source: string, code: string): number {
  if (code.length !== source.length) return Math.min(code.length, source.length)
  for (let at = 0; at < source.length; at++) {
    const kept = code[at] as string
    const original = source[at] as string
    if (kept === original) continue
    if (isLineBreak(original) || isLineBreak(kept)) return at
    if (kept === ' ' || kept === ';' || kept === ')') continue
    return at
  }
  return -1
}

/** The first line where two printings differ, for the report. */
function firstDifference(a: string, b: string): string {
  const left = a.split('\n')
  const right = b.split('\n')
  for (let line = 0; line < Math.max(left.length, right.length); line++) {
    if (left[line] !== right[line]) {
      return `line ${line + 1}: blank ${JSON.stringify(left[line])} oxc ${JSON.stringify(right[line])}`
    }
  }
  return 'equal'
}

/** The two pipelines of the check: `typescript: 'blank'` and `'oxc'`, over one tsconfig. */
export interface BlankPipelines extends Disposable {
  readonly blank: Pipeline
  readonly oxc: Pipeline
}

/**
 * The pipelines for `compilerOptions` (`verbatimModuleSyntax` is the one that changes what the
 * strip removes), written as a tsconfig in a temporary directory that `dispose` removes.
 */
export function blankPipelines(compilerOptions: Readonly<Record<string, unknown>>): BlankPipelines {
  const dir = mkdtempSync(join(tmpdir(), 'provino-blank-'))
  const tsconfig = join(dir, 'tsconfig.json')
  writeFileSync(tsconfig, JSON.stringify({ compilerOptions }))
  const make = (typescript: 'blank' | 'oxc'): Pipeline =>
    createPipeline({ root: dir, typescript, tsconfig, hoist: null, cache: false })
  return {
    blank: make('blank'),
    oxc: make('oxc'),
    [Symbol.dispose]: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function transformed(pipeline: Pipeline, file: CorpusFile) {
  return pipeline.transform({
    filename: file.filename,
    source: file.source,
    role: 'source',
    consumer: 'import',
    instrument: false,
  })
}

/** Checks every `.ts`, `.mts` and `.cts` file of `files` with `pipelines`. */
export function checkBlankCorpus(
  files: readonly CorpusFile[],
  pipelines: BlankPipelines,
): BlankCorpusReport {
  const different: string[] = []
  const moved: string[] = []
  let requested = 0
  let valid = 0
  let blanked = 0
  for (const file of files) {
    if (!BLANKED_FILE.test(file.filename)) continue
    requested++
    const oxc = transformed(pipelines.oxc, file)
    if (oxc.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) continue
    valid++
    const ours = transformed(pipelines.blank, file)
    // A file the strip took has no map (positions are the source's); one that fell back has Oxc's.
    if (ours.map !== null) continue
    blanked++
    const at = firstMoved(file.source, ours.code)
    if (at !== -1) moved.push(`${file.filename}: offset ${at}`)
    const left = printed(file.filename, ours.code)
    const right = printed(file.filename, oxc.code)
    if (left.code !== right.code || left.errors !== right.errors) {
      const errors =
        left.errors === right.errors ? '' : `${left.errors} errors against ${right.errors}; `
      different.push(`${file.filename}: ${errors}${firstDifference(left.code, right.code)}`)
    }
  }
  return { requested, valid, blanked, different, moved }
}
