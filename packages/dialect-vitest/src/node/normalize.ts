// B25c, T11.15: a loaded Vitest config as projects, resolved the way Vitest 5.0.5 does for the keys
// the reader applies: `test` over Vitest's defaults, the command line over the file, `test.projects`
// (inline objects, directories, config files and globs, `extends`), the project's name and root,
// the mode and `.env*` files. Plain data out, no Vite; `to-neutral.ts` turns it into policy.
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import type { ConfigSource } from '@provino/types'
import { loadVitestEnv } from './env.ts'
import { VitestConfigError } from './errors.ts'
import { findVitestConfig } from './find.ts'
import { expandGlobs, isGlob, isNegated } from './glob.ts'
import { hasPlugin, loadVitestConfig, type VitestLoadedConfig } from './load.ts'
import { isDirectory, isRec, type Rec } from './util.ts'
import { mergeConfig } from './vite-merge.ts'
import { configDefaults } from './vitest-config-stand-in.ts'

/**
 * What the command line (and the caller) gives the reader.
 * @public
 */
export interface VitestReadOptions {
  /** Where `Vite's root` starts from when neither `--root` nor `root` says; default the process's. */
  readonly cwd?: string
  /** `--root`. */
  readonly root?: string
  /** `--mode`; default `test`. */
  readonly mode?: string
  /** `--config`: a path, relative to the root. */
  readonly config?: string
  /** Options as the command line sets them, shaped like `config.test`; they win over the file. */
  readonly test?: Readonly<Rec>
  /** The environment `.env` substitution and `VITE_*` read; default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

/**
 * One resolved project.
 * @public
 */
export interface VitestResolvedProject {
  readonly name: string
  readonly root: string
  /** The file the project's config came from; `null` for an inline project or the defaults. */
  readonly configFile: string | null
  readonly mode: string
  /** The Vite-shaped config without `test`: `resolve`, `define`, `plugins`, `base`, … */
  readonly vite: Readonly<Rec>
  /** What the file and the command line set, before the defaults (what a key "was given" means). */
  readonly given: Readonly<Rec>
  /** `given` over Vitest's defaults. */
  readonly test: Readonly<Rec>
  readonly needsVite: boolean
  /** `import.meta.env`. */
  readonly importMetaEnv: Readonly<Record<string, string | boolean>>
}

/**
 * The reader's `resolve` result.
 * @public
 */
export interface VitestResolvedConfig {
  /** The root config as one project: what `resolveConfig(...).test` is, whether or not `test.projects` splits it. */
  readonly root: VitestResolvedProject
  readonly projects: readonly VitestResolvedProject[]
}

/** Vitest's `deepMerge`: plain objects merge, everything else (arrays too) is replaced. */
export function deepMerge(target: Rec, ...sources: readonly Rec[]): Rec {
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue
      const existing = target[key]
      target[key] =
        isRec(value) && isRec(existing)
          ? deepMerge({ ...existing }, value)
          : isRec(value)
            ? deepMerge({}, value)
            : value
    }
  }
  return target
}

function testOf(config: Rec): Rec {
  return isRec(config.test) ? config.test : {}
}

function withoutTest(config: Rec): Rec {
  const { test: _test, ...rest } = config
  return rest
}

/** Vitest 4 removed `test.workspace` (`resolveConfig.ts` L269-L273). */
const WORKSPACE_REMOVED =
  'The `test.workspace` option was removed in Vitest 4. Please, migrate to `test.projects` instead. See https://vitest.dev/guide/projects for examples.'

function refuse(test: Rec, where: string): void {
  if ('workspace' in test)
    throw new VitestConfigError('VITEST_CONFIG_UNSUPPORTED', WORKSPACE_REMOVED)
  const pool = test.pool
  if (pool === 'vmThreads' || pool === 'vmForks') {
    throw new VitestConfigError(
      'VITEST_CONFIG_UNSUPPORTED',
      `${where}: test.pool "${pool}" is not supported: it needs the realm isolation tier (T2.8); use "forks" or "threads"`,
    )
  }
  const browser = test.browser
  if (isRec(browser) && browser.enabled === true) {
    throw new VitestConfigError(
      'VITEST_CONFIG_UNSUPPORTED',
      `${where}: test.browser.enabled is not supported: Provino runs Node only (D3)`,
    )
  }
  const typecheck = test.typecheck
  if (isRec(typecheck) && typecheck.enabled === true) {
    throw new VitestConfigError(
      'VITEST_CONFIG_UNSUPPORTED',
      `${where}: test.typecheck.enabled is not supported yet: type tests are not part of B25`,
    )
  }
}

function nameOf(test: Rec): string | undefined {
  const name = test.name
  if (typeof name === 'string') return name
  if (isRec(name) && typeof name.label === 'string') return name.label
  return undefined
}

