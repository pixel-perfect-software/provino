// `oxc-walker`'s `ScopeTracker` with two scopes it merges kept apart, so every question asked of it
// gets the language's answer. A `var` belongs to the function's body, not the scope its parameters
// have: a parameter default can't see it. A `switch`'s scope opens at its first case: the discriminant
// can't see what the cases declare.
//
// This relies on protected members of the pinned oxc-walker 1.1.1 (`scopeOwnerStack`, `pushScope`,
// `getScopeKeyAt`, `getVarScopeKey`, `processNodeEnter`, `processNodeLeave`). The hoist corpus catches
// a break when the pin moves. `getUndeclaredIdentifiersInFunction` keeps the merged scope on purpose:
// Babel has the same merge there, so `(a = k) => { var k }` reads no outer `k` in either.
//
// Babel keeps parameters and body in one scope too, and a discriminant and cases. Its `getBinding`
// looks past the body from a parameter default, but its `hasBinding` doesn't, so a question that is
// `hasBinding` upstream asks `isDeclaredInMergedScope` as well.
import { ScopeTracker, type ScopeTrackerNode } from 'oxc-walker'
import type { Node } from './ast.ts'

function isBodyOf(fn: Node | undefined, block: Node): boolean {
  return (
    (fn?.type === 'FunctionDeclaration' ||
      fn?.type === 'FunctionExpression' ||
      fn?.type === 'ArrowFunctionExpression') &&
    fn.body === block
  )
}

function parentScope(key: string): string {
  return key.slice(0, Math.max(0, key.lastIndexOf('-')))
}

/** Answers "what does this name mean here". Declare in one walk, `freeze()`, and ask in another. */
export class HoistScopes extends ScopeTracker {
  /** The `switch` statements being walked, innermost last. */
  readonly #switches: Node[] = []
  /** The scope of a function's body or a `switch`'s cases, by that function or `switch`. */
  readonly #separated = new Map<Node, string>()
  readonly #redeclared = new Set<Node>()

  constructor() {
    super({ preserveExitedScopes: true })
    // Both are instance fields on the base class, so `super` can't reach them.
    const enter = this.processNodeEnter
    const leave = this.processNodeLeave
    this.processNodeEnter = (node) => {
      if (node.type === 'SwitchStatement') {
        this.#switches.push(node)
      } else if (node.type === 'SwitchCase') {
        const owner = this.#switches.at(-1)
        if (owner !== undefined && this.scopeOwnerStack.at(-1) !== owner) this.pushScope(owner)
      } else {
        enter(node)
      }
    }
    this.processNodeLeave = (node) => {
      leave(node)
      if (node.type === 'SwitchStatement') this.#switches.pop()
    }
  }

  /** Whether a function or `switch` around here declares `name` in the scope kept apart from it. */
  isDeclaredInMergedScope(name: string): boolean {
    for (const owner of [...this.scopeOwnerStack, ...this.#switches]) {
      const key = this.#separated.get(owner)
      if (key !== undefined && this.scopes.get(key)?.has(name) === true) return true
    }
    return false
  }

  protected override pushScope(owner: Node): void {
    const around = this.scopeOwnerStack.at(-1)
    super.pushScope(owner)
    if (owner.type === 'SwitchStatement') this.#separated.set(owner, this.scopeIndexKey)
    else if (around !== undefined && isBodyOf(around, owner)) {
      this.#separated.set(around, this.scopeIndexKey)
    }
  }

  /** Whether this is the last of several `var`s of one name in one scope: Babel counts that a write. */
  isRedeclared(found: ScopeTrackerNode): boolean {
    return this.#redeclared.has(found.node)
  }

  /**
   * Babel holds one binding for `function f(k) { var k }` and `(function k() { var k })`, the first
   * one's, so such a `var` declares nothing here.
   */
  protected override declareIdentifier(
    name: string,
    data: ScopeTrackerNode,
    namespaces?: { value?: boolean; type?: boolean },
  ): void {
    if (data.type === 'Variable' && data.variableNode.kind === 'var' && !this.isFrozen) {
      const params = parentScope(data.scope)
      if (this.scopes.get(params)?.get(name)?.type === 'FunctionParam') return
      const named = this.scopes.get(parentScope(params))?.get(name)
      if (named?.type === 'Function' && named.node.type === 'FunctionExpression') return
      // The base class declares a `for` head's `var` twice, from the loop and from the declaration.
      const earlier = this.scopes.get(data.scope)?.get(name)
      if (earlier?.type === 'Variable' && earlier.node !== data.node) {
        this.#redeclared.add(data.node)
      }
    }
    super.declareIdentifier(name, data, namespaces)
  }

  protected override getVarScopeKey(): string {
    const owners = this.scopeOwnerStack
    for (let i = owners.length - 1; i >= 0; i--) {
      const owner = owners[i]
      if (owner === undefined) continue
      if (
        owner.type === 'Program' ||
        owner.type === 'StaticBlock' ||
        owner.type === 'TSModuleBlock' ||
        isBodyOf(owners[i - 1], owner)
      ) {
        return this.getScopeKeyAt(i)
      }
    }
    return ''
  }
}
