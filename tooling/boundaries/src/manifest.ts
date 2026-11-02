import { readFile } from 'node:fs/promises'

/**
 * Where a node's code runs. `external` code runs inside another tool (a linter, a codemod).
 * @public
 */
export type RunsIn = 'types' | 'both' | 'worker' | 'coordinator' | 'external' | 'dev'

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
  readonly compositionRoot: boolean
  /** The node this one is a subpath entry of, if any. */
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
 * `deps` wildcard: every shipped node in a lower layer (any layer, for dev and tooling nodes).
 * @public
 */
export const SHIPPED_WILDCARD = '@provino/*'

const RUNS_IN: readonly RunsIn[] = ['types', 'both', 'worker', 'coordinator', 'external', 'dev']

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
 * Parses manifest JSON. Throws a `TypeError` naming the first malformed field.
 * @public
 */
export function parseManifest(json: unknown): Manifest {
  const root = record(json, 'manifest')
  const slices = Object.fromEntries(
    Object.entries(record(root.slices, 'slices')).map(([name, type]) => [
      name,
      text(type, `slices.${name}`),
    ]),
  )
  const wholePolicyTypes = list(root.wholePolicyTypes, 'wholePolicyTypes').map((type, i) =>
    text(type, `wholePolicyTypes[${i}]`),
  )
  const raw = record(root.nodes, 'nodes')
  const names = new Set(Object.keys(raw))
  const nodes = Object.entries(raw).map(([name, value]): ManifestNode => {
    const at = `nodes["${name}"]`
    const node = record(value, at)
    const layer = node.layer
    if (
      !(layer === 'dev' || layer === 'tooling' || (Number.isInteger(layer) && Number(layer) >= 0))
    ) {
      throw new TypeError(`${at}.layer must be a whole number, "dev" or "tooling"`)
    }
    const runsIn = text(node.runsIn, `${at}.runsIn`)
    if (!isRunsIn(runsIn)) throw new TypeError(`${at}.runsIn must be one of ${RUNS_IN.join(', ')}`)
    const dir = node.dir === null ? null : text(node.dir, `${at}.dir`)
    const slicesField = node.slices
    return {
      name,
      dir,
      layer: layer === 'dev' || layer === 'tooling' ? layer : Number(layer),
      runsIn,
      deps: list(node.deps, `${at}.deps`).map((dep, i) => text(dep, `${at}.deps[${i}]`)),
      slices:
        slicesField === 'all'
          ? 'all'
          : list(slicesField, `${at}.slices`).map((s, i) => text(s, `${at}.slices[${i}]`)),
      neutral: flag(node.neutral, `${at}.neutral`),
      compositionRoot: flag(node.compositionRoot, `${at}.compositionRoot`),
      parent: parentOf(name, names),
    }
  })
  return { slices, wholePolicyTypes, nodes }
}

/**
 * Checks the manifest's own rules: names exist, layers point down, worker and coordinator code
 * never meet, subpath entries sit inside their package and share its lint settings.
 * @public
 */
export function validateManifest(manifest: Manifest): readonly Problem[] {
  const problems: Problem[] = []
  const byName = new Map(manifest.nodes.map((node) => [node.name, node]))
  const sliceNames = new Set(Object.keys(manifest.slices))
  const report = (rule: string, message: string): void => {
    problems.push({ rule, message })
  }

  for (const node of manifest.nodes) {
    if (node.slices !== 'all') {
      for (const slice of node.slices) {
        if (!sliceNames.has(slice))
          report('manifest-slices', `${node.name}: unknown slice "${slice}"`)
      }
    }
    if (node.parent !== undefined) {
      const parent = byName.get(node.parent)
      if (parent !== undefined) checkSubpath(node, parent, report)
    }
    for (const dep of node.deps) {
      if (dep === SHIPPED_WILDCARD) continue
      const target = byName.get(dep)
      if (target === undefined) {
        report('manifest-deps', `${node.name}: depends on "${dep}", which is not in the manifest`)
      } else if (target === node) {
        report('manifest-deps', `${node.name}: lists itself as a dependency`)
      } else {
        checkEdge(node, target, report)
      }
    }
  }
  return problems
}

function checkSubpath(
  node: ManifestNode,
  parent: ManifestNode,
  report: (rule: string, message: string) => void,
): void {
  if (node.dir !== null && parent.dir !== null && !node.dir.startsWith(`${parent.dir}/`)) {
    report(
      'manifest-subpath',
      `${node.name}: dir "${node.dir}" is outside ${parent.name}'s "${parent.dir}"`,
    )
  }
  const sameSlices = JSON.stringify(node.slices) === JSON.stringify(parent.slices)
  if (!sameSlices || node.neutral !== parent.neutral) {
    report(
      'manifest-subpath',
      `${node.name}: slices and neutral must match ${parent.name}'s (one lint config per package)`,
    )
  }
}

function checkEdge(
  from: ManifestNode,
  to: ManifestNode,
  report: (rule: string, message: string) => void,
): void {
  if (typeof from.layer === 'number') {
    if (typeof to.layer !== 'number') {
      report(
        'manifest-layer',
        `${from.name}: a shipped package can't depend on ${to.layer} package ${to.name}`,
      )
    } else if (to.layer > from.layer) {
      report(
        'manifest-layer',
        `${from.name} (layer ${from.layer}) can't depend on ${to.name} (layer ${to.layer}): layers point down`,
      )
    }
  }
  if (!from.compositionRoot && !REACHABLE[from.runsIn].includes(to.runsIn)) {
    report(
      'manifest-runs-in',
      `${from.name} (runs in ${from.runsIn}) can't depend on ${to.name} (runs in ${to.runsIn})`,
    )
  }
}

/**
 * The nodes `node` may import, with the wildcard expanded.
 * @public
 */
export function allowedDeps(manifest: Manifest, node: ManifestNode): readonly ManifestNode[] {
  const out = new Map<string, ManifestNode>()
  for (const dep of node.deps) {
    if (dep === SHIPPED_WILDCARD) {
      for (const target of manifest.nodes) {
        const shipped = typeof target.layer === 'number'
        const reachable =
          typeof node.layer !== 'number' ||
          (typeof target.layer === 'number' && target.layer < node.layer)
        if (shipped && reachable && target !== node) out.set(target.name, target)
      }
    } else {
      const target = manifest.nodes.find((candidate) => candidate.name === dep)
      if (target !== undefined) out.set(target.name, target)
    }
  }
  return [...out.values()]
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

function list(value: unknown, at: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${at} must be an array`)
  return value
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