function packageName(dir: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'))
    return isRec(parsed) && typeof parsed.name === 'string' ? parsed.name : undefined
  } catch {
    return undefined
  }
}

interface Context {
  readonly cwd: string
  readonly options: VitestReadOptions
  readonly mode: string
  readonly env: Readonly<Record<string, string | undefined>>
}

function envPrefixes(vite: Rec): string[] {
  const prefix = vite.envPrefix
  if (typeof prefix === 'string') return [prefix]
  if (Array.isArray(prefix))
    return prefix.filter((entry): entry is string => typeof entry === 'string')
  return ['VITE_']
}

/**
 * Vitest's root is Vite's `root` (from `baseDir`) or the directory, and `--root` for a project with
 * no config file; a `test.root` is read by neither (recorded by the sample: `bench:vitest-config`).
 */
function rootOf(context: Context, vite: Rec, configFile: string | null, baseDir: string): string {
  if (context.options.root !== undefined && configFile === null) {
    return resolve(context.cwd, context.options.root)
  }
  if (typeof vite.root === 'string') return resolve(baseDir, vite.root)
  return context.options.root !== undefined ? resolve(context.cwd, context.options.root) : baseDir
}

function build(
  context: Context,
  parts: {
    readonly vite: Rec
    readonly fileTest: Rec
    readonly configFile: string | null
    /** Where the project is rooted: derived once, by `rootOf` or from the command line. */
    readonly root: string
    readonly fallbackName: string
    /** The top-level config, which alone takes `--exclude`. */
    readonly isRoot?: true
  },
): VitestResolvedProject {
  const { vite, fileTest, configFile, root } = parts
  const { cliExclude, ...cli } = context.options.test ?? {}
  // A child project gets only the command line's `PROJECT_CLI_OVERRIDES` (resolveProjects.ts
  // L52-L79), which has neither `environment` nor `dom`: `--dom` reaches `resolveTestConfig` for
  // the root alone.
  const { environment: _environment, dom: _dom, ...forChild } = cli
  const cliTest = parts.isRoot === true ? cli : forChild
  const given = deepMerge({}, fileTest, cliTest)
  // `--dom` is `environment: 'happy-dom'`, over the file's (resolveConfig.ts `resolveTestConfig`,
  // `if (options.dom)`; `cli/vitest-dom`). Vitest also warns when the file names another one: not
  // printed here (a limit).
  if (given.dom === true) given.environment = 'happy-dom'
  const test = deepMerge({}, configDefaults as Rec, given)
  // `--exclude` adds to the excludes (cac.ts L284 `cliExclude`, resolveConfig.ts L633-L635). It is
  // not among `PROJECT_CLI_OVERRIDES` (resolveProjects.ts L52), so a child project never gets it.
  if (parts.isRoot === true && Array.isArray(cliExclude)) {
    test.exclude = [...(Array.isArray(test.exclude) ? test.exclude : []), ...cliExclude]
  }
  refuse(test, configFile ?? root)
  // `vite.root` and `test.root` are paths, not options a project inherits as text.
  const name = nameOf(test) ?? parts.fallbackName
  const nodeEnv = context.env.NODE_ENV ?? 'test'
  const envDir =
    typeof vite.envDir === 'string'
      ? resolve(root, vite.envDir)
      : vite.envDir === false
        ? null
        : root
  const loaded =
    envDir === null
      ? {}
      : loadVitestEnv({
          mode: context.mode,
          envDir,
          prefixes: envPrefixes(vite),
          processEnv: context.env,
        })
  const importMetaEnv: Record<string, string | boolean> = {
    ...loaded,
    BASE_URL: typeof vite.base === 'string' ? vite.base : '/',
    MODE: context.mode,
    DEV: nodeEnv !== 'production',
    PROD: nodeEnv === 'production',
    SSR: true,
  }
  const extra = test.env
  if (isRec(extra)) {
    for (const [key, value] of Object.entries(extra)) {
      if (typeof value === 'string' || typeof value === 'boolean') importMetaEnv[key] = value
    }
  }
  return {
    name,
    root,
    configFile,
    mode: context.mode,
    vite: withoutTest(vite),
    given,
    test,
    needsVite: hasPlugin(vite.plugins),
    importMetaEnv,
  }
}

async function loadFile(context: Context, path: string): Promise<{ vite: Rec; fileTest: Rec }> {
  const source: ConfigSource = { kind: 'file', path }
  const loaded = await loadVitestConfig(source, { mode: context.mode })
  return { vite: { ...loaded.config }, fileTest: testOf(loaded.config) }
}

