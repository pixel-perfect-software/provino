// pnpm migrate:node-test rewrite <package> [--dry-run]
// pnpm migrate:node-test verify <package> [--runner <cli.js>] [--config <file>]
//
// Moves a package's tests from node:test to provino (B27g1) and proves no test was lost. The
// package is a path, a workspace name (@provino/core), a directory (packages/core) or a bare name.
// Exit 0: done; 1: refused sites, or verify found a difference; 2: bad usage or a failed step.
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { ROOT } from '../workspace.ts'
import { MigrateError } from './errors.ts'
import { formatDifference, isEmptyDifference } from './node-test-compare.ts'
import { findPackage, rewritePackage, verifyPackage } from './node-test-migrate.ts'
import { formatRefusal } from './node-test-rewrite.ts'
import { scaffoldPackage } from './scaffold.ts'

/** This checkout's built bin (D203, until the one release moves it to a pinned rc, D191): `pnpm build` first. */
const DEFAULT_RUNNER = join(ROOT, 'packages/provino/dist/cli.js')
const USAGE =
  'usage: migrate:node-test rewrite <package> [--dry-run]\n' +
  '       migrate:node-test verify <package> [--runner <cli.js>] [--config <file>]'

/** Where `main` writes. */
export interface CliIo {
  readonly out: (line: string) => void
  readonly err: (line: string) => void
  /** Where baselines go; the checkout's `node_modules/.cache/provino-migrate` when absent. */
  readonly cacheDir?: string
}

function usageError(message: string): MigrateError {
  return new MigrateError('MIGRATE_USAGE', `${message}\n${USAGE}`)
}

function parse(argv: readonly string[]): {
  mode: 'rewrite' | 'verify'
  name: string
  dryRun: boolean
  runner: string | undefined
  config: string | undefined
} {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true })
  } catch (cause) {
    throw usageError(cause instanceof Error ? cause.message : String(cause))
  }
  const [mode, name, ...extra] = parsed.positionals
  if ((mode !== 'rewrite' && mode !== 'verify') || name === undefined) {
    throw usageError('a mode (rewrite or verify) and a package are required')
  }
  if (extra.length > 0) throw usageError(`unexpected argument ${extra[0]}`)
  const { 'dry-run': dryRun = false, runner, config } = parsed.values
  if (mode === 'verify' && dryRun) throw usageError('--dry-run belongs to rewrite')
  if (mode === 'rewrite' && (runner !== undefined || config !== undefined)) {
    throw usageError('--runner and --config belong to verify')
  }
  return { mode, name, dryRun, runner, config }
}

const OPTIONS = {
  'dry-run': { type: 'boolean' },
  runner: { type: 'string' },
  config: { type: 'string' },
} as const

/**
 * Runs the command and returns the exit code; bad usage and failed steps are written to `io.err`
 * with their code.
 * @internal
 */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    const { mode, name, dryRun, runner, config } = parse(argv)
    const packageDir = findPackage(name)
    const root = realpathSync(ROOT)
    const cacheDir = io.cacheDir ?? join(root, 'node_modules/.cache/provino-migrate')

    if (mode === 'rewrite') {
      const report = await rewritePackage({ packageDir, root, cacheDir, dryRun })
      for (const refusal of report.refusals) io.out(formatRefusal(refusal))
      const sites = `${report.candidates} file(s) import node:test, ${report.refusals.length} refused site(s)`
      if (dryRun) io.out(`${sites} (dry run: nothing written)`)
      else if (report.refusals.length > 0)
        io.out(`${sites}: nothing was written, fix the sites above and run again`)
      else if (report.nothingToMigrate) {
        io.out(`${sites}: no node:test files are left, the existing baseline is kept`)
        for (const line of await scaffoldPackage(root, packageDir)) io.out(`scaffolded ${line}`)
      } else {
        io.out(
          `${sites}, ${report.rewritten.length} rewritten; recorded ${report.baselineTests} baseline test(s)`,
        )
        for (const line of await scaffoldPackage(root, packageDir)) io.out(`scaffolded ${line}`)
      }
      return report.refusals.length > 0 ? 1 : 0
    }

    const runnerPath = runner ?? DEFAULT_RUNNER
    if (!existsSync(runnerPath)) {
      throw new MigrateError(
        'MIGRATE_USAGE',
        `no runner at ${runnerPath}: run pnpm build or pass --runner <cli.js>`,
      )
    }
    const report = await verifyPackage({ packageDir, root, cacheDir, runner: runnerPath, config })
    if (report.leftOutFiles > 0) {
      io.out(
        `verify: left out ${report.leftOutFiles} file(s) (${report.leftOutTests} test(s)) in the bootstrap set`,
      )
    }
    if (isEmptyDifference(report.difference)) {
      io.out(`verify: all ${report.tests} test(s) match, names and statuses`)
      return 0
    }
    io.out(`verify: the runs differ\n${formatDifference(report.difference)}`)
    return 1
  } catch (error) {
    if (!(error instanceof MigrateError)) throw error
    io.err(`${error.code} ${error.message}`)
    return 2
  }
}

const entry = process.argv[1]
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2), {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  }).then(
    (code) => {
      process.exitCode = code
    },
    (error: unknown) => {
      console.error(error)
      process.exitCode = 2
    },
  )
}
