import { parseArgs } from 'node:util'
import { HarnessError } from '../errors.ts'

/**
 * What the command line asked for.
 * @internal
 */
export interface RecordCommand {
  /** Compare with the committed goldens instead of writing them. */
  readonly check: boolean
  readonly keepWorkDir: boolean
  /** Fixture directories, or directories of fixtures. Empty means every fixture under `fixtures/`. */
  readonly fixtures: readonly string[]
}

/**
 * The usage text.
 * @internal
 */
export const USAGE = `Usage: provino-harness record [--check] [--keep] [<fixture dir>...]

  record   Run Jest and Vitest over each fixture and write __goldens__/<profile>.json.
           A directory is a fixture or holds fixtures (fixtures/runtime). With no directory,
           every fixture under packages/harness/fixtures/.

  --check  Compare with the committed goldens instead of writing them; exit 1 on drift.
  --keep   Keep the work directories under packages/harness/.record/.
`

function readArguments(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        check: { type: 'boolean', default: false },
        keep: { type: 'boolean', default: false },
      },
    })
  } catch (cause) {
    throw new HarnessError(
      'HARNESS_USAGE',
      cause instanceof Error ? cause.message : 'bad arguments',
      { cause },
    )
  }
}

/**
 * What `policy-diff` was asked for: the two dialects, in print order.
 * @internal
 */
export interface PolicyDiffCommand {
  readonly a: 'jest' | 'vitest'
  readonly b: 'jest' | 'vitest'
}

/**
 * The usage text of `policy-diff` (T1.8).
 * @internal
 */
export const POLICY_DIFF_USAGE = `Usage: provino-harness policy-diff <jest|vitest> <jest|vitest>

  Prints every policy key, hoisting rule and global name where the two dialects differ.
`

/**
 * Parses `provino-harness policy-diff <a> <b>` (the arguments after the command). Throws a
 * `HARNESS_USAGE` error unless they are two dialect names.
 * @internal
 */
export function parsePolicyDiff(argv: readonly string[]): PolicyDiffCommand {
  const isDialect = (name: string | undefined): name is 'jest' | 'vitest' =>
    name === 'jest' || name === 'vitest'
  const [a, b, ...rest] = argv
  if (!isDialect(a) || !isDialect(b) || rest.length > 0) {
    throw new HarnessError('HARNESS_USAGE', 'policy-diff takes two dialects: jest or vitest')
  }
  return { a, b }
}

/**
 * Parses `provino-harness` arguments. Throws a `HARNESS_USAGE` error on anything else.
 * @internal
 */
export function parseCommandLine(argv: readonly string[]): RecordCommand {
  const { values, positionals } = readArguments(argv)
  const [command, ...fixtures] = positionals
  if (command !== 'record') {
    throw new HarnessError(
      'HARNESS_USAGE',
      command === undefined ? 'missing command' : `unknown command "${command}"`,
    )
  }
  return { check: values.check, keepWorkDir: values.keep, fixtures }
}
