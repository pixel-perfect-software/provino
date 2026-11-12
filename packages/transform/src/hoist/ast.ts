// Small readers over oxc's ESTree AST, shared by the hoist engine's files.
import type {
  Argument,
  ArrowFunctionExpression,
  CallExpression,
  ExportNamedDeclaration,
  ExportSpecifier,
  Expression,
  Function as FunctionExpression,
  ImportDeclaration,
  ImportDeclarationSpecifier,
  ModuleExportName,
  Node,
  Program,
} from 'oxc-parser'

export type {
  CallExpression,
  ExportNamedDeclaration,
  ExportSpecifier,
  Expression,
  ImportDeclaration,
  ImportDeclarationSpecifier,
  ModuleExportName,
  Node,
  Program,
}

/** A function expression a factory can be: `() => …` or `function () {…}`. */
export type FactoryFunction = ArrowFunctionExpression | FunctionExpression

/** The string a string literal holds, or `null` for anything else. */
export function stringLiteral(node: Node | null | undefined): string | null {
  if (node?.type !== 'Literal') return null
  const value: unknown = node.value
  return typeof value === 'string' ? value : null
}

/** Babel's `isLiteral`: any literal, a template literal included. */
export function isLiteral(node: Node): boolean {
  return node.type === 'Literal' || node.type === 'TemplateLiteral'
}

export function isFactoryFunction(node: Node | undefined): node is FactoryFunction {
  return node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression'
}

/** `obj.method(...)` with a plain identifier method name. */
export function staticCallee(
  call: CallExpression,
): { readonly object: Expression; readonly method: string } | null {
  const callee = call.callee
  if (callee.type !== 'MemberExpression' || callee.computed) return null
  // `vi?.mock()` and `vi.mock?.()` may not run at all, so neither real hoister touches them.
  if (call.optional || callee.optional) return null
  if (callee.property.type !== 'Identifier') return null
  return { object: callee.object, method: callee.property.name }
}

/** The name a module export is known by, whether written as an identifier or a string. */
export function exportName(node: ModuleExportName): string {
  if (node.type === 'Literal') return String(node.value)
  return node.name
}

/** The specifier a mock call names, in any form a hoister can read it from. */
export function staticSpecifier(node: Argument | undefined): string | null {
  let current: Node | undefined = node
  if (current?.type === 'AwaitExpression') current = current.argument
  if (current?.type === 'ImportExpression') current = current.source
  const text = stringLiteral(current)
  if (text !== null) return text
  if (current?.type === 'TemplateLiteral' && current.expressions.length === 0) {
    return current.quasis[0]?.value.cooked ?? null
  }
  return null
}

/** `import('./x')` or `await import('./x')`, as an argument. */
export function importArgument(node: Argument | undefined): Expression | null {
  if (node?.type === 'ImportExpression') return node.source
  if (node?.type === 'AwaitExpression' && node.argument.type === 'ImportExpression') {
    return node.argument.source
  }
  return null
}

export function isImportDeclaration(node: Node): node is ImportDeclaration {
  return node.type === 'ImportDeclaration'
}

/** Whether a statement is a directive such as `'use strict'`. */
export function isDirective(node: Node): boolean {
  return node.type === 'ExpressionStatement' && 'directive' in node && node.directive != null
}

/** The identifiers a binding pattern or assignment target writes; member targets write none. */
export function targetNames(node: Node | null, into: string[] = []): string[] {
  switch (node?.type) {
    case 'Identifier':
      into.push(node.name)
      break
    case 'ArrayPattern':
      for (const element of node.elements) targetNames(element, into)
      break
    case 'ObjectPattern':
      for (const property of node.properties) {
        targetNames(property.type === 'Property' ? property.value : property, into)
      }
      break
    case 'AssignmentPattern':
      targetNames(node.left, into)
      break
    case 'RestElement':
      targetNames(node.argument, into)
      break
    default:
      break
  }
  return into
}

/** The names a statement or expression reassigns, as Babel's `binding.constant` counts them. */
export function reassignedNames(node: Node): readonly string[] {
  switch (node.type) {
    case 'AssignmentExpression':
      return targetNames(node.left)
    case 'UpdateExpression':
      return targetNames(node.argument)
    case 'ForInStatement':
    case 'ForOfStatement': {
      const { left } = node
      if (left.type !== 'VariableDeclaration') return targetNames(left)
      // A `var` head writes the function's binding on every turn; `let` and `const` are new ones.
      if (left.kind !== 'var') return []
      return left.declarations.flatMap((declarator) => targetNames(declarator.id))
    }
    default:
      return []
  }
}

/** The statements directly inside a `Program` or `BlockStatement`. */
export function bodyOf(container: Node): readonly Node[] {
  if (container.type === 'Program' || container.type === 'BlockStatement') return container.body
  return []
}

/** Whether an import or export declaration is `import type` / `export type`. */
export function isTypeOnly(node: Node): boolean {
  return (
    ('importKind' in node && node.importKind === 'type') ||
    ('exportKind' in node && node.exportKind === 'type')
  )
}
