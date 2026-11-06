// The analysis half of the hoister: find the mock calls the policy hoists, check them against its
// rules, and note every reference to a static import. It edits nothing; `apply.ts` does.
//
// Two walks share one `ScopeTracker`. The first only declares (so a `jest` imported below the call,
// or a `const` declared after it, still resolves); the second, frozen, answers "what does this
// name mean here" from inside the walk.
import type { HoistPolicy, StaticMockCall, TransformDiagnostic } from '@provino/types'
import {
  getUndeclaredIdentifiersInFunction,
  isReferenceIdentifier,
  ScopeTracker,
  type ScopeTrackerNode,
  walk,
} from 'oxc-walker'
import {
  bodyOf,
  type CallExpression,
  type Expression,
  exportName,
  type FactoryFunction,
  type ImportDeclaration,
  type ImportDeclarationSpecifier,
  importArgument,
  isDirective,
  isFactoryFunction,
  isLiteral,
  type Node,
  type Program,
  staticCallee,
  staticSpecifier,
  stringLiteral,
} from './ast.ts'
import { type DiagnosticVars, hoistDiagnostic, positionOf } from './diagnostics.ts'
import { isPure } from './purity.ts'

/** A statement that moves: a call, or a pure `const` a factory reads. */
export interface Unit {
  readonly stmt: Node
  /** The `Program` or `BlockStatement` it moves to the top of. */
  readonly container: Node
  readonly kind: 'const' | 'call'
  /** Source text of an `if (guard)` to wrap the statement in, or `null`. */
  readonly guard: string | null
}

/** A use of a static import's binding. */
export interface ImportRef {
  readonly node: Node
  readonly start: number
  readonly end: number
  readonly shorthand: boolean
  readonly decl: ImportDeclaration
  readonly spec: ImportDeclarationSpecifier
  /** Set when the use is `export { x }`: the specifier to rewrite. */
  readonly exportSpecifier: Node | null
}

export interface ArgEdit {
  readonly start: number
  readonly end: number
  readonly text: string
}

export interface Analysis {
  readonly units: readonly Unit[]
  readonly staticMocks: readonly StaticMockCall[]
  readonly diagnostics: readonly TransformDiagnostic[]
  readonly argEdits: readonly ArgEdit[]
  readonly refs: readonly ImportRef[]
}

const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/

/** Whether `name` appears in `text` as a whole identifier, not inside a longer one. */
function occursAsIdentifier(text: string, name: string): boolean {
  for (let at = text.indexOf(name); at !== -1; at = text.indexOf(name, at + 1)) {
    const before = text[at - 1]
    const after = text[at + name.length]
    if (
      (before === undefined || !IDENTIFIER_CHAR.test(before)) &&
      (after === undefined || !IDENTIFIER_CHAR.test(after))
    ) {
      return true
    }
  }
  return false
}

const ORIGINAL_LOADER = /\b(?:import|require)(?:Actual|Original)\b/

interface Candidate {
  readonly call: CallExpression
  readonly callText: string
  readonly isValue: boolean
  readonly moveStart: number
  readonly moveEnd: number
  readonly unit: Unit | null
}

/**
 * @param rewritable the static imports (not the runner's) whose uses are collected as refs.
 */
