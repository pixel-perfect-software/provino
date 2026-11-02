import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { allowedDeps, type Manifest, type ManifestNode, type Problem } from './manifest.ts'

/**
 * A workspace package as its files declare it.
 * @public
 */
export interface WorkspacePackage {
  /** Repo-relative directory, e.g. `packages/core`. */
  readonly dir: string
  readonly name: string
  /** Every package it depends on, of any dependency kind. */
  readonly deps: readonly string[]
  /** The package.json `exports` field, as written. */
  readonly exports: unknown
  /** The package.json `test` script, if any. */
  readonly testScript: string | undefined
  /** How many `*.test.ts` files sit under `src/`. */
  readonly unitTests: number
  readonly hasTsconfig: boolean
  readonly hasTypeTests: boolean
}

/**
 * The workspace: its root directories, packages, and the solution tsconfigs' references.
 * @public
 */
export interface Workspace {
  /** Directories from `pnpm-workspace.yaml` `packages:` (`packages/*` → `packages`). */
  readonly roots: readonly string[]
  readonly packages: readonly WorkspacePackage[]
  /** Packages whose package.json didn't parse, with the error. */
  readonly unreadable: readonly { readonly dir: string; readonly error: string }[]
  /** `tsconfig.json` references (the typecheck solution). */
  readonly sourceProjects: ReadonlySet<string>
  /** `tsconfig.type-tests.json` references (the type-test solution). */
  readonly typeTestProjects: ReadonlySet<string>
  readonly pnpmWorkspaceYaml: string
}

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
const SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', 'dist', '.tsc', '.turbo'])

/**
 * Reads the workspace under `root`. Packages are sorted by directory.
 * @public
 */
export async function readWorkspace(root: string): Promise<Workspace> {
  const pnpmWorkspaceYaml = await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8')
  const roots = workspaceRoots(pnpmWorkspaceYaml)
  const packages: WorkspacePackage[] = []
  const unreadable: { dir: string; error: string }[] = []
  for (const base of roots) {
    const entries = await readdir(join(root, base), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = `${base}/${entry.name}`
      const text = await readFile(join(root, dir, 'package.json'), 'utf8').catch(() => undefined)
      if (text === undefined) continue
      let json: Readonly<Record<string, unknown>>
      try {
        json = asRecord(JSON.parse(text))
      } catch (err) {
        unreadable.push({ dir, error: err instanceof Error ? err.message : String(err) })
        continue
      }
      const deps = DEP_FIELDS.flatMap((field) => Object.keys(asRecord(json[field])))
      const scripts = asRecord(json.scripts)
      packages.push({
        dir,
        name: String(json.name),
        deps: [...new Set(deps)].sort(),
        exports: json.exports,
        testScript: typeof scripts.test === 'string' ? scripts.test : undefined,
        unitTests: (await listFiles(join(root, dir, 'src'))).filter((f) => f.endsWith('.test.ts'))
          .length,
        hasTsconfig: existsSync(join(root, dir, 'tsconfig.json')),
        hasTypeTests: existsSync(join(root, dir, 'test/tsconfig.json')),
      })
    }
  }
  return {
    roots,
    packages: packages.sort((a, b) => compare(a.dir, b.dir)),
    unreadable,
    sourceProjects: await references(join(root, 'tsconfig.json')),
    typeTestProjects: await references(join(root, 'tsconfig.type-tests.json')),
    pnpmWorkspaceYaml,
  }
}

/**
 * The `packages:` globs of a pnpm-workspace.yaml, as directories. Only the `<dir>/*` form is
 * supported, so another form fails loudly instead of being skipped.
 * @public
 */
export function workspaceRoots(yaml: string): readonly string[] {
  const block = /^packages:\n((?:[ \t]+-[^\n]*\n?)+)/m.exec(yaml)?.[1] ?? ''
  return [...block.matchAll(/-\s*["']?([^"'\n]+?)["']?\s*$/gm)].map((match) => {
    const glob = match[1] ?? ''
    if (!/^[\w.-]+\/\*$/.test(glob)) {
      throw new Error(`pnpm-workspace.yaml: only "<dir>/*" globs are supported, got "${glob}"`)
    }
    return glob.slice(0, -2)
  })
}

/**
 * Whether a manifest name or dir pattern (with `*`) matches a value.
 * @public
 */
export function matches(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) return pattern === value
  const re = new RegExp(`^${pattern.split('*').map(escapeRegex).join('[^/]+')}$`)
  return re.test(value)
}

/**
 * Checks the workspace against the manifest and the repo's conventions: every package is listed
 * under its own name, depends only on what the manifest allows, resolves source through
 * `provino-source`, is in both solution tsconfigs, and has the tests its test script runs.
 * @public
 */
