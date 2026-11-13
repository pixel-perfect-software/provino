import { USAGE } from './usage.ts'
import { packageVersion } from './version.ts'

/**
 * What `provino --version`, `--help` and `-h` print, or `undefined` for any other command line.
 * Only the first argument counts, as for every command. It imports nothing that loads a native
 * binding, so the bin answers from here before it imports the rest, and `main` answers from here
 * too: one implementation, so the two can't disagree.
 * @internal
 */
export function quickAnswer(argv: readonly string[]): string | undefined {
  const [first] = argv
  if (first === '--version') return `${packageVersion()}\n`
  if (first === '--help' || first === '-h') return USAGE
  return undefined
}