export function analyse(
  code: string,
  program: Program,
  policy: HoistPolicy,
  rewritable: ReadonlySet<ImportDeclaration>,
  original?: string,
): Analysis {
  const tracker = new ScopeTracker({ preserveExitedScopes: true })
  const assigned = new Set<string>()
  walk(program, {
    scopeTracker: tracker,
    enter(node) {
      if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier') {
        assigned.add(node.left.name)
      } else if (node.type === 'UpdateExpression' && node.argument.type === 'Identifier') {
        assigned.add(node.argument.name)
      } else if (
        (node.type === 'ForInStatement' || node.type === 'ForOfStatement') &&
        node.left.type === 'Identifier'
      ) {
        assigned.add(node.left.name)
      }
    },
  })
  tracker.freeze()

  const diagnostics: TransformDiagnostic[] = []
  const units: Unit[] = []
  const unitStatements = new Set<Node>()
  const mockCalls: CallExpression[] = []
  const candidates: Candidate[] = []
  const argEdits: ArgEdit[] = []
  const refs: ImportRef[] = []
  const refStarts = new Set<number>()
  const stack: Node[] = []
  const factory = policy.factoryReferences
  const topLevelOnly = policy.placement === 'top-level-only'

  function report(
    errorCode: Parameters<typeof hoistDiagnostic>[3],
    offset: number,
    vars: DiagnosticVars,
  ): void {
    diagnostics.push(hoistDiagnostic(policy, code, offset, errorCode, vars))
  }

  function declarationOf(name: string): ScopeTrackerNode | null {
    return tracker.getDeclaration(name)
  }

  function importOf(
    name: string,
  ): { decl: ImportDeclaration; spec: ImportDeclarationSpecifier } | null {
    const found = declarationOf(name)
    if (found?.type !== 'Import') return null
    return { decl: found.importNode, spec: found.node }
  }

  function isMockObject(expr: Expression): boolean {
    if (expr.type === 'Identifier') {
      for (const matcher of policy.objects) {
        if (matcher.kind === 'global') {
          if (matcher.name === expr.name && declarationOf(expr.name) === null) return true
        } else if (matcher.kind === 'name') {
          if (matcher.name === expr.name) return true
        } else if (matcher.kind === 'import') {
          const found = importOf(expr.name)
          if (
            found !== null &&
            found.decl.source.value === matcher.module &&
            found.spec.type === 'ImportSpecifier' &&
            exportName(found.spec.imported) === matcher.exportName
          ) {
            return true
          }
        }
      }
      return false
    }
    if (
      expr.type === 'MemberExpression' &&
      !expr.computed &&
      expr.object.type === 'Identifier' &&
      expr.property.type === 'Identifier'
    ) {
      const property = expr.property.name
      for (const matcher of policy.objects) {
        if (matcher.kind !== 'namespace-member' || matcher.exportName !== property) continue
        const found = importOf(expr.object.name)
        if (
          found !== null &&
          found.decl.source.value === matcher.module &&
          found.spec.type === 'ImportNamespaceSpecifier'
        ) {
          return true
        }
      }
    }
    return false
  }

  const purity = {
    isConstantBinding(name: string): boolean {
      const found = declarationOf(name)
      if (found === null) return false
      if (found.type === 'Variable' && found.variableNode.kind === 'const') return true
      return !assigned.has(name)
    },
    hasBinding(name: string): boolean {
      return declarationOf(name) !== null
    },
  }

  function nearestContainer(): Node | null {
    for (let i = stack.length - 1; i >= 0; i--) {
      const node = stack[i]
      if (node?.type === 'BlockStatement' || node?.type === 'Program') return node
    }
    return null
  }

  /** Jest's check that a factory only reads what a hoisted call can safely see. */
  function checkFactory(call: CallExpression, fn: FactoryFunction, callText: string): boolean {
    if (factory === 'allow') return true
    const scopeKey = tracker.getCurrentScope()
    for (const name of getUndeclaredIdentifiersInFunction(fn)) {
      const found = declarationOf(name)
      if ((found === null && factory.allowGlobals.has(name)) || factory.allowPattern.test(name)) {
        continue
      }
      // A name the transform made up is not one the author wrote, so it cannot be out of scope.
      if (original !== undefined && !occursAsIdentifier(original, name)) continue
      if (found?.type === 'Variable' && found.scope === scopeKey && factory.hoistPureConsts) {
        const declaration = found.variableNode
        const declarator = declaration.declarations.find(
          (d) => d.id.start <= found.node.start && found.node.end <= d.id.end,
        )
        if (declarator !== undefined && declarator.init !== null) {
          if (isPure(declarator.init, purity) && purity.isConstantBinding(name)) {
            const container = nearestContainer()
            if (
              container !== null &&
              declaration.declarations.length === 1 &&
              bodyOf(container).includes(declaration) &&
              !unitStatements.has(declaration)
            ) {
              unitStatements.add(declaration)
              units.push({ stmt: declaration, container, kind: 'const', guard: null })
            }
            continue
          }
        }
      } else if (found?.type === 'Import' && found.scope === scopeKey) {
        const spec = found.node
        if (
          spec.type === 'ImportSpecifier' &&
          policy.objects.some(
            (matcher) =>
              matcher.kind === 'import' &&
              matcher.module === found.importNode.source.value &&
              matcher.exportName === exportName(spec.imported),
          )
        ) {
          continue
        }
      }
      report('HOIST_FACTORY_OUT_OF_SCOPE', firstReference(fn, name), { call: callText, name })
      return false
    }
    void call
    return true
  }

  function firstReference(fn: FactoryFunction, name: string): number {
    let offset = fn.start
    let found = false
    walk(fn, {
      enter(node, parent) {
        if (!found && node.type === 'Identifier' && node.name === name) {
          if (isReferenceIdentifier(node, parent)) {
            offset = node.start
            found = true
          }
        }
      },
    })
    return offset
  }

  /** Whether the call's arguments satisfy the policy's rule for its method. */
  function argumentsHoistable(call: CallExpression, method: string, callText: string): boolean {
    if (policy.hoistValues.includes(method)) return true
    if (!Object.hasOwn(policy.hoistCalls, method)) return false
    const rule = policy.hoistCalls[method]
    const args = call.arguments
    switch (rule) {
      case 'any':
        return true
      case 'no-args':
        return args.length === 0
      case 'one-string':
        return args.length === 1 && stringLiteral(args[0]) !== null
      case 'path-factory-options': {
        const first = args[0]
        if (args.length === 1) return first !== undefined && isLiteral(first)
        if (args.length === 2 || args.length === 3) {
          const fn = args[1]
          if (!isFactoryFunction(fn)) {
            report('HOIST_FACTORY_NOT_FUNCTION', args[1]?.start ?? call.start, { call: callText })
            return false
          }
          return checkFactory(call, fn, callText)
        }
        return false
      }
      default:
        return false
    }
  }

  function callTextOf(call: CallExpression, method: string, object: Expression): string {
    void call
    return `${code.slice(object.start, object.end)}.${method}`
  }

  /** The calls of `jest.a().b()` when every one hoists, else `null`. */
  function resolveChain(call: CallExpression): CallExpression[] | null {
    const callee = staticCallee(call)
    if (callee === null) return null
    let calls: CallExpression[] = []
    if (!isMockObject(callee.object)) {
      if (!policy.chainable || callee.object.type !== 'CallExpression') return null
      const inner = resolveChain(callee.object)
      if (inner === null) return null
      calls = inner
    }
    // Important, as upstream: the arguments are checked last, and only once we know the call is on
    // the mock object, because checking can report an error.
    if (!argumentsHoistable(call, callee.method, callTextOf(call, callee.method, callee.object))) {
      return null
    }
    calls.push(call)
    return calls
  }

  function at(back: number): Node | undefined {
    return stack[stack.length - 1 - back]
  }

  /** Top-level-only placement: where does the statement for this call sit, and is that allowed? */
  function topLevelCandidate(call: CallExpression, method: string, object: Expression): void {
    const isValue = policy.hoistValues.includes(method)
    if (!isValue && !Object.hasOwn(policy.hoistCalls, method)) return
    const callText = callTextOf(call, method, object)
    if (!isValue && !argumentsHoistable(call, method, callText)) return

    // `const x = call`, `const x = await call`: the declaration moves, not the call.
    let wrapped: Node = call
    let up = 1
    if (at(1)?.type === 'AwaitExpression') {
      wrapped = at(1) as Node
      up = 2
    }
    const declarator = at(up)
    const declaration = at(up + 1)
    const declared =
      declarator?.type === 'VariableDeclarator' &&
      declarator.init === wrapped &&
      declaration?.type === 'VariableDeclaration' &&
      declaration.declarations[0] === declarator
        ? declaration
        : null

    const asDefaultExport =
      (at(1)?.type === 'ExportDefaultDeclaration' && at(1) !== undefined) ||
      (at(1)?.type === 'AwaitExpression' && at(2)?.type === 'ExportDefaultDeclaration')
    const exportedDeclaration =
      declared !== null &&
      stack.some((n) => n.type === 'ExportNamedDeclaration' && n.declaration === declared)
    if (asDefaultExport || exportedDeclaration) {
      report('HOIST_EXPORTED', call.start, { call: callText })
      return
    }

    const moveNode: Node = isValue ? (declared ?? wrapped) : call
    const stmt: Node | null =
      moveNode.type === 'VariableDeclaration'
        ? moveNode
        : (() => {
            const parent = stack[stack.lastIndexOf(moveNode) - 1]
            return parent?.type === 'ExpressionStatement' && parent.expression === moveNode
              ? parent
              : null
          })()

    let unit: Unit | null = null
    if (stmt !== null) {
      const index = stack.lastIndexOf(stmt)
      const container = stack[index - 1]
      if (container?.type === 'Program') {
        unit = { stmt, container, kind: 'call', guard: null }
      } else if (container?.type === 'BlockStatement') {
        const owner = stack[index - 2]
        if (owner?.type === 'IfStatement' && owner.consequent === container) {
          const guard = code.slice(owner.test.start, owner.test.end)
          if (policy.topLevelGuards.includes(guard)) {
            unit = { stmt, container: program, kind: 'call', guard }
          }
        }
      }
    }
    if (unit === null) report('HOIST_NOT_TOP_LEVEL', call.start, { call: callText })
    candidates.push({
      call,
      callText,
      isValue,
      moveStart: moveNode.start,
      moveEnd: moveNode.end,
      unit,
    })
  }

  function rewriteArgument(call: CallExpression, method: string): void {
    if (!policy.rewriteImportArg.includes(method)) return
    const first = call.arguments[0]
    const source = importArgument(first)
    if (first === undefined || source === null) return
    argEdits.push({
      start: first.start,
      end: first.end,
      text: code.slice(source.start, source.end),
    })
  }

  function recordReference(node: Node, parent: Node): void {
    if (node.type !== 'Identifier' || refStarts.has(node.start)) return
    if (!isReferenceIdentifier(node, parent)) return
    let exportSpecifier: Node | null = null
    if (parent.type === 'ExportSpecifier') {
      const owner = at(2)
      if (owner?.type !== 'ExportNamedDeclaration' || owner.source !== null) return
      exportSpecifier = parent
    }
    const found = importOf(node.name)
    if (found === null || !rewritable.has(found.decl)) return
    refStarts.add(node.start)
    refs.push({
      node,
      start: node.start,
      end: node.end,
      shorthand: parent.type === 'Property' && parent.shorthand && parent.value === node,
      decl: found.decl,
      spec: found.spec,
      exportSpecifier,
    })
  }

  walk(program, {
    scopeTracker: tracker,
    enter(node, parent) {
      stack.push(node)
      if (rewritable.size > 0 && parent !== null && node.type === 'Identifier') {
        // The stack top is the node itself, so `at(1)` is its parent and `at(2)` its grandparent.
        recordReference(node, parent)
      }
      if (node.type === 'CallExpression') {
        const callee = staticCallee(node)
        if (callee !== null && isMockObject(callee.object)) {
          rewriteArgument(node, callee.method)
          if (topLevelOnly) topLevelCandidate(node, callee.method, callee.object)
        }
      } else if (!topLevelOnly && node.type === 'ExpressionStatement') {
        const expression = node.expression
        if (expression.type !== 'CallExpression' || isDirective(node)) return
        const calls = resolveChain(expression)
        if (calls !== null && (parent?.type === 'Program' || parent?.type === 'BlockStatement')) {
          units.push({ stmt: node, container: parent, kind: 'call', guard: null })
          unitStatements.add(node)
          mockCalls.push(...calls)
        }
      }
    },
    leave() {
      stack.pop()
    },
  })

  // Top-level-only placement: nesting, then the units of the calls that passed.
  if (topLevelOnly) {
    for (let i = 0; i < candidates.length; i++) {
      const a = candidates[i]
      if (a === undefined) continue
      for (let j = i + 1; j < candidates.length; j++) {
        const b = candidates[j]
        if (b === undefined) continue
        if (a.moveStart >= b.moveStart && a.moveEnd <= b.moveEnd) {
          report('HOIST_NESTED', a.call.start, { call: a.callText })
        } else if (b.moveStart >= a.moveStart && b.moveEnd <= a.moveEnd) {
          report('HOIST_NESTED', b.call.start, { call: b.callText })
        }
      }
    }
    for (const candidate of candidates) {
      if (candidate.unit === null || unitStatements.has(candidate.unit.stmt)) continue
      unitStatements.add(candidate.unit.stmt)
      units.push(candidate.unit)
      if (!candidate.isValue) mockCalls.push(candidate.call)
    }
  }

  const staticMocks: StaticMockCall[] = []
  for (const call of mockCalls.toSorted((a, b) => a.start - b.start)) {
    const callee = staticCallee(call)
    const specifier = staticSpecifier(call.arguments[0])
    if (callee === null || specifier === null) continue
    if (policy.hoistValues.includes(callee.method)) continue
    const fn = call.arguments[1]
    const factoryFn = isFactoryFunction(fn) ? fn : null
    const hasFactory = factoryFn !== null
    staticMocks.push({
      method: callee.method,
      specifier,
      hasFactory,
      automock: call.arguments.length === 1,
      factoryLoadsOriginal:
        factoryFn !== null &&
        (factoryFn.params.length > 0 ||
          ORIGINAL_LOADER.test(code.slice(factoryFn.start, factoryFn.end))),
      loc: positionOf(code, call.start),
    })
  }

  return { units, staticMocks, diagnostics, argEdits, refs }
}
