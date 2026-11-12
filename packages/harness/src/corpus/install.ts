// T12.9's installer: a frozen install of one repository with its own package manager (DECISIONS
// D40: the package managers are manifest data; our scripts stay pnpm-only), scripts always off,
// every cache inside the work directory so nothing touches the user's global stores. Then the
// offline re-install: the `node_modules` trees are deleted and installed again with the network
// off, inside the sandbox, and the result must be the same tree, file for file.
import { createHash } from 'node:crypto'
import { mkdir, readdir, readlink, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { HarnessError } from '../errors.ts'
import { compareStrings, errorMessage, isRecord, readIfExists } from '../internal/guards.ts'
import type { CommandWrap, ProcessResult } from '../run-process.ts'
import { resolveRunnerPackage } from '../runner-package.ts'
import { type CorpusDeps, defaultDeps, exitText, tailOf } from './deps.ts'
import { digestFile, diskUsageMb, readSrcMarker } from './fetch.ts'
import type { CorpusRepo } from './manifest.ts'
import { homeDir, type RepoPaths, repoPaths, tmpDir } from './paths.ts'
import { baseEnv, sandboxWrap, writeProfile } from './sandbox.ts'

const INSTALL_TIMEOUT_MS = 30 * 60_000

/**
 * What an install records, in `<work>/<id>/install.json`.
 * @public
 */
export interface InstallRecord {
  readonly id: string
  readonly sha: string
  readonly packageManager: { readonly name: string; readonly version: string }
  /** The command, for a reader (the package manager's own, with flags). */
  readonly command: readonly string[]
  /** Milliseconds the install took (`local`). */
  readonly wallMs: number
  readonly installedAt: string
  /** A hash over every file under every `node_modules` in the tree. */
  readonly fingerprint: string
  readonly fingerprintFiles: number
  readonly diskMb?: number
  /** The runner version each subject resolves from its directory. */
  readonly runnerVersions: Readonly<Record<string, string>>
  /** The offline re-install, once it has run. */
  readonly offline?: {
    readonly ok: boolean
    readonly wallMs: number
    readonly verifiedAt: string
    readonly fingerprint: string
  }
}

/** What the install runs: one command in one directory with one environment. */
export interface InstallPlan {
  readonly command: string
  readonly args: readonly string[]
  readonly env: NodeJS.ProcessEnv
  readonly cwd: string
  /** `name@version`, for the record. */
  readonly manager: { readonly name: string; readonly version: string }
}

const PROXY_VARIABLES: readonly string[] = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
]

/**
 * The environment of an install: an allowlist, `HOME` and `TMPDIR` and every cache inside the
 * repository's work directory, scripts off. An online install passes the proxy variables through
 * (a Node tool needs `NODE_USE_ENV_PROXY=1` to use them); the offline one has none and tells each
 * tool the network is off.
 * @public
 */
export function installEnv(options: {
  readonly paths: RepoPaths
  readonly offline: boolean
  readonly inherited?: NodeJS.ProcessEnv | undefined
  readonly nodeDir?: string | undefined
}): NodeJS.ProcessEnv {
  const { paths, offline } = options
  const home = homeDir(paths.dir)
  const cache = paths.cache
  const env: NodeJS.ProcessEnv = {
    ...baseEnv({
      home,
      tmp: tmpDir(paths.dir),
      nodeDir: options.nodeDir,
    }),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    PNPM_HOME: path.join(home, 'pnpm'),
    npm_config_cache: path.join(cache, 'npm'),
    npm_config_userconfig: path.join(home, '.npmrc'),
    npm_config_globalconfig: path.join(home, '.npmglobalrc'),
    npm_config_ignore_scripts: 'true',
    npm_config_update_notifier: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    COREPACK_HOME: path.join(cache, 'corepack'),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    COREPACK_ENABLE_AUTO_PIN: '0',
    YARN_GLOBAL_FOLDER: path.join(cache, 'yarn-global'),
    YARN_ENABLE_GLOBAL_CACHE: 'false',
    YARN_ENABLE_SCRIPTS: 'false',
    YARN_ENABLE_TELEMETRY: '0',
  }
  if (offline) {
    env.COREPACK_ENABLE_NETWORK = '0'
    env.YARN_ENABLE_NETWORK = 'false'
    env.npm_config_offline = 'true'
  } else {
    env.NODE_USE_ENV_PROXY = '1'
    for (const name of PROXY_VARIABLES) {
      const value = options.inherited?.[name]
      if (value !== undefined) env[name] = value
    }
  }
  return env
}

