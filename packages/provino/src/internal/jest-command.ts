// `provino jest <jest arguments>` (T11.13, U3): the Jest command line, parsed by the Jest dialect's
// own parser, layered over the project Jest's config reader finds, run by the same coordinator
// as `provino run`, and ended with Jest's exit codes.
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { type ResolvedProject, resolveNeutralProject } from '@provino/config'
import {
  createJestConfigReader,
  type JestArgv,
  JestCliError,
  JestConfigError,
  type JestGlobalConfig,
  jestCli,
  jestNodeDialect,
} from '@provino/dialect-jest/node'
import { defaultCacheDir, discoverProject, ExitCode, selectFiles } from '@provino/orchestrator'
import type { TextSink } from '@provino/reporters'
import type { ConfigSource, Diagnostic, NeutralProject, RunRequest } from '@provino/types'
import { ENVIRONMENTS } from './built-ins.ts'
import { usageMessage } from './describe.ts'
import { executeProject } from './execute.ts'
import { UsageError } from './usage-error.ts'

/**
 * Where the command reads and writes.
 * @internal
 */
export interface JestCommandIo {
  readonly stdout: TextSink
  readonly stderr: NodeJS.WritableStream
  readonly cwd: string
  readonly signal?: AbortSignal | undefined
}

/** The version of Jest the dialect mirrors, for `--showConfig`. */
const JEST_VERSION = '30.5.2'

/**
 * The exit code for a command line or config Jest refuses: the Jest dialect's own
 * `orchestrator.exitCodes.usage` (`cli/unknown-flag`, `cli/bad-config`).
 */
function usageExitCode(): number {
  const { policy } = jestNodeDialect
  if (typeof policy === 'function') return ExitCode.UsageError
  return policy.orchestrator?.exitCodes?.usage ?? ExitCode.UsageError
}

/** A diagnostic as a line (or lines) for the user. Jest's own texts keep their form. */
function describeDiagnostic(diagnostic: Diagnostic): string {
  if (diagnostic.message.trimStart().startsWith('●')) return diagnostic.message
  return `Provino: ${diagnostic.level === 'warning' ? 'warning: ' : ''}${diagnostic.message}`
}

/** Writes the diagnostics to `stderr`; true when any is an error. */
function report(diagnostics: readonly Diagnostic[], stderr: NodeJS.WritableStream): boolean {
  let failed = false
  for (const diagnostic of diagnostics) {
    stderr.write(`${describeDiagnostic(diagnostic)}\n`)
    if (diagnostic.level === 'error') failed = true
  }
  return failed
}

/** The projects of the config the request names (or the one found from `cwd`), unresolved. */
async function readProjects(
  argv: JestArgv,
  request: RunRequest,
  cwd: string,
): Promise<{
  readonly neutral: readonly NeutralProject[]
  readonly globalConfig: JestGlobalConfig
  readonly cache: boolean
  readonly showable: unknown
  readonly diagnostics: readonly Diagnostic[]
}> {
  const reader = createJestConfigReader({ argv, cwd })
  // No config file: Jest runs with its defaults over the working directory.
  const source: ConfigSource = (await reader.find(cwd, request.configPath)) ?? {
    kind: 'inline',
    path: cwd,
    text: '{}',
  }
  const raw = await reader.load(source)
  const resolved = await reader.resolve(raw, source)
  const neutral = reader.toNeutral(resolved.value)
  return {
    neutral: neutral.value,
    globalConfig: resolved.value.globalConfig,
    cache: resolved.value.configs.every((config) => config.cache),
    showable: resolved.value,
    diagnostics: [...resolved.diagnostics, ...neutral.diagnostics],
  }
}

/** Every project's test files, once each, sorted by path. */
async function listFiles(
  projects: readonly ResolvedProject[],
  request: RunRequest,
  cwd: string,
): Promise<readonly string[]> {
  const found = new Set<string>()
  for (const project of projects) {
    const files = selectFiles(await discoverProject(project), request.fileFilters, {
      rootDir: project.rootDir,
      cwd,
    })
    for (const file of files) found.add(file.path)
  }
  return [...found].sort()
}

/**
 * Runs one `provino jest` command line and resolves with the exit code. Bad input (a flag Jest
 * refuses or Provino can't run yet, a config Jest refuses, a pattern that isn't a regular
 * expression) is a message on `stderr` and Jest's exit code for it; any other error is a bug and
 * rejects.
 * @internal
 */
export async function runJestCommand(args: readonly string[], io: JestCommandIo): Promise<number> {
  const { stdout, stderr, cwd } = io
  const usage = usageExitCode()
  try {
    const parsed = jestCli.parse(args)
    if (report(parsed.diagnostics, stderr)) return usage
    const request = jestCli.toRunRequest(parsed.argv)
    const read = await readProjects(parsed.argv, request, cwd)
    if (report(read.diagnostics, stderr)) return usage

    if (request.mode === 'show-config') {
      await stdout.write(
        `${JSON.stringify({ ...(read.showable as object), version: JEST_VERSION }, null, '  ')}\n`,
      )
      return ExitCode.Pass
    }

    const projects: ResolvedProject[] = []
    for (const neutral of read.neutral) {
      projects.push(
        await resolveNeutralProject(neutral, {
          dialect: jestNodeDialect,
          environments: ENVIRONMENTS,
          ci: read.globalConfig.ci,
        }),
      )
    }

    if (request.mode === 'clear-cache') {
      for (const project of projects) {
        const directory = defaultCacheDir(project.rootDir)
        await rm(directory, { recursive: true, force: true })
        await stdout.write(`Cleared ${directory}\n`)
      }
      return ExitCode.Pass
    }
    if (request.mode === 'list-files') {
      const files = await listFiles(projects, request, cwd)
      if (!request.json) {
        await stdout.write(files.map((file) => `${file}\n`).join(''))
        return ExitCode.Pass
      }
      // `--json --outputFile`: Jest writes the list where the results would go.
      const outputFile = parsed.argv.outputFile
      if (typeof outputFile === 'string' && outputFile !== '') {
        await mkdir(dirname(resolve(cwd, outputFile)), { recursive: true })
        await writeFile(resolve(cwd, outputFile), JSON.stringify(files))
      } else {
        await stdout.write(`${JSON.stringify(files)}\n`)
      }
      return ExitCode.Pass
    }

    const [project, ...others] = projects
    if (project === undefined) throw new UsageError('the config has no project to run')
    if (others.length > 0) {
      // D29: reading `projects` is B14; running several is B17's.
      throw new UsageError(
        `running several projects is not supported yet (${projects.length} found; DECISIONS D29, B17)`,
      )
    }
    const result = await executeProject({
      project,
      cwd,
      stdout,
      stderr,
      pool: {
        ...(request.workerThreads === true ? { kind: 'threads' as const } : {}),
        maxWorkers: read.globalConfig.maxWorkers,
      },
      ...(request.cache === false || !read.cache ? { cache: false } : {}),
      testNamePattern: read.globalConfig.testNamePattern,
      fileFilters: request.fileFilters,
      signal: io.signal,
    })
    return result.exitCode
  } catch (error) {
    if (error instanceof JestCliError || error instanceof JestConfigError) {
      // Jest's own text, as Jest prints it.
      stderr.write(`${error.message}\n`)
      return usage
    }
    const message = usageMessage(error)
    if (message === undefined) throw error
    stderr.write(`${message}\n`)
    return usage
  }
}