export function checkWorkspace(manifest: Manifest, workspace: Workspace): readonly Problem[] {
  const problems: Problem[] = []
  const report = (rule: string, message: string): void => {
    problems.push({ rule, message })
  }
  const tops = manifest.nodes.filter((node) => node.parent === undefined)
  const packageOf = (name: string): ManifestNode | undefined =>
    tops.find((node) => matches(node.name, name))

  for (const { dir, error } of workspace.unreadable) {
    report('workspace-package-json', `${dir}/package.json doesn't parse: ${error}`)
  }
  for (const node of manifest.nodes) {
    if (node.dir !== null && !workspace.roots.some((base) => node.dir?.startsWith(`${base}/`))) {
      report('manifest-dir', `${node.name}: dir "${node.dir}" is outside the workspace roots`)
    }
  }

  for (const pkg of workspace.packages) {
    const node = tops.find((candidate) => candidate.dir !== null && matches(candidate.dir, pkg.dir))
    if (node === undefined) {
      report(
        'manifest-unknown-package',
        `${pkg.dir} (${pkg.name}) is not in tooling/boundaries/packages.json`,
      )
      continue
    }
    if (!matches(node.name, pkg.name)) {
      report(
        'manifest-name',
        `${pkg.dir} is named "${pkg.name}", but the manifest lists it as "${node.name}"`,
      )
    }
    // A package may depend on what any of its entries may import, at package granularity.
    const entries = manifest.nodes.filter((n) => n === node || n.parent === node.name)
    const allowed = new Set(
      entries.flatMap((entry) =>
        allowedDeps(manifest, entry).map((dep) => packageOf(dep.name)?.name ?? dep.name),
      ),
    )
    for (const dep of pkg.deps) {
      const target = packageOf(dep)
      if (target === undefined || target === node || allowed.has(target.name)) continue
      report(
        'manifest-deps',
        `${pkg.name} depends on ${dep} in package.json, but the manifest doesn't allow it`,
      )
    }
    for (const [subpath, target] of Object.entries(asRecord(pkg.exports))) {
      // Without provino-source first, tools resolve the package to dist/, which isn't cruised.
      if (Object.keys(asRecord(target))[0] !== 'provino-source') {
        report(
          'workspace-exports',
          `${pkg.name}: exports["${subpath}"] must list "provino-source" first`,
        )
      }
    }
    if (pkg.hasTsconfig && !workspace.sourceProjects.has(pkg.dir)) {
      report(
        'workspace-tsconfig',
        `${pkg.dir} is missing from tsconfig.json references, so \`pnpm typecheck\` skips it`,
      )
    }
    if (pkg.hasTypeTests && !workspace.typeTestProjects.has(`${pkg.dir}/test`)) {
      report(
        'workspace-tsconfig',
        `${pkg.dir}/test is missing from tsconfig.type-tests.json references, so \`pnpm test:types\` skips it`,
      )
    }
    // `node --test` passes when its glob matches nothing, so an empty run would look green.
    if (pkg.testScript?.includes('node --test') && pkg.unitTests === 0) {
      report(
        'workspace-tests',
        `${pkg.name}'s test script runs node --test, but src/ has no *.test.ts`,
      )
    }
  }

  const catalogTs6 = /^\s+"@typescript\/typescript6":\s*(\S+)\s*$/m.exec(
    workspace.pnpmWorkspaceYaml,
  )?.[1]
  const extensionTs6 = /typescript:\s*npm:@typescript\/typescript6@(\S+)/.exec(
    workspace.pnpmWorkspaceYaml,
  )?.[1]
  if (catalogTs6 !== extensionTs6) {
    report(
      'workspace-ts6-pin',
      `pnpm-workspace.yaml pins @typescript/typescript6 ${catalogTs6} in the catalog but ${extensionTs6} in packageExtensions`,
    )
  }
  return problems
}

/**
 * Placed manifest dirs that git ignores. Biome skips ignored files, so a lint there never runs.
 * @public
 */
export function ignoredDirs(root: string, manifest: Manifest): readonly Problem[] {
  const probes = manifest.nodes.flatMap((node) =>
    node.dir === null ? [] : [{ node, path: `${node.dir.replaceAll('*', 'x')}/src/index.ts` }],
  )
  const result = spawnSync('git', ['check-ignore', '--stdin'], {
    cwd: root,
    input: probes.map((probe) => probe.path).join('\n'),
    encoding: 'utf8',
  })
  const ignored = new Set(result.stdout.split('\n').filter((line) => line !== ''))
  return probes
    .filter((probe) => ignored.has(probe.path))
    .map(({ node }) => ({
      rule: 'workspace-ignored-dir',
      message: `${node.name}: git ignores ${node.dir}, so Biome never lints it (check .gitignore)`,
    }))
}

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/
/**
 * A comment that would silence the boundary lints: `biome-ignore` (or `-all`/`-start`) of all of
 * `lint`, or of the plugins. Only a line that starts as a comment counts, not the text in a string.
 */
const PLUGIN_SUPPRESSION =
  /^\s*(?:\/\/|\/\*+|\*)\s*biome-ignore(?:-all|-start)?\s+lint(?:\/plugin\S*)?(?=[\s:(]|$)/

/**
 * Source files that suppress the GritQL boundary lints with a `biome-ignore` comment.
 * @public
 */
export async function pluginSuppressions(
  root: string,
  workspace: Workspace,
): Promise<readonly Problem[]> {
  const problems: Problem[] = []
  for (const pkg of workspace.packages) {
    for (const file of await listFiles(join(root, pkg.dir))) {
      if (!SOURCE_FILE.test(file)) continue
      const text = await readFile(join(root, pkg.dir, file), 'utf8')
      const line = text.split('\n').findIndex((l) => PLUGIN_SUPPRESSION.test(l))
      if (line !== -1) {
        problems.push({
          rule: 'no-plugin-suppression',
          message: `${pkg.dir}/${file}:${line + 1} suppresses the boundary lints; fix the code or change the manifest`,
        })
      }
    }
  }
  return problems
}

/**
 * Escapes RegExp syntax in a literal path or name.
 * @public
 */
export function escapeRegex(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

/**
 * Compares strings by code unit, so generated output never depends on the locale.
 * @public
 */
export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

async function references(path: string): Promise<ReadonlySet<string>> {
  const json = asRecord(JSON.parse(await readFile(path, 'utf8')))
  const refs = Array.isArray(json.references) ? json.references : []
  return new Set(refs.map((ref: unknown) => String(asRecord(ref).path)))
}

/** Files under `dir`, relative to it, skipping build output and dependencies. */
async function listFiles(dir: string): Promise<readonly string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .filter((file) => !file.split('/').some((part) => SKIP_DIRS.has(part)))
    .sort(compare)
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {}
}
