// What a transform record says about a module's imports (Track 3 R1 step 5): import records from
// oxc-parser's module record, plus `require('x')` calls and top-level await, which need the AST.
// The AST is only walked when a cheap substring check says it can matter.
import type { ImportRecord } from '@provino/types'
import { type ParserOptions, parseSync, rawTransferSupported } from 'oxc-parser'

export interface ModuleFacts {
  readonly imports: readonly ImportRecord[]
  readonly hasModuleSyntax: boolean
  readonly hasTopLevelAwait: boolean
  /**
   * Whether a file with no module syntax shows it is CommonJS: a `require(…)` call, or a member of
   * `module` or `exports`. Read only for such a file, so a file with `import` syntax pays nothing.
   */
  readonly hasCommonJsSyntax: boolean
}

const RAW_TRANSFER = rawTransferSupported()

/** The value of a string literal or a template with no substitutions, from its source text. */
function literalValue(text: string): string | null {
  const quote = text[0]
  if ((quote === '"' || quote === "'" || quote === '`') && text.at(-1) === quote) {
    const body = text.slice(1, -1)
    if (quote === '`' && body.includes('${')) return null
    return body
  }
  return null
}

interface Node {
  readonly type?: unknown
  readonly [key: string]: unknown
}

function isNode(value: unknown): value is Node {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const FUNCTION_TYPES: ReadonlySet<unknown> = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
])

/** Depth-first walk over ESTree nodes; `enter` returns `false` to skip a node's children. */
function walk(root: unknown, enter: (node: Node) => boolean): void {
  const stack: unknown[] = [root]
  while (stack.length > 0) {
    const value = stack.pop()
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) stack.push(value[i])
    } else if (isNode(value)) {
      if (typeof value.type === 'string' && !enter(value)) continue
      for (const [key, child] of Object.entries(value)) {
        if (key !== 'type' && typeof child === 'object' && child !== null) stack.push(child)
      }
    }
  }
}

function topLevelAwait(program: unknown): boolean {
  let found = false
  walk(program, (node) => {
    if (found || FUNCTION_TYPES.has(node.type)) return false
    if (
      node.type === 'AwaitExpression' ||
      (node.type === 'ForOfStatement' && node.await === true)
    ) {
      found = true
      return false
    }
    return true
  })
  return found
}

function requireCalls(program: unknown, source: string): ImportRecord[] {
  const records: ImportRecord[] = []
  walk(program, (node) => {
    if (node.type !== 'CallExpression') return true
    const callee = node.callee
    const args = node.arguments
    if (isNode(callee) && callee.type === 'Identifier' && callee.name === 'require') {
      const first: unknown = Array.isArray(args) ? args[0] : undefined
      if (isNode(first) && typeof first.start === 'number' && typeof first.end === 'number') {
        const specifier = literalValue(source.slice(first.start, first.end))
        if (specifier !== null) {
          records.push({
            specifier,
            kind: 'require',
            names: '*',
            start: first.start,
            end: first.end,
          })
        }
      }
    }
    return true
  })
  return records
}

/** Whether `program` calls `require` or reads a member of `module` or `exports`. */
function commonJsSignals(program: unknown): boolean {
  let found = false
  walk(program, (node) => {
    if (found) return false
    if (node.type === 'CallExpression') {
      const callee = node.callee
      if (isNode(callee) && callee.type === 'Identifier' && callee.name === 'require') found = true
    } else if (node.type === 'MemberExpression') {
      const object = node.object
      if (
        isNode(object) &&
        object.type === 'Identifier' &&
        (object.name === 'module' || object.name === 'exports')
      ) {
        found = true
      }
    }
    return !found
  })
  return found
}

/**
 * The module format `facts` show. A file with no module syntax that calls `require` or uses
 * `module`/`exports` is CommonJS, even when it also has an `import()`; `unknown` is left for a file
 * that shows neither. `esmByName` is a name or option that makes a file ESM without syntax (`.mts`).
 */
export function formatOf(facts: ModuleFacts, esmByName: boolean): 'esm' | 'cjs' | 'unknown' {
  return facts.hasModuleSyntax || esmByName ? 'esm' : facts.hasCommonJsSyntax ? 'cjs' : 'unknown'
}

/** Parses `source` once and reads its imports, module syntax and top-level await. */
export function moduleFacts(
  filename: string,
  source: string,
  lang: NonNullable<ParserOptions['lang']>,
  sourceType: NonNullable<ParserOptions['sourceType']>,
): ModuleFacts {
  const result = parseSync(filename, source, {
    lang,
    sourceType,
    ...(RAW_TRANSFER ? { experimentalRawTransfer: true } : {}),
  })
  const module = result.module
  const imports: ImportRecord[] = []

  for (const statement of module.staticImports) {
    const entries = statement.entries
    if (entries.length > 0 && entries.every((entry) => entry.isType)) continue
    const values = entries.filter((entry) => !entry.isType)
    const namespace = values.some((entry) => String(entry.importName.kind) === 'NamespaceObject')
    imports.push({
      specifier: statement.moduleRequest.value,
      kind: 'static',
      names: namespace
        ? '*'
        : values.map((entry) =>
            String(entry.importName.kind) === 'Default' ? 'default' : (entry.importName.name ?? ''),
          ),
      start: statement.moduleRequest.start,
      end: statement.moduleRequest.end,
    })
  }

  for (const statement of module.staticExports) {
    const request = statement.entries.find((entry) => entry.moduleRequest !== null)?.moduleRequest
    if (request === undefined || request === null) continue
    const values = statement.entries.filter((entry) => !entry.isType)
    if (values.length === 0) continue
    const star = values.some((entry) => String(entry.importName.kind) !== 'Name')
    imports.push({
      specifier: request.value,
      kind: 'reexport',
      names: star ? '*' : values.map((entry) => entry.importName.name ?? ''),
      start: request.start,
      end: request.end,
    })
  }

  for (const dynamic of module.dynamicImports) {
    const specifier = literalValue(
      source.slice(dynamic.moduleRequest.start, dynamic.moduleRequest.end),
    )
    if (specifier === null) continue
    imports.push({
      specifier,
      kind: 'dynamic',
      names: '*',
      start: dynamic.moduleRequest.start,
      end: dynamic.moduleRequest.end,
    })
  }

  // Only a file with no module syntax needs telling apart: CommonJS, or a script.
  const mayBeCommonJs =
    !module.hasModuleSyntax &&
    sourceType !== 'commonjs' &&
    (source.includes('module') || source.includes('exports') || source.includes('require'))
  const needsProgram = source.includes('require(') || source.includes('await') || mayBeCommonJs
  const program = needsProgram ? result.program : null
  if (program !== null && source.includes('require('))
    imports.push(...requireCalls(program, source))
  imports.sort((a, b) => a.start - b.start)

  return {
    imports,
    hasModuleSyntax: module.hasModuleSyntax,
    hasCommonJsSyntax:
      program !== null && mayBeCommonJs
        ? imports.some((entry) => entry.kind === 'require') || commonJsSignals(program)
        : false,
    hasTopLevelAwait:
      program !== null && sourceType !== 'commonjs' && source.includes('await')
        ? topLevelAwait(program)
        : false,
  }
}