/** The project in `dir`, from its config file `file` (or none: Vitest's defaults). */
async function projectAt(
  context: Context,
  dir: string,
  file: string | null,
): Promise<VitestResolvedProject> {
  const loaded = file === null ? { vite: {}, fileTest: {} } : await loadFile(context, file)
  return build(context, {
    ...loaded,
    configFile: file,
    root: rootOf(context, loaded.vite, file, dir),
    fallbackName: packageName(dir) ?? basename(dir),
  })
}

async function projectFromInline(
  context: Context,
  entry: Rec,
  index: number,
  root: { readonly vite: Rec; readonly dir: string },
): Promise<VitestResolvedProject> {
  const { extends: base, ...own } = entry
  let vite: Rec = own
  // Since Vitest 5 an inline project extends the config file that declares it unless it says
  // `extends: false` (`resolveProjects.ts` L361-L365, recorded: `config/vitest-projects`).
  if (base === undefined || base === true) {
    vite = mergeConfig(withTestKept(root.vite), own)
  } else if (typeof base === 'string') {
    const path = resolve(root.dir, base)
    const loaded = await loadFile(context, path)
    vite = mergeConfig({ ...loaded.vite, test: loaded.fileTest }, own)
  }
  // The project's own `test.root` (else `root`) from the declaring config's root, not the base's
  // (`resolveProjects.ts` L368-L374).
  const customRoot = testOf(own).root ?? own.root
  return build(context, {
    vite: withoutTest(vite),
    fileTest: testOf(vite),
    configFile: null,
    root: typeof customRoot === 'string' ? resolve(root.dir, customRoot) : root.dir,
    fallbackName: String(index),
  })
}

/** The root config as a base for `extends: true`: its `test` without `projects`. */
function withTestKept(vite: Rec): Rec {
  const { projects: _projects, ...test } = testOf(vite)
  return { ...vite, test }
}

function projectEntries(test: Rec): readonly unknown[] {
  return Array.isArray(test.projects) ? test.projects : []
}

/**
 * Resolves what `loaded` (the file `source` named, or none) says into the run's projects.
 * @public
 */
export async function resolveVitestProjects(
  loaded: VitestLoadedConfig | undefined,
  options: VitestReadOptions,
): Promise<VitestResolvedConfig> {
  const cwd = options.cwd ?? process.cwd()
  const context: Context = {
    cwd,
    options,
    mode: options.mode ?? 'test',
    env: options.env ?? process.env,
  }
  const rootVite: Rec = loaded === undefined ? {} : { ...loaded.config }
  const rootFile = loaded?.path ?? null
  const rootDir =
    options.root !== undefined
      ? resolve(cwd, options.root)
      : rootOf(context, rootVite, rootFile, cwd)
  const root = build(context, {
    vite: rootVite,
    fileTest: testOf(rootVite),
    configFile: rootFile,
    root: rootDir,
    fallbackName: '',
    isRoot: true,
  })
  const entries = projectEntries(root.given)
  if (entries.length === 0) return { root, projects: [root] }
  const projects: VitestResolvedProject[] = []
  const patterns: string[] = []
  let index = 0
  for (const entry of entries) {
    if (typeof entry === 'string') {
      patterns.push(entry)
    } else if (isRec(entry)) {
      projects.push(
        await projectFromInline(context, entry, index, { vite: rootVite, dir: rootDir }),
      )
    } else {
      throw new VitestConfigError(
        'VITEST_CONFIG_INVALID',
        'test.projects entries must be a path, a glob or a config object',
      )
    }
    index++
  }
  const seen = new Set<string>()
  // A pattern with a leading `!` removes what it names from every other pattern's matches.
  const negations = patterns.filter((pattern) => pattern.startsWith('!'))
  for (const pattern of patterns.filter((entry) => !entry.startsWith('!'))) {
    const paths = isGlob(pattern)
      ? await expandGlobs(rootDir, [pattern, ...negations])
      : [resolve(rootDir, pattern)].filter((path) => !isNegated(path, negations, rootDir))
    if (paths.length === 0) {
      throw new VitestConfigError(
        'VITEST_CONFIG_INVALID',
        `The projects glob "${pattern}" matched no directory or config file`,
      )
    }
    for (const path of paths) {
      if (seen.has(path)) continue
      seen.add(path)
      if (isDirectory(path)) {
        projects.push(await projectAt(context, path, findVitestConfig(path)?.path ?? null))
      } else if (existsSync(path)) projects.push(await projectAt(context, dirname(path), path))
      else {
        throw new VitestConfigError(
          'VITEST_CONFIG_INVALID',
          `The project path "${path}" does not exist`,
        )
      }
    }
  }
  const names = new Set<string>()
  for (const project of projects) {
    if (names.has(project.name)) {
      throw new VitestConfigError(
        'VITEST_CONFIG_INVALID',
        `Project name "${project.name}" is not unique. All projects should have unique names.`,
      )
    }
    names.add(project.name)
  }
  return { root, projects }
}