/** A flag the manifest gives the install must look like one: it goes straight into an argv. */
function checkedInstallArgs(repo: CorpusRepo): string[] {
  const args = [...(repo.install.args ?? [])]
  for (const arg of args) {
    if (!arg.startsWith('-')) {
      throw new HarnessError(
        'HARNESS_CORPUS_MANIFEST_INVALID',
        `${repo.id}: install.args "${arg}" is not a flag`,
      )
    }
  }
  return args
}

/**
 * The frozen-install command for a repository: its own package manager at the pinned version
 * through `corepack` (the version is manifest data, D40), `--frozen-lockfile`,
 * `ci` or `--immutable`, scripts off, the store and caches in the work directory.
 * @public
 */
export function installPlan(
  repo: CorpusRepo,
  options: {
    readonly workRoot: string
    readonly offline: boolean
    readonly inherited?: NodeJS.ProcessEnv | undefined
    readonly nodeDir?: string | undefined
  },
): InstallPlan {
  const paths = repoPaths(options.workRoot, repo)
  const env = installEnv({
    paths,
    offline: options.offline,
    inherited: options.inherited,
    nodeDir: options.nodeDir,
  })
  const extra = checkedInstallArgs(repo)
  const offlineFlag = options.offline ? ['--offline'] : []
  const { name, version } = repo.install
  const base = { env, cwd: paths.src }
  if (name === 'pnpm') {
    return {
      ...base,
      command: 'corepack',
      args: [
        `pnpm@${version}`,
        'install',
        '--frozen-lockfile',
        '--ignore-scripts',
        '--store-dir',
        path.join(paths.cache, 'pnpm-store'),
        ...offlineFlag,
        ...extra,
      ],
      manager: { name, version },
    }
  }
  if (name === 'npm') {
    return {
      ...base,
      command: 'corepack',
      args: [
        `npm@${version}`,
        'ci',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        ...offlineFlag,
        ...extra,
      ],
      manager: { name, version },
    }
  }
  const classic = version.startsWith('1.')
  return {
    ...base,
    command: 'corepack',
    args: classic
      ? [
          `yarn@${version}`,
          'install',
          '--frozen-lockfile',
          '--ignore-scripts',
          '--non-interactive',
          '--cache-folder',
          path.join(paths.cache, 'yarn-classic'),
          ...offlineFlag,
          ...extra,
        ]
      : [`yarn@${version}`, 'install', '--immutable', ...extra],
    manager: { name, version },
  }
}

/** Files a package manager rewrites with a timestamp on every install: not part of the tree. */
const VOLATILE_NAMES: ReadonlySet<string> = new Set([
  '.modules.yaml',
  '.pnpm-workspace-state-v1.json',
  '.yarn-integrity',
  '.cache',
  '.vite',
  '.vite-temp',
])

/** The `node_modules` directories of a tree: the workspace root's and each package's. */
export async function findNodeModules(src: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (entry.name === 'node_modules') found.push(path.join(dir, entry.name))
      else if (entry.name !== '.git') await walk(path.join(dir, entry.name))
    }
  }
  await walk(src)
  return found.toSorted(compareStrings)
}

/** How many files `fingerprintTree` reads at once: a `node_modules` has 100,000 of them. */
const FINGERPRINT_CONCURRENCY = 32

/**
 * A hash over every directory, file (size and content) and symbolic link (target) under every
 * `node_modules` in the tree, volatile files aside. Two installs that give the same tree give the
 * same hash; the offline re-install must reproduce it. The tree is listed first, then its files
 * and links are read `concurrency` at a time.
 * @public
 */
export async function fingerprintTree(
  src: string,
  options: {
    readonly concurrency?: number
    /** Reads one file's size and sha256 (tests count what is open at once). */
    readonly digestFile?: (
      file: string,
    ) => Promise<{ readonly size: number; readonly sha256: string }>
  } = {},
): Promise<{ readonly hash: string; readonly files: number }> {
  const digest = options.digestFile ?? digestFile
  const lines: string[] = []
  const reads: (() => Promise<void>)[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (VOLATILE_NAMES.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      const relative = path.relative(src, full)
      if (entry.isSymbolicLink()) {
        reads.push(async () => {
          lines.push(`l\0${relative}\0${await readlink(full)}`)
        })
      } else if (entry.isDirectory()) {
        lines.push(`d\0${relative}`)
        await walk(full)
      } else if (entry.isFile()) {
        reads.push(async () => {
          const { size, sha256 } = await digest(full)
          lines.push(`f\0${relative}\0${size}\0${sha256}`)
        })
      }
    }
  }
  for (const dir of await findNodeModules(src)) await walk(dir)
  let next = 0
  const worker = async (): Promise<void> => {
    for (let read = reads[next++]; read !== undefined; read = reads[next++]) await read()
  }
  await Promise.all(
    Array.from({ length: Math.max(1, options.concurrency ?? FINGERPRINT_CONCURRENCY) }, worker),
  )
  const hash = createHash('sha256')
  for (const line of lines.toSorted(compareStrings)) hash.update(`${line}\n`)
  return { hash: hash.digest('hex'), files: lines.length }
}

