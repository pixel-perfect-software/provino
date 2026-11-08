// Babel's `scope.isPure(node, constantsOnly = true)`, which decides whether a `const` a mock
// factory reads can be hoisted along with the call (`hoistPureConsts`). An identifier is pure when
// it names a constant binding; calls, `new`, member access, conditionals and the like are not.
import type { Node } from './ast.ts'

export interface PurityScope {
  /** Whether `name` resolves to a binding that is never reassigned. */
  isConstantBinding(name: string): boolean
  /** Whether `name` resolves to any binding. */
  hasBinding(name: string): boolean
}

export function isPure(node: Node | null, scope: PurityScope): boolean {
  if (node === null) return true
  switch (node.type) {
    case 'Literal':
      return !('regex' in node && node.regex != null)
    case 'Identifier':
      return scope.isConstantBinding(node.name)
    case 'ThisExpression':
    case 'Super':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return true
    case 'TemplateLiteral':
      return node.expressions.every((expression) => isPure(expression, scope))
    case 'UnaryExpression':
      return isPure(node.argument, scope)
    case 'BinaryExpression':
    case 'LogicalExpression':
      return isPure(node.left, scope) && isPure(node.right, scope)
    case 'ArrayExpression':
      return node.elements.every((element) => element === null || isPure(element, scope))
    case 'ObjectExpression':
      return node.properties.every((property) => {
        if (property.type !== 'Property') return false
        if (property.kind === 'get' || property.kind === 'set') return false
        if (property.computed && !isPure(property.key, scope)) return false
        return property.method || isPure(property.value, scope)
      })
    case 'TaggedTemplateExpression': {
      const tag = node.tag
      const isStringRaw =
        tag.type === 'MemberExpression' &&
        !tag.computed &&
        tag.object.type === 'Identifier' &&
        tag.object.name === 'String' &&
        tag.property.type === 'Identifier' &&
        tag.property.name === 'raw'
      return isStringRaw && !scope.hasBinding('String') && isPure(node.quasi, scope)
    }
    case 'ClassExpression': {
      if (node.decorators.length > 0) return false
      if (node.superClass !== null && !isPure(node.superClass, scope)) return false
      return node.body.body.every((member) => {
        if (member.type === 'StaticBlock') return false
        if ('decorators' in member && member.decorators.length > 0) return false
        if ('computed' in member && member.computed && !isPure(member.key, scope)) return false
        if (member.type === 'PropertyDefinition' && member.static)
          return isPure(member.value, scope)
        return true
      })
    }
    default:
      return false
  }
}
