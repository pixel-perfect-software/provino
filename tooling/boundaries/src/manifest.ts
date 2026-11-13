import { readFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'

const RUNS_IN = ['types', 'both', 'worker', 'coordinator', 'external', 'dev'] as const

/**
 * Where a node's code runs. `external` code runs inside another tool (a linter, a codemod).
 * @public
 */
export type RunsIn = (typeof RUNS_IN)[number]

/**
 * One manifest node: a package, or a subpath entry with its own rules.
 * @public
 */
export interface ManifestNode {
  readonly name: string
  /** Repo-relative directory the node owns (`packages/core`), or `null` when not placed yet. */
  readonly dir: string | null
  readonly layer: number | 'dev' | 'tooling'
  readonly runsIn: RunsIn
  /** Nodes this node may import. `@provino/*` stands for every shipped node it may reach. */
  readonly deps: readonly string[]
  /** Policy slice names it may import, or `all` when exempt. */
  readonly slices: readonly string[] | 'all'
  readonly neutral: boolean
  /**
   * Packages its non-test files may not import at run time (T7.12): names, or `@scope/*`. A type
   * import is allowed. Empty for most nodes.
   */
  readonly bannedPackages: readonly string[]
  readonly compositionRoot: boolean
  /** The package this node is a subpath entry (or the `test/` dir) of, if any. */
  readonly parent: string | undefined
}

/**
 * The parsed manifest.
 * @public
 */
export interface Manifest {
  /** Slice name → its type name in `@provino/types`. */
  readonly slices: Readonly<Record<string, string>>
  /** Type names that carry the whole policy. */
  readonly wholePolicyTypes: readonly string[]
  /** `@provino/policy` exports that hand out the whole policy (`neutralPolicy`, `resolvePolicy`). */
  readonly wholePolicyValues: readonly string[]
  readonly nodes: readonly ManifestNode[]
}

/**
 * A boundary problem, prefixed with the rule it breaks.
 * @public
 */
export interface Problem {
  readonly rule: string
  readonly message: string
}

/**
 * Builds a `Problem`.
 * @public
 */
export function problem(rule: string, message: string): Problem {
  return { rule, message }
}

/**
 * `deps` wildcard: every shipped node in a lower layer (any layer, for dev and tooling nodes).
 * @public
 */
export const SHIPPED_WILDCARD = '@provino/*'

const NODE_KEYS: ReadonlySet<string> = new Set([
  'dir',
  'layer',
  'runsIn',
  'deps',
  'slices',
  'neutral',
  'bannedPackages',
  'compositionRoot',
  'phase',
  'note',
])

/** What each kind of node may import, by the target's `runsIn`. */
const REACHABLE: Readonly<Record<RunsIn, readonly RunsIn[]>> = {
  types: ['types'],
  both: ['types', 'both'],
  worker: ['types', 'both', 'worker'],
  coordinator: ['types', 'both', 'coordinator'],
  external: ['types', 'both', 'external'],
  dev: RUNS_IN,
}

/**
 * Reads and parses a manifest file. Shape errors throw; boundary problems come from
 * `validateManifest`.
 * @public
 */
export async function loadManifest(path: string | URL): Promise<Manifest> {
  return parseManifest(JSON.parse(await readFile(path, 'utf8')))
}

/**
 * Parses manifest JSON. Throws a `TypeError` naming the first malformed field, including an
 * unknown node key (a typo such as `"neutal"` would otherwise switch a lint off without a word).
 * @public
 */
export function parseManifest(json: unknown): Manifest {
  const root = record(json, 'manifest')
  const raw = record(root.nodes, 'nodes')
  const names = new Set(Object.keys(raw))
  return {
    slices: Object.fromEntries(
      Object.entries(record(root.slices, 'slices')).map(([name, type]) => [
        name,
        text(type, `slices.${name}`),
      ]),
    ),
    wholePolicyTypes: texts(root.wholePolicyTypes, 'wholePolicyTypes'),
    wholePolicyValues: texts(root.wholePolicyValues, 'wholePolicyValues'),
    nodes: Object.entries(raw).map(([name, value]) => parseNode(name, value, names)),
  }
}

function parseNode(name: string, value: unknown, names: ReadonlySet<string>): ManifestNode {
  const at = `nodes["${name}"]`
  const node = record(value, at)
  for (const key of Object.keys(node)) {
    if (!NODE_KEYS.has(key)) throw new TypeError(`${at}: unknown key "${key}"`)
  }
  const runsIn = text(node.runsIn, `${at}.runsIn`)
  if (!isRunsIn(runsIn)) throw new TypeError(`${at}.runsIn must be one of ${RUNS_IN.join(', ')}`)
  return {
    name,
    dir: node.dir === null ? null : text(node.dir, `${at}.dir`),
    layer: layerOf(node.layer, at),
    runsIn,
    deps: texts(node.deps, `${at}.deps`),
    slices: node.slices === 'all' ? 'all' : texts(node.slices, `${at}.slices`),
    neutral: flag(node.neutral, `${at}.neutral`),
    bannedPackages:
      node.bannedPackages === undefined ? [] : texts(node.bannedPackages, `${at}.bannedPackages`),
    compositionRoot: flag(node.compositionRoot, `${at}.compositionRoot`),
    parent: parentOf(name, names),
  }
}

/**
 * Checks the manifest's own rules: names exist, layers point down, worker and coordinator code
 * never meet, subpath entries sit inside their package and share its lint settings.
 * @public
 */
export function validateManifest(manifest: Manifest): readonly Problem[] {
  const byName = new Map(manifest.nodes.map((node) => [node.name, node]))
  return manifest.nodes.flatMap((node) => {
    const parent = node.parent === undefined ? undefined : byName.get(node.parent)
    return [
      ...(node.slices === 'all' ? [] : node.slices)
        .filter((slice) => !Object.hasOwn(manifest.slices, slice))
        .map((slice) => problem('manifest-slices', `${node.name}: unknown slice "${slice}"`)),
      ...(parent === undefined ? [] : checkSubpath(node, parent)),
      ...node.deps.flatMap((dep) => {
        if (dep === SHIPPED_WILDCARD) return []
        const target = byName.get(dep)
        if (target === undefined) {
          return [
            problem(
              'manifest-deps',
              `${node.name}: depends on "${dep}", which is not in the manifest`,
            ),
          ]
        }
        if (target === node)
          return [problem('manifest-deps', `${node.name}: lists itself as a dependency`)]
        return checkEdge(node, target)
      }),
    ]
  })
}

function checkSubpath(node: ManifestNode, parent: ManifestNode): readonly Problem[] {
  const out: Problem[] = []
  if (node.dir !== null && parent.dir !== null && !node.dir.startsWith(`${parent.dir}/`)) {
    out.push(
      problem(
        'manifest-subpath',
        `${node.name}: dir "${node.dir}" is outside ${parent.name}'s "${parent.dir}"`,
      ),
    )
  }
  if (
    !isDeepStrictEqual(node.slices, parent.slices) ||
    node.neutral !== parent.neutral ||
    !isDeepStrictEqual(node.bannedPackages, parent.bannedPackages)
  ) {
    out.push(
      problem(
        'manifest-subpath',
        `${node.name}: slices, neutral and bannedPackages must match ${parent.name}'s (one lint config per package)`,
      ),
    )
  }
  return out
}

function checkEdge(from: ManifestNode, to: ManifestNode): readonly Problem[] {
  const out: Problem[] = []
  if (typeof from.layer === 'number') {
    if (typeof to.layer !== 'number') {
      out.push(
        problem(
          'manifest-layer',
          `${from.name}: a shipped package can't depend on ${to.layer} package ${to.name}`,
        ),
      )
    } else if (to.layer > from.layer) {
      out.push(
        problem(
          'manifest-layer',
          `${from.name} (layer ${from.layer}) can't depend on ${to.name} (layer ${to.layer}): layers point down`,
        ),
      )
    }
  }
  if (!from.compositionRoot && !REACHABLE[from.runsIn].includes(to.runsIn)) {
    out.push(
      problem(
        'manifest-runs-in',
        `${from.name} (runs in ${from.runsIn}) can't depend on ${to.name} (runs in ${to.runsIn})`,
      ),
    )
  }
  return out
}

/**
 * The nodes `node` may import, with the wildcard expanded.
 * @public
 */
export function allowedDeps(manifest: Manifest, node: ManifestNode): readonly ManifestNode[] {
  const lowerShipped = (target: ManifestNode): boolean =>
    typeof target.layer === 'number' &&
    (typeof node.layer !== 'number' || target.layer < node.layer)
  const out = new Map<string, ManifestNode>()
  for (const dep of node.deps) {
    const found =
      dep === SHIPPED_WILDCARD
        ? manifest.nodes.filter(lowerShipped)
        : manifest.nodes.filter((target) => target.name === dep)
    for (const target of found) out.set(target.name, target)
  }
  return [...out.values()]
}

/**
 * A package's subpath entries (and, after `withTestNodes`, its `test/` node).
 * @public
 */
export function entriesOf(manifest: Manifest, node: ManifestNode): readonly ManifestNode[] {
  return manifest.nodes.filter((child) => child.parent === node.name)
}

/**
 * Everything a package may import across all its entries: the package node's own allowed deps
 * plus each entry's.
 * @public
 */
export function packageReach(manifest: Manifest, node: ManifestNode): readonly ManifestNode[] {
  const reach = new Map<string, ManifestNode>()
  for (const entry of [node, ...entriesOf(manifest, node)]) {
    for (const dep of allowedDeps(manifest, entry)) reach.set(dep.name, dep)
  }
  return [...reach.values()]
}

/**
 * The manifest with a `<package>/test` node for each placed package that has subpath entries.
 * Those tests import the package's entries, which the package node itself may not, so they get
 * the package's whole reach plus its entries. A package without entries keeps its tests.
 * @public
 */
export function withTestNodes(manifest: Manifest): Manifest {
  const tests = manifest.nodes.flatMap((node): ManifestNode[] => {
    const entries = entriesOf(manifest, node)
    if (node.parent !== undefined || node.dir === null || entries.length === 0) return []
    const deps = [node, ...entries, ...packageReach(manifest, node)].map((dep) => dep.name)
    return [
      {
        ...node,
        name: `${node.name}/test`,
        dir: `${node.dir}/test`,
        runsIn: 'dev',
        deps: [...new Set(deps)],
        parent: node.name,
      },
    ]
  })
  return { ...manifest, nodes: [...manifest.nodes, ...tests] }
}

function layerOf(value: unknown, at: string): ManifestNode['layer'] {
  if (value === 'dev' || value === 'tooling') return value
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  throw new TypeError(`${at}.layer must be a whole number, "dev" or "tooling"`)
}

function parentOf(name: string, names: ReadonlySet<string>): string | undefined {
  const cut = name.lastIndexOf('/')
  if (cut <= 0) return undefined
  const parent = name.slice(0, cut)
  return names.has(parent) ? parent : undefined
}

function isRunsIn(value: string): value is RunsIn {
  return (RUNS_IN as readonly string[]).includes(value)
}

function record(value: unknown, at: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${at} must be an object`)
  }
  return value as Readonly<Record<string, unknown>>
}

function texts(value: unknown, at: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${at} must be an array`)
  return value.map((item, i) => text(item, `${at}[${i}]`))
}

function text(value: unknown, at: string): string {
  if (typeof value !== 'string' || value === '')
    throw new TypeError(`${at} must be a non-empty string`)
  return value
}

function flag(value: unknown, at: string): boolean {
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw new TypeError(`${at} must be a boolean`)
  return value
}