async function prepareDirs(paths: RepoPaths): Promise<void> {
  for (const dir of [homeDir(paths.dir), tmpDir(paths.dir), paths.cache]) {
    await mkdir(dir, { recursive: true })
  }
  // This repository's root `package.json` says `"type": "module"`, and Node reads every `.js`
  // below it that way, including a package manager corepack unpacks into the cache (Yarn 4's
  // `yarn.js` is CommonJS and fails with "Dynamic require of util"). A package.json of the cache's
  // own stops the lookup there.
  await writeFile(
    path.join(paths.cache, 'package.json'),
    `${JSON.stringify({ private: true, type: 'commonjs' })}\n`,
  )
}

async function srcMustExist(repo: CorpusRepo, paths: RepoPaths): Promise<void> {
  if ((await readSrcMarker(paths)) !== repo.sha) {
    throw new HarnessError(
      'HARNESS_CORPUS_NOT_INSTALLED',
      `${repo.id}: no extracted tree at ${repo.sha}; run "corpus fetch ${repo.id}" first`,
    )
  }
}

/** The runner version each subject resolves from its own directory, and the mismatches. */
async function runnerVersions(
  repo: CorpusRepo,
  paths: RepoPaths,
): Promise<{ versions: Record<string, string>; problems: string[] }> {
  const versions: Record<string, string> = {}
  const problems: string[] = []
  for (const subject of repo.subjects) {
    try {
      const found = resolveRunnerPackage(subject.runner, path.join(paths.src, subject.cwd))
      versions[subject.id] = found.version
      if (found.version !== subject.runnerVersion) {
        problems.push(
          `${subject.id}: ${subject.runner} ${found.version} is installed, the manifest says ${subject.runnerVersion}`,
        )
      }
    } catch (error) {
      problems.push(`${subject.id}: ${errorMessage(error)}`)
    }
  }
  return { versions, problems }
}

async function runInstall(
  plan: InstallPlan,
  deps: CorpusDeps,
  wrap?: CommandWrap,
): Promise<Pick<ProcessResult, 'wallMs' | 'output' | 'exitCode' | 'signal' | 'timedOut'>> {
  const target =
    wrap === undefined ? { command: plan.command, args: plan.args } : wrap(plan.command, plan.args)
  const result = await deps.run(target.command, target.args, {
    cwd: plan.cwd,
    env: plan.env,
    timeoutMs: INSTALL_TIMEOUT_MS,
    tailChars: 6_000,
  })
  if (result.timedOut) {
    throw new HarnessError(
      'HARNESS_CORPUS_INSTALL_FAILED',
      `${plan.command} ${plan.args.slice(0, 3).join(' ')} timed out after ${INSTALL_TIMEOUT_MS} ms`,
    )
  }
  return result
}

/**
 * Installs a repository's dependencies: the frozen install with scripts off, then the
 * repository's `rebuild` list (scripts on for those packages only), then a check that each
 * subject's runner is the version the manifest names. The tree's fingerprint, the wall time and the
 * disk used are written to `install.json`. Run it online (an agent may, with the registry's hosts
 * allowed); `reinstallOffline` is the part that needs the sandbox.
 * @public
 */
