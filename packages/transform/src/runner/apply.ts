// T3.13: the module-runner form, as text edits. `rewriteModule` parses, reads (`analyse.ts`) and
// edits; the shape is oxc's module-runner transform:
//
//   - one `Object.defineProperty(__vite_ssr_exports__, name, { …, get() { return local } })` per
//     export, then every import as `const __vite_ssr_import_N__ = await __vite_ssr_import__(…)`,
//     all above the module's own statements (after a hashbang and directives);
//   - uses of an import become `__vite_ssr_import_N__.name`; `export default expr` becomes
//     `const __vite_ssr_export_default__ = expr`; `import()` and `import.meta` become
//     `__vite_ssr_dynamic_import__` and `__vite_ssr_import_meta__`.
//
// The edits are plain `{ start, end, text }` records applied by slicing; `magic-string` is only
// built, from the same records, when something reads the source map.
import type { RunnerEdit, RunnerForm } from '@provino/types'
import MagicString from 'magic-string'
import { type ParserOptions, parseSync, rawTransferSupported, type StringLiteral } from 'oxc-parser'
import { exportName, targetNames } from '../hoist/ast.ts'
import { CONTINUES_LINE, skipTrivia } from '../internal/trivia.ts'
import { type ImportBinding, isImportReference, walkProgram } from './analyse.ts'

/** The parser's own message for the first error in the file. */
export class RunnerParseError extends Error {}

const RAW_TRANSFER = rawTransferSupported()

type Options = ParserOptions & { experimentalRawTransfer?: boolean }

const OPTIONS: Options = {
  lang: 'jsx',
  sourceType: 'unambiguous',
  preserveParens: false,
  showSemanticErrors: true,
  ...(RAW_TRANSFER ? { experimentalRawTransfer: true } : {}),
}

/** CommonJS is a function body to Node, so a top-level `return` is legal in it and not in a module. */
const COMMONJS_OPTIONS: Options = { ...OPTIONS, sourceType: 'commonjs' }

const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*$/u

function member(object: string, name: string): string {
  return IDENTIFIER.test(name) ? `${object}.${name}` : `${object}[${JSON.stringify(name)}]`
}

function getter(name: string, value: string): string {
  return `Object.defineProperty(__vite_ssr_exports__, ${JSON.stringify(name)}, { enumerable: true, configurable: true, get() { return ${value}; } });`
}

/** `;` where removing a statement would let the next one continue the line before. */
function removal(code: string, start: number, end: number): RunnerEdit {
  const next = code[skipTrivia(code, end)]
  return { start, end, text: next !== undefined && CONTINUES_LINE.has(next) ? ';' : '' }
}

/**
 * Rewrites `code` (stripped, hoisted JavaScript) into module-runner form. `commonjs` reads it as a
 * CommonJS file (the loader's runner form of a file that calls `import()`), not as a module.
 * @throws RunnerParseError when the parser reports an error, with its text.
 */
