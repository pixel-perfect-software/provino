// pnpm migrate:node-test rewrite <package> [--dry-run]
// pnpm migrate:node-test verify <package> [--runner <cli.js>] [--config <file>]
//
// Moves a package's tests from node:test to provino (B27g1) and proves no test was lost.
import { existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MigrateError } from './errors.ts'
import { rewritePackage, verifyPackage } from './node-test-migrate.ts'
import { formatDifference, isEmptyDifference } from './node-test-verify.ts'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const DEFAULT_RUNNER = 'node_modules/provino-runner/dist/cli.js'
const USAGE =
  'usage: migrate:node-test rewrite <package> [--dry-run]\n' +
  '       migrate:node-test verify <package> [--runner <cli.js>] [--config <file>]'

function takeFlag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name)
  if (at < 0) return undefined
  const value = args[at + 1]
  if (value === undefined)
    throw new MigrateError('MIGRATE_USAGE', name + ' needs a value\n' + USAGE)
  args.splice(at, 2)
  return value
}

/**
 * Runs the command; returns the exit code.
 * @internal
 */
export async function main(argv: readonly string[], out: (line: string) => void): Promise<number> {
  const args = [...argv]
  const [mode, name] = args
  if ((mode !== 'rewrite' && mode !== 'verify') || name === undefined) {
    throw new MigrateError('MIGRATE_USAGE', USAGE)
  }
  const rest = args.slice(2)
  const dryRun = rest.includes('--dry-run')
  const runner = takeFlag(rest, '--runner') ?? join(ROOT, DEFAULT_RUNNER)
  const config = takeFlag(rest, '--config')
  const packageDir = [resolve(name), join(ROOT, 'packages', name)].find((dir) =>
    existsSync(join(dir, 'package.json')),
  )
  if (packageDir === undefined) throw new MigrateError('MIGRATE_USAGE', 'no package at ' + name)
  const root = realpathSync(ROOT)
  const cacheDir = join(root, 'node_modules/.cache/provino-migrate')
  const dir = realpathSync(packageDir)

  if (mode === 'rewrite') {
    const report = await rewritePackage({ packageDir: dir, root, cacheDir, dryRun })
    for (const r of report.refusals) {
      out(r.code + ' ' + r.file + ':' + r.line + ':' + r.column + ' ' + r.message)
    }
    out(
      report.candidates +
        ' file(s) import node:test, ' +
        report.refusals.length +
        ' refused site(s)' +
        (dryRun ? ' (dry run: nothing written)' : ', ' + report.rewritten.length + ' rewritten'),
    )
    if (report.refusals.length > 0 && !dryRun)
      out('nothing was written: fix the sites above and run again')
    return report.refusals.length > 0 ? 1 : 0
  }
  const report = await verifyPackage({ packageDir: dir, root, cacheDir, runner, config })
  if (isEmptyDifference(report.difference)) {
    out('verify: all ' + report.tests + ' test(s) match, names and statuses')
    return 0
  }
  out('verify: the runs differ\n' + formatDifference(report.difference))
  return 1
}

const entry = process.argv[1]
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2), (line) => console.log(line)).then(
    (code) => {
      process.exitCode = code
    },
    (error: unknown) => {
      if (error instanceof MigrateError) console.error(error.code + ' ' + error.message)
      else console.error(error)
      process.exitCode = 2
    },
  )
}