export async function installRepo(
  repo: CorpusRepo,
  options: {
    readonly workRoot: string
    readonly deps?: CorpusDeps
    readonly inherited?: NodeJS.ProcessEnv
    readonly now?: () => Date
  },
): Promise<InstallRecord> {
  const deps = options.deps ?? defaultDeps
  const paths = repoPaths(options.workRoot, repo)
  if (repo.install.lockfile === undefined) {
    throw new HarnessError(
      'HARNESS_CORPUS_INSTALL_FAILED',
      `${repo.id}: the repository commits no lockfile, so there is nothing to freeze; the bundle that installs it decides how to pin its dependencies`,
    )
  }
  await srcMustExist(repo, paths)
  await prepareDirs(paths)
  const plan = installPlan(repo, {
    workRoot: options.workRoot,
    offline: false,
    inherited: options.inherited,
  })
  const started = (options.now ?? (() => new Date()))()
  const installed = await runInstall(plan, deps)
  if (installed.exitCode !== 0) {
    throw new HarnessError(
      'HARNESS_CORPUS_INSTALL_FAILED',
      `${repo.id}: ${plan.manager.name} ${exitText(installed)}:\n${tailOf(installed, 1500)}`,
    )
  }
  // The rebuilds run the packages' own install scripts, so they run under the sandbox (a repository
  // with none needs no profile, and the install itself needs the network).
  const profile =
    (repo.rebuild ?? []).length === 0
      ? undefined
      : await writeProfile({ runDir: paths.dir, workRoot: options.workRoot })
  const wallMs =
    installed.wallMs +
    (await rebuildPackages(
      repo,
      plan,
      deps,
      profile === undefined ? undefined : sandboxWrap(profile),
    ))
  const { versions, problems } = await runnerVersions(repo, paths)
  if (problems.length > 0) {
    throw new HarnessError(
      'HARNESS_CORPUS_INSTALL_FAILED',
      `${repo.id}: the installed runners differ from the manifest:\n${problems.join('\n')}`,
    )
  }
  const fingerprint = await fingerprintTree(paths.src)
  const diskMb = await diskUsageMb(paths.dir, deps, plan.env)
  const record: InstallRecord = {
    id: repo.id,
    sha: repo.sha,
    packageManager: plan.manager,
    command: [plan.command, ...plan.args],
    wallMs,
    installedAt: started.toISOString(),
    fingerprint: fingerprint.hash,
    fingerprintFiles: fingerprint.files,
    ...(diskMb === undefined ? {} : { diskMb }),
    runnerVersions: versions,
  }
  await writeFile(paths.installRecord, `${JSON.stringify(record, null, 2)}\n`)
  return record
}

/**
 * Rebuilds each of the repository's `rebuild` packages with its scripts on, and returns the
 * milliseconds that took. Both installs run it, so their trees (and fingerprints) agree.
 */
async function rebuildPackages(
  repo: CorpusRepo,
  plan: InstallPlan,
  deps: CorpusDeps,
  wrap?: CommandWrap,
): Promise<number> {
  let wallMs = 0
  for (const pkg of repo.rebuild ?? []) {
    const result = await runInstall(rebuildPlan(plan, pkg), deps, wrap)
    wallMs += result.wallMs
    if (result.exitCode !== 0) {
      throw new HarnessError(
        'HARNESS_CORPUS_INSTALL_FAILED',
        `${repo.id}: rebuilding ${pkg} ${exitText(result)}:\n${tailOf(result, 1500)}`,
      )
    }
  }
  return wallMs
}

/** The command that rebuilds one package with its scripts on (`pnpm rebuild`, `npm rebuild`, `yarn rebuild`). */
function rebuildPlan(plan: InstallPlan, pkg: string): InstallPlan {
  const env: NodeJS.ProcessEnv = {
    ...plan.env,
    npm_config_ignore_scripts: 'false',
    YARN_ENABLE_SCRIPTS: 'true',
  }
  return { ...plan, env, args: rebuildArgs(plan, pkg) }
}

function rebuildArgs(plan: InstallPlan, pkg: string): string[] {
  const first = plan.args[0]
  // `corepack <pm>@<version>` then the subcommand; npm without a pin runs `npm` itself.
  return plan.command === 'corepack' && first !== undefined
    ? [first, 'rebuild', pkg]
    : ['rebuild', pkg]
}

/**
 * The offline re-install (T12.9: "frozen install, network off afterwards"): deletes every
 * `node_modules` in the tree, then runs the frozen install again with `--offline` inside the
 * sandbox, and checks the tree has the recorded fingerprint. Only the package manager's caches
 * can serve it, so it proves the first install left nothing to fetch. Writes the outcome into
 * `install.json`. The caller probes the sandbox first.
 * @public
 */
