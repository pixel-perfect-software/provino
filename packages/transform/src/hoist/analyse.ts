// The analysis half of the hoister: find the mock calls the policy hoists, check them against its
// rules, and note every reference to a static import. It edits nothing; `apply.ts` does.
//
// Two walks share one `HoistScopes`. The first only declares (so a `jest` imported below the call,
// or a `const` declared after it, still resolves); the second, frozen, answers "what does this
// name mean here" from inside the walk.
import type { HoistPolicy, StaticMockCall, TransformDiagnostic } from '@provino/types'
import {
  getUndeclaredIdentifiersInFunction,
  isReferenceIdentifier,
  type ScopeTrackerNode,
  type ScopeTrackerVariable,
  walk,
} from 'oxc-walker'
import { positionCursor } from '../internal/position.ts'
import {
  bodyOf,
  type CallExpression,
  type ExportNamedDeclaration,
  type ExportSpecifier,
  type Expression,
  exportName,
  type FactoryFunction,
  type ImportDeclaration,
  type ImportDeclarationSpecifier,
  importArgument,
  isDirective,
  isFactoryFunction,
  isImportDeclaration,
  isLiteral,
  isTypeOnly,
  type Node,
  type Program,
  reassignedNames,
  staticCallee,
  staticSpecifier,
  stringLiteral,
} from './ast.ts'
import { type DiagnosticVars, hoistDiagnostic } from './diagnostics.ts'
import { isPure } from './purity.ts'
import { HoistScopes } from './scope.ts'

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
  readonly start: number
  readonly end: number
  readonly shorthand: boolean
  readonly decl: ImportDeclaration
  readonly spec: ImportDeclarationSpecifier
  /** Set when the use is `export { x }`: the specifier and the declaration it sits in. */
  readonly exported: {
    readonly specifier: ExportSpecifier
    readonly declaration: ExportNamedDeclaration
  } | null
  /** It is the callee of a call or the tag of a template, so the rewrite decides its `this`. */
  readonly called: boolean
  /** It opens a statement in a statement list, so text written before it can join the last line. */
  readonly opensStatement: boolean
}

/** A `import(x)` argument to unwrap: everything in `start`-`end` but its `source`. */
export interface ArgEdit {
  readonly start: number
  readonly end: number
  readonly sourceStart: number
  readonly sourceEnd: number
}

