import { parseArgs } from 'node:util'
import { HarnessError } from '../errors.ts'

/**
 * What the command line asked for.
 * @internal
 */
export interface RecordCommand {
  readonly command: 'record'
  /** Compare with the committed goldens instead of writing them. */
  readonly check: boolean
  readonly keepWorkDir: boolean
  /** Fixture directories. Empty means every fixture under `fixtures/`. */
  readonly fixtures: readonly string[]
}

/**
 * The usage text.
 * @internal
 */
export const USAGE = `Usage: provino-harness record [--check] [--keep] [<fixture dir>...]

  record   Run Jest and Vitest over each fixture and write __goldens__/<runner>.json.
           With no directory, every fixture under packages/harness/fixtures/.

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
  return { command, check: values.check, keepWorkDir: values.keep, fixtures }
}
