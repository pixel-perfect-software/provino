import { stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { ConfigEnv, PoolKind, ProjectConfig, ProvinoConfigInput } from '@provino/types'
import { findConfigInDirectory } from './discover.ts'
import { ConfigError } from './errors.ts'
import { isRecord, parseInput } from './internal/input.ts'
import { isGlob, matchDirectories } from './internal/project-globs.ts'
import { loadConfigFile } from './load.ts'
import {
  type ResolvedProject,
  type ResolveProjectOptions,
  resolveProject,
  resolveProjectInput,
} from './resolve.ts'

/** What `loadConfigFile` is given when the caller gives no `ConfigEnv`. */
const DEFAULT_ENV: ConfigEnv = Object.freeze({ command: 'run', mode: 'test' })

/**
 * What `resolveProjects` needs besides the config: `resolveProject`'s options, and the
 * `ConfigEnv` a project's own config file is loaded with (default `{ command: 'run', mode: 'test' }`).
 * @public
 */
export interface ResolveProjectsOptions extends ResolveProjectOptions {
  readonly env?: ConfigEnv
}

/**
 * A config resolved into the projects one run covers, and the run defaults it sets.
 * @public
 */
export interface ResolvedConfig {
  /** The projects, in the config's order; one for a config with no `projects`. */
  readonly projects: readonly ResolvedProject[]
  /**
   * The run's own root, set only for a config with `projects`: the top-level config's directory
   * (or its `root`), which is no project's.
   */
  readonly root?: string
  /** `pool`, when the config sets it: the default for a run whose command line names none. */
  readonly pool?: PoolKind
  /** `maxWorkers`, when the config sets it: the default for a run whose command line names none. */
  readonly maxWorkers?: number
}

async function statOf(path: string): Promise<'directory' | 'file' | undefined> {
  try {
    const stats = await stat(path)
    return stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : undefined
  } catch {
    return undefined
  }
}

/** A `projects` string as the directories (or a config file) it names. */
async function expandEntry(entry: string, base: string): Promise<readonly string[]> {
  if (isGlob(entry)) {
    const directories = await matchDirectories(
      base,
      isAbsolute(entry) ? entry : resolve(base, entry),
    )
    if (directories.length === 0) {
      throw new ConfigError(
        'CONFIG_INVALID',
        `projects entry ${JSON.stringify(entry)} matches no directory`,
      )
    }
    return directories
  }
  const path = resolve(base, entry)
  if ((await statOf(path)) === undefined) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `projects entry ${JSON.stringify(entry)} isn't a directory or a config file ("${path}")`,
    )
  }
  return [path]
}

/**
 * One directory (or config file) of `projects` as a project: its own `provino.config.*` when it
 * has one, else the defaults, with the directory as the project's root. A project that gives no
 * `name` is named for its directory.
 */
async function resolveDirectory(
  path: string,
  options: ResolveProjectsOptions,
): Promise<ResolvedProject> {
  const isFile = (await statOf(path)) === 'file'
  const directory = isFile ? dirname(path) : path
  const configPath = isFile ? path : await findConfigInDirectory(directory)
  const loaded: ProjectConfig =
    configPath === undefined ? {} : await loadConfigFile(configPath, options.env ?? DEFAULT_ENV)
  const input: ProjectConfig = { ...loaded, name: loaded.name ?? basename(directory) }
  return resolveProjectInput(
    input,
    { ...options, configPath: configPath ?? join(directory, 'provino.config.ts') },
    false,
  )
}

/** A project name that two projects share is an error: reporters and filters tell projects apart by it. */
function assertUniqueNames(projects: readonly ResolvedProject[]): void {
  const seen = new Set<string>()
  for (const { name } of projects) {
    if (name === '') continue
    if (seen.has(name)) {
      throw new ConfigError(
        'CONFIG_INVALID',
        `two projects are named ${JSON.stringify(name)}; give each a \`name\``,
      )
    }
    seen.add(name)
  }
}

/**
 * Resolves a config into what one run covers. With no `projects` (or an empty list) the config is
 * the one project (`resolveProject`). With `projects`, each entry is a project, in order: an inline
 * object (its `root` is relative to the config file), a directory (its own `provino.config.*`
 * when it has one), a path to a config file, or a glob (`*`, `?`, `**`) of directories. The
 * top-level config's other keys are not inherited by them; its `pool` and `maxWorkers` are the
 * run's defaults. A project has no `projects`, `pool` or `maxWorkers` of its own, and two projects
 * may not share a name. Every failure is a `ConfigError`.
 * @public
 */
export async function resolveProjects(
  input: ProvinoConfigInput,
  options: ResolveProjectsOptions,
): Promise<ResolvedConfig> {
  const parsed = parseInput(input, options.dialects)
  const run = {
    ...(parsed.pool === undefined ? {} : { pool: parsed.pool }),
    ...(parsed.maxWorkers === undefined ? {} : { maxWorkers: parsed.maxWorkers }),
  }
  const entries = parsed.projects ?? []
  if (entries.length === 0) return { projects: [await resolveProject(input, options)], ...run }

  const root = resolve(dirname(options.configPath), parsed.root ?? '.')
  const projects: ResolvedProject[] = []
  for (const entry of entries) {
    if (isRecord(entry)) {
      projects.push(await resolveProjectInput(entry, options, false))
    } else if (typeof entry === 'string') {
      for (const path of await expandEntry(entry, root)) {
        projects.push(await resolveDirectory(path, options))
      }
    }
  }
  assertUniqueNames(projects)
  return { projects, root, ...run }
}

/**
 * Loads the config file at `configPath` and resolves it: `loadConfigFile` then `resolveProjects`.
 * @public
 */
export async function loadProjects(
  configPath: string,
  options: Omit<ResolveProjectsOptions, 'configPath'>,
): Promise<ResolvedConfig> {
  const absolute = resolve(configPath)
  const input = await loadConfigFile(absolute, options.env ?? DEFAULT_ENV)
  return resolveProjects(input, { ...options, configPath: absolute })
}