export interface Analysis {
  readonly units: readonly Unit[]
  readonly staticMocks: readonly StaticMockCall[]
  readonly diagnostics: readonly TransformDiagnostic[]
  readonly argEdits: readonly ArgEdit[]
  readonly refs: readonly ImportRef[]
  /** The static imports whose uses move to `__provino_import_N__`: all but the runner's own. */
  readonly rewritable: ReadonlySet<ImportDeclaration>
  /** A call named in `rewriteImportArg` is on a mock object, so imports rewrite with no hoist. */
  readonly rewritesImports: boolean
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

/** Statements whose body is one statement, not a list. */
const SINGLE_STATEMENT_PARENTS: ReadonlySet<string> = new Set([
  'IfStatement',
  'LabeledStatement',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
  'WithStatement',
])

function rewritableImports(program: Program, policy: HoistPolicy): ReadonlySet<ImportDeclaration> {
  const found = new Set<ImportDeclaration>()
  for (const node of program.body) {
    if (
      isImportDeclaration(node) &&
      !isTypeOnly(node) &&
      !policy.runnerModules.includes(node.source.value)
    ) {
      found.add(node)
    }
  }
  return found
}

interface Candidate {
  readonly call: CallExpression
  readonly callText: string
  readonly isValue: boolean
  readonly moveStart: number
  readonly moveEnd: number
  readonly unit: Unit | null
}

export function analyse(
  code: string,
  program: Program,
  policy: HoistPolicy,
  original?: string,
): Analysis {
  const rewritable = rewritableImports(program, policy)
  const tracker = new HoistScopes()
  // The names something writes. Most files never ask, and most names aren't here, so which binding
  // each write reaches is only worked out if a factory reads one of these names.
  const assigned = new Set<string>()
  walk(program, {
    scopeTracker: tracker,
    enter(node) {
      for (const name of reassignedNames(node)) assigned.add(name)
    },
  })
  tracker.freeze()

  let reassignedBindings: ReadonlySet<Node> | null = null
  /** The declarations something writes to, by the node each was declared with. */
  function bindingsReassigned(): ReadonlySet<Node> {
    if (reassignedBindings !== null) return reassignedBindings
    const scopes = new HoistScopes()
    walk(program, { scopeTracker: scopes })
    scopes.freeze()
    const found = new Set<Node>()
    walk(program, {
      scopeTracker: scopes,
      enter(node) {
        for (const name of reassignedNames(node)) {
          const binding = scopes.getDeclaration(name)
          if (binding !== null) found.add(binding.node)
        }
      },
    })
    reassignedBindings = found
    return found
  }

  const importNames = new Set<string>()
  for (const declaration of rewritable) {
    for (const specifier of declaration.specifiers) importNames.add(specifier.local.name)
  }

  const diagnostics: TransformDiagnostic[] = []
  const units: Unit[] = []
  const unitStatements = new Set<Node>()
  const mockCalls: CallExpression[] = []
  const candidates: Candidate[] = []
  const argEdits: ArgEdit[] = []
  const refs: ImportRef[] = []
  const refStarts = new Set<number>()
  let rewritesImports = false
  const stack: Node[] = []
  const factory = policy.factoryReferences
  const topLevelOnly = policy.placement === 'top-level-only'

  function report(
    errorCode: Parameters<typeof hoistDiagnostic>[3],
    offset: number,
    vars: DiagnosticVars,
    text?: keyof HoistPolicy['messages'],
  ): void {
    diagnostics.push(hoistDiagnostic(policy, code, offset, errorCode, vars, text))
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
          if (
            matcher.name === expr.name &&
            declarationOf(expr.name) === null &&
            !tracker.isDeclaredInMergedScope(expr.name)
          ) {
            return true
          }
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
    if (expr.type === 'MemberExpression' && expr.object.type === 'Identifier') {
      // `G.jest` and `G['jest']` alike, as Babel's `referencesImport` reads them.
      const property = expr.computed
        ? stringLiteral(expr.property)
        : expr.property.type === 'Identifier'
          ? expr.property.name
          : null
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
      if (found === null || tracker.isRedeclared(found)) return false
      return !assigned.has(name) || !bindingsReassigned().has(found.node)
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

  /**
   * The statement that moves for the expression statement on top of the stack, as Babel's
   * `getStatementParent` finds it: the nearest one in a list, so `if (c) jest.mock('./a')` moves
   * whole. It only moves when that list is a block's, so a `switch` case stays.
   */
  function statementInBlock(): { stmt: Node; container: Node } | null {
    for (let i = stack.length - 1; i > 0; i--) {
      const stmt = stack[i]
      const parent = stack[i - 1]
      if (stmt === undefined || parent === undefined) return null
      if (parent.type === 'Program' || parent.type === 'BlockStatement') {
        return { stmt, container: parent }
      }
      if (!SINGLE_STATEMENT_PARENTS.has(parent.type)) return null
    }
    return null
  }

  /**
   * Whether a factory may read this variable because it is a pure constant. If it is, its
   * declaration moves too, unless it declares other names or isn't directly in the current block.
   */
  function hoistPureConst(name: string, found: ScopeTrackerVariable): boolean {
    const declaration = found.variableNode
    const declarator = declaration.declarations.find(
      (d) => d.id.start <= found.node.start && found.node.end <= d.id.end,
    )
    if (declarator === undefined || declarator.init === null) return false
    if (!isPure(declarator.init, purity) || !purity.isConstantBinding(name)) return false
    const container = nearestContainer()
    // `export const` moves whole, with the export.
    const stmt =
      container === null
        ? undefined
        : bodyOf(container).find(
            (node) =>
              node === declaration ||
              (node.type === 'ExportNamedDeclaration' && node.declaration === declaration),
          )
    if (
      container !== null &&
      stmt !== undefined &&
      declaration.declarations.length === 1 &&
      !unitStatements.has(stmt)
    ) {
      unitStatements.add(stmt)
      units.push({ stmt, container, kind: 'const', guard: null })
    }
    return true
  }

  /** Jest's check that a factory only reads what a hoisted call can safely see. */
  function checkFactory(fn: FactoryFunction, callText: string): boolean {
    if (factory === 'allow') return true
    const scopeKey = tracker.getCurrentScope()
    for (const name of getUndeclaredIdentifiersInFunction(fn)) {
      const found = declarationOf(name)
      if ((found === null && factory.allowGlobals.has(name)) || factory.allowPattern.test(name)) {
        continue
      }
      // A name the transform made up is not one the author wrote, so it cannot be out of scope.
      if (original !== undefined && !occursAsIdentifier(original, name)) continue
      if (
        found?.type === 'Variable' &&
        found.scope === scopeKey &&
        factory.hoistPureConsts &&
        hoistPureConst(name, found)
      ) {
        continue
      }
      if (found?.type === 'Import' && found.scope === scopeKey) {
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
          return checkFactory(fn, callText)
        }
        return false
      }
      default:
        return false
    }
  }

  function callTextOf(method: string, object: Expression): string {
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
    if (!argumentsHoistable(call, callee.method, callTextOf(callee.method, callee.object))) {
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
    const callText = callTextOf(method, object)
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
      at(1)?.type === 'ExportDefaultDeclaration' ||
      (at(1)?.type === 'AwaitExpression' && at(2)?.type === 'ExportDefaultDeclaration')
    const exportedDeclaration =
      declared !== null &&
      stack.some((n) => n.type === 'ExportNamedDeclaration' && n.declaration === declared)
    if (asDefaultExport || exportedDeclaration) {
      report(
        'HOIST_EXPORTED',
        call.start,
        { call: callText },
        isValue ? 'HOIST_EXPORTED_VALUE' : 'HOIST_EXPORTED',
      )
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
    candidates.push({
      call,
      callText,
      isValue,
      moveStart: moveNode.start,
      moveEnd: moveNode.end,
      unit,
    })
  }

  function rewriteArgument(call: CallExpression): void {
    const first = call.arguments[0]
    const source = importArgument(first)
    if (first === undefined || source === null) return
    argEdits.push({
      start: first.start,
      end: first.end,
      sourceStart: source.start,
      sourceEnd: source.end,
    })
  }

  /** Whether the use opens a statement that sits in a list of statements. */
  function opensStatement(node: Node): boolean {
    for (let i = stack.length - 1; i >= 0; i--) {
      const ancestor = stack[i]
      if (ancestor === undefined || ancestor.start !== node.start) return false
      if (ancestor.type === 'ExpressionStatement') {
        const list = stack[i - 1]?.type
        return (
          list === 'Program' ||
          list === 'BlockStatement' ||
          list === 'StaticBlock' ||
          list === 'SwitchCase'
        )
      }
    }
    return false
  }

  function recordReference(node: Node, parent: Node): void {
    if (node.type !== 'Identifier' || !importNames.has(node.name)) return
    if (refStarts.has(node.start) || !isReferenceIdentifier(node, parent)) return
    let exported: ImportRef['exported'] = null
    if (parent.type === 'ExportSpecifier') {
      const owner = at(2)
      if (owner?.type !== 'ExportNamedDeclaration' || owner.source !== null) return
      exported = { specifier: parent, declaration: owner }
    }
    refStarts.add(node.start)
    const found = declarationOf(node.name)
    if (found?.type !== 'Import' || !rewritable.has(found.importNode)) return
    const called =
      (parent.type === 'CallExpression' && parent.callee === node) ||
      (parent.type === 'TaggedTemplateExpression' && parent.tag === node)
    refs.push({
      start: node.start,
      end: node.end,
      shorthand: parent.type === 'Property' && parent.shorthand && parent.value === node,
      exported,
      called,
      opensStatement: called && opensStatement(node),
      decl: found.importNode,
      spec: found.node,
    })
  }

  /** Why `getNodeName` in `hoistMocks.ts` L466-L481 names a call the way it does. */
  function nameWithArgument(call: CallExpression): string {
    const callee = staticCallee(call)
    if (callee === null || callee.object.type !== 'Identifier') return '"hoisted method"'
    const argument = call.arguments[0]
    const text =
      argument?.type === 'Literal' || argument?.type === 'ImportExpression'
        ? code.slice(argument.start, argument.end)
        : ''
    return `${callee.object.name}.${callee.method}(${text})`
  }

  walk(program, {
    scopeTracker: tracker,
    enter(node, parent) {
      stack.push(node)
      if (parent !== null && node.type === 'Identifier') {
        // The stack top is the node itself, so `at(1)` is its parent and `at(2)` its grandparent.
        recordReference(node, parent)
      }
      if (node.type === 'CallExpression') {
        const callee = staticCallee(node)
        if (callee !== null && isMockObject(callee.object)) {
          if (policy.rewriteImportArg.includes(callee.method)) {
            rewritesImports = true
            rewriteArgument(node)
          }
          if (topLevelOnly) topLevelCandidate(node, callee.method, callee.object)
        }
      } else if (!topLevelOnly && node.type === 'ExpressionStatement') {
        const expression = node.expression
        if (expression.type !== 'CallExpression' || isDirective(node)) return
        const calls = resolveChain(expression)
        const home = calls === null ? null : statementInBlock()
        if (calls !== null && home !== null) {
          if (!unitStatements.has(home.stmt)) {
            units.push({ ...home, kind: 'call', guard: null })
            unitStatements.add(home.stmt)
          }
          // Under an `if` or a label it moves, but whether it runs is only known when that does.
          if (home.stmt === node) mockCalls.push(...calls)
        }
      }
    },
    leave() {
      stack.pop()
    },
  })

  // Top-level-only placement: nesting first, as upstream throws it first; then placement; then the
  // units of the calls that passed.
  if (topLevelOnly) {
    const reportNested = (inner: Candidate, outer: Candidate): void => {
      report('HOIST_NESTED', inner.call.start, {
        call: nameWithArgument(inner.call),
        name: nameWithArgument(outer.call),
      })
    }
    for (let i = 0; i < candidates.length; i++) {
      const a = candidates[i]
      if (a === undefined) continue
      for (let j = i + 1; j < candidates.length; j++) {
        const b = candidates[j]
        if (b === undefined) continue
        if (a.moveStart >= b.moveStart && a.moveEnd <= b.moveEnd) {
          reportNested(a, b)
        } else if (b.moveStart >= a.moveStart && b.moveEnd <= a.moveEnd) {
          reportNested(b, a)
        }
      }
    }
    for (const candidate of candidates) {
      if (candidate.unit === null) {
        report('HOIST_NOT_TOP_LEVEL', candidate.call.start, { call: candidate.callText })
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
  const positionAt = positionCursor(code)
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
      loc: positionAt(call.start),
    })
  }

  return { units, staticMocks, diagnostics, argEdits, refs, rewritable, rewritesImports }
}