export async function reinstallOffline(
  repo: CorpusRepo,
  options: {
    readonly workRoot: string
    readonly deps?: CorpusDeps
    readonly now?: () => Date
  },
): Promise<NonNullable<InstallRecord['offline']>> {
  const deps = options.deps ?? defaultDeps
  const paths = repoPaths(options.workRoot, repo)
  await srcMustExist(repo, paths)
  const recorded = await readInstallRecord(repo, options.workRoot)
  if (recorded === undefined) {
    throw new HarnessError(
      'HARNESS_CORPUS_NOT_INSTALLED',
      `${repo.id}: no install record at ${repo.sha.slice(0, 12)}; run "corpus install ${repo.id}" first`,
    )
  }
  await prepareDirs(paths)
  const plan = installPlan(repo, { workRoot: options.workRoot, offline: true })
  const profile = await writeProfile({ runDir: paths.dir, workRoot: options.workRoot })
  for (const dir of await findNodeModules(paths.src))
    await rm(dir, { recursive: true, force: true })
  const wrap = sandboxWrap(profile)
  const result = await runInstall(plan, deps, wrap)
  // The first install ran the same rebuilds before it recorded its fingerprint.
  const rebuildMs = result.exitCode === 0 ? await rebuildPackages(repo, plan, deps, wrap) : 0
  const after = await fingerprintTree(paths.src)
  const ok = result.exitCode === 0 && after.hash === recorded.fingerprint
  const outcome = {
    ok,
    wallMs: result.wallMs + rebuildMs,
    verifiedAt: (options.now ?? (() => new Date()))().toISOString(),
    fingerprint: after.hash,
  }
  await writeFile(
    paths.installRecord,
    `${JSON.stringify({ ...recorded, offline: outcome }, null, 2)}\n`,
  )
  if (!ok) {
    throw new HarnessError(
      'HARNESS_CORPUS_INSTALL_FAILED',
      result.exitCode === 0
        ? `${repo.id}: the offline re-install gave another tree (${after.hash.slice(0, 12)}, expected ${recorded.fingerprint.slice(0, 12)}); a file under node_modules changed`
        : `${repo.id}: the offline re-install ${exitText(result)}:\n${tailOf(result, 1500)}`,
    )
  }
  return outcome
}

/**
 * Reads a repository's `install.json`, or `undefined` if it has none, it is malformed, or it is
 * not of the pinned commit: a record whose `sha` differs from the manifest's, or whose extracted
 * tree (`src.sha`) is another commit's, describes a tree that is gone, so the repository counts
 * as not installed.
 * @public
 */
export async function readInstallRecord(
  repo: Pick<CorpusRepo, 'id' | 'sha'>,
  workRoot: string,
): Promise<InstallRecord | undefined> {
  const paths = repoPaths(workRoot, repo)
  const text = await readIfExists(paths.installRecord)
  if (text === undefined) return undefined
  const record = asInstallRecord(JSON.parse(text))
  if (record?.sha !== repo.sha || (await readSrcMarker(paths)) !== repo.sha) return undefined
  return record
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') return undefined
    out[key] = item
  }
  return out
}

/** An `install.json`'s content as an `InstallRecord`, or `undefined` if a field is wrong. */
function asInstallRecord(value: unknown): InstallRecord | undefined {
  if (!isRecord(value)) return undefined
  const manager = value.packageManager
  const offline = value.offline
  const runnerVersions = stringRecord(value.runnerVersions)
  if (
    typeof value.id !== 'string' ||
    typeof value.sha !== 'string' ||
    !isRecord(manager) ||
    typeof manager.name !== 'string' ||
    typeof manager.version !== 'string' ||
    !Array.isArray(value.command) ||
    !value.command.every((part): part is string => typeof part === 'string') ||
    typeof value.wallMs !== 'number' ||
    typeof value.installedAt !== 'string' ||
    typeof value.fingerprint !== 'string' ||
    typeof value.fingerprintFiles !== 'number' ||
    runnerVersions === undefined
  ) {
    return undefined
  }
  const offlineRecord =
    isRecord(offline) &&
    typeof offline.ok === 'boolean' &&
    typeof offline.wallMs === 'number' &&
    typeof offline.verifiedAt === 'string' &&
    typeof offline.fingerprint === 'string'
      ? {
          ok: offline.ok,
          wallMs: offline.wallMs,
          verifiedAt: offline.verifiedAt,
          fingerprint: offline.fingerprint,
        }
      : undefined
  return {
    id: value.id,
    sha: value.sha,
    packageManager: { name: manager.name, version: manager.version },
    command: value.command,
    wallMs: value.wallMs,
    installedAt: value.installedAt,
    fingerprint: value.fingerprint,
    fingerprintFiles: value.fingerprintFiles,
    ...(typeof value.diskMb === 'number' ? { diskMb: value.diskMb } : {}),
    runnerVersions,
    ...(offlineRecord === undefined ? {} : { offline: offlineRecord }),
  }
}
