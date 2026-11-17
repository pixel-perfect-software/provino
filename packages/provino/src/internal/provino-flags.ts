// Provino's own flags on a `provino jest` command line, which Jest's parser would refuse as unknown:
// taken out before it sees the rest.
import type { ProvinoChoiceOptions } from '../types.ts'
import { UsageError } from './usage-error.ts'
import { viewsOf } from './views.ts'

/**
 * What `takeProvinoFlags` took out of a `provino jest` command line, and the rest for Jest.
 * @internal
 */
export interface ProvinoFlags {
  /** Jest's own arguments, in order. */
  readonly rest: readonly string[]
  /** `--timings <file>`. */
  readonly timingsFile: string | undefined
  /** `--update-timings`. */
  readonly updateTimings: boolean
  /** `--no-emoji`: the `provino` reporter draws plain symbols. */
  readonly noEmoji: boolean
  /** `--tree` and `--map`: the views the `provino` reporter prints; `{}` when neither is given. */
  readonly views: ProvinoChoiceOptions
}

/**
 * Takes Provino's own `--timings <file>` / `--timings=<file>`, `--update-timings`, `--no-emoji`,
 * `--tree` and `--map` out of a `provino jest` command line, since Jest's parser would refuse them
 * as unknown flags.
 * Everything after a `--` is Jest's (a path pattern named like a flag is a pattern), and a
 * `--timings` whose value is missing, empty or another flag is a usage error, so it never takes the
 * next flag.
 * @internal
 */
export function takeProvinoFlags(args: readonly string[]): ProvinoFlags {
  const rest: string[] = []
  let timingsFile: string | undefined
  let updateTimings = false
  let noEmoji = false
  let tree = false
  let map = false
  // `--timings=-x` names a file called `-x`; the next argument of `--timings x` that starts with `-` is a flag.
  const needsPath = (value: string | undefined, spaced: boolean): string => {
    if (value === undefined || value === '' || (spaced && value.startsWith('-'))) {
      throw new UsageError('--timings needs the path of a timings file')
    }
    return value
  }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string
    if (arg === '--') {
      rest.push(...args.slice(index))
      break
    }
    if (arg === '--update-timings') {
      updateTimings = true
    } else if (arg === '--no-emoji') {
      noEmoji = true
    } else if (arg === '--tree') {
      tree = true
    } else if (arg === '--map') {
      map = true
    } else if (arg === '--timings') {
      timingsFile = needsPath(args[++index], true)
    } else if (arg.startsWith('--timings=')) {
      timingsFile = needsPath(arg.slice('--timings='.length), false)
    } else {
      rest.push(arg)
    }
  }
  return {
    rest,
    timingsFile,
    updateTimings,
    noEmoji,
    views: viewsOf(tree, map),
  }
}