export function rewriteModule(filename: string, code: string, commonjs = false): RunnerForm {
  const parsed = parseSync(filename, code, commonjs ? COMMONJS_OPTIONS : OPTIONS)
  for (const error of parsed.errors) {
    if (String(error.severity) === 'Error') throw new RunnerParseError(error.message)
  }
  const program = parsed.program
  const body = program.body

  // Pass 1: every import-like declaration, in source order, so each gets its number.
  const imports = new Map<string, ImportBinding>()
  const importLines: string[] = []
  const importIndex: number[] = []
  const deps = new Set<string>()
  let count = 0
  for (let i = 0; i < body.length; i++) {
    const statement = body[i]
    let source: StringLiteral | null = null
    if (statement?.type === 'ImportDeclaration' || statement?.type === 'ExportAllDeclaration') {
      source = statement.source
    } else if (statement?.type === 'ExportNamedDeclaration') source = statement.source
    if (statement === undefined || source === null) continue
    const index = count++
    importIndex[i] = index
    const specifier = source.value
    deps.add(specifier)
    const names: string[] = []
    let namespace = false
    if (statement.type === 'ImportDeclaration') {
      for (const spec of statement.specifiers) {
        if (spec.type === 'ImportNamespaceSpecifier') {
          namespace = true
          imports.set(spec.local.name, { index, imported: null })
        } else {
          const imported =
            spec.type === 'ImportDefaultSpecifier' ? 'default' : exportName(spec.imported)
          names.push(imported)
          imports.set(spec.local.name, { index, imported })
        }
      }
    } else if (statement.type === 'ExportNamedDeclaration') {
      for (const spec of statement.specifiers) names.push(exportName(spec.local))
    }
    const variable = `__vite_ssr_import_${index}__`
    // `import {} from 'x'` and `export {} from 'x'` name nothing, which is not a side-effect import.
    const braced =
      statement.type === 'ExportNamedDeclaration' ||
      (statement.type === 'ImportDeclaration' &&
        statement.specifiers.length === 0 &&
        code.slice(statement.start, source.start).includes('{'))
    const options =
      (names.length > 0 || braced) && !namespace
        ? `, { importedNames: [${names.map((name) => JSON.stringify(name)).join(', ')}] }`
        : ''
    importLines.push(
      `const ${variable} = await __vite_ssr_import__(${JSON.stringify(specifier)}${options});`,
    )
    if (statement.type === 'ExportAllDeclaration' && statement.exported === null) {
      importLines.push(`__vite_ssr_exportAll__(${variable});`)
    }
  }

  const edits: RunnerEdit[] = []
  const getters: string[] = []

  // Pass 2: exports (getters and the statement edits), then the references the walk found.
  for (let i = 0; i < body.length; i++) {
    const statement = body[i]
    if (statement === undefined) continue
    switch (statement.type) {
      case 'ImportDeclaration':
      case 'ExportAllDeclaration':
        edits.push(removal(code, statement.start, statement.end))
        if (statement.type === 'ExportAllDeclaration' && statement.exported !== null) {
          getters.push(
            getter(exportName(statement.exported), `__vite_ssr_import_${importIndex[i]}__`),
          )
        }
        break
      case 'ExportNamedDeclaration': {
        const declaration = statement.declaration
        if (declaration !== null) {
          if (declaration.type === 'VariableDeclaration') {
            for (const declarator of declaration.declarations) {
              for (const name of targetNames(declarator.id)) getters.push(getter(name, name))
            }
          } else if (declaration.id?.type === 'Identifier') {
            getters.push(getter(declaration.id.name, declaration.id.name))
          }
          edits.push({ start: statement.start, end: declaration.start, text: '' })
          break
        }
        const from = importIndex[i]
        for (const spec of statement.specifiers) {
          const exported = exportName(spec.exported)
          let value: string
          if (from !== undefined) {
            value = member(`__vite_ssr_import_${from}__`, exportName(spec.local))
          } else {
            const local = exportName(spec.local)
            const binding = imports.get(local)
            value =
              binding === undefined
                ? local
                : binding.imported === null
                  ? `__vite_ssr_import_${binding.index}__`
                  : member(`__vite_ssr_import_${binding.index}__`, binding.imported)
          }
          getters.push(getter(exported, value))
        }
        edits.push(removal(code, statement.start, statement.end))
        break
      }
      case 'ExportDefaultDeclaration': {
        const declaration = statement.declaration
        const id =
          declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration'
            ? declaration.id
            : null
        if (id !== null) {
          getters.push(getter('default', id.name))
          edits.push({ start: statement.start, end: declaration.start, text: '' })
        } else {
          getters.push(getter('default', '__vite_ssr_export_default__'))
          const keyword = skipTrivia(code, statement.start + 6)
          edits.push({
            start: statement.start,
            end: keyword + 7,
            text: 'const __vite_ssr_export_default__ =',
          })
          if (
            declaration.type === 'FunctionDeclaration' ||
            declaration.type === 'ClassDeclaration'
          ) {
            edits.push({ start: declaration.end, end: declaration.end, text: ';' })
          }
        }
        break
      }
      default:
        break
    }
  }

  const walked = walkProgram(program, imports)
  if (walked.redeclared !== null) {
    throw new RunnerParseError(`Identifier \`${walked.redeclared}\` has already been declared`)
  }
  for (const ref of walked.references) {
    if (!isImportReference(ref)) continue
    const binding = imports.get(ref.name) as ImportBinding
    const variable = `__vite_ssr_import_${binding.index}__`
    const value = binding.imported === null ? variable : member(variable, binding.imported)
    let text: string
    if (ref.kind === 'shorthand') text = `${ref.name}: ${value}`
    else if (ref.kind === 'callee' && binding.imported !== null) {
      text = `(0, ${value})`
      if (ref.opensStatement) text = `;${text}`
    } else text = value
    edits.push({ start: ref.start, end: ref.end, text })
  }
  const dynamicDeps = new Set<string>()
  for (const dynamic of walked.dynamicImports) {
    edits.push({
      start: dynamic.start,
      end: dynamic.start + 6,
      text: '__vite_ssr_dynamic_import__',
    })
    if (dynamic.specifier !== null) dynamicDeps.add(dynamic.specifier)
  }
  for (const meta of walked.metas) {
    edits.push({ start: meta.start, end: meta.end, text: '__vite_ssr_import_meta__' })
  }

  // The generated block goes after a hashbang and the directives.
  const block = [...getters, ...importLines].join('\n')
  if (block !== '') {
    let at = 0
    let guard = ''
    if (program.hashbang != null) at = program.hashbang.end
    for (const statement of body) {
      if (statement.type === 'ExpressionStatement' && statement.directive != null) {
        at = statement.end
        guard = code[at - 1] === ';' ? '' : ';'
      } else break
    }
    edits.push({ start: at, end: at, text: at === 0 ? `${block}\n` : `${guard}\n${block}\n` })
  }

  if (edits.length === 0) return { code, edits, deps: [...deps], dynamicDeps: [...dynamicDeps] }
  // Insertions sort before an overwrite starting at the same offset; the sort is stable.
  edits.sort((a, b) => a.start - b.start || Number(a.end !== a.start) - Number(b.end !== b.start))
  let out = ''
  let cursor = 0
  for (const edit of edits) {
    out += code.slice(cursor, edit.start) + edit.text
    cursor = edit.end
  }
  out += code.slice(cursor)
  return { code: out, edits, deps: [...deps], dynamicDeps: [...dynamicDeps] }
}

/** The map from the rewritten code back to the input, built from the edits `rewriteModule` made. */
export function mapOfEdits(
  filename: string,
  code: string,
  edits: readonly RunnerEdit[],
): ReturnType<MagicString['generateMap']> {
  const magic = new MagicString(code)
  for (const edit of edits) {
    if (edit.start === edit.end) continue
    if (edit.text === '') magic.remove(edit.start, edit.end)
    else magic.overwrite(edit.start, edit.end, edit.text)
  }
  for (const edit of edits) {
    if (edit.start === edit.end) magic.appendLeft(edit.start, edit.text)
  }
  return magic.generateMap({ source: filename, hires: 'boundary' })
}
