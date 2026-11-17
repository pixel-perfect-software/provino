// The `provino` reporter's views (`--tree`, `--map`), as every command line and option that asks
// for them says them: one shape, built and tested in one place. No imports beyond a type and the
// usage error, so the flag parsers can use it without loading the reporters.
import type { ProvinoChoiceOptions } from '../types.ts'
import { UsageError } from './usage-error.ts'

/**
 * The views a pair of flags asks for: `{}` when neither is on, so it can be spread over the options
 * of a `provino` reporter choice.
 * @internal
 */
export function viewsOf(tree: boolean | undefined, map: boolean | undefined): ProvinoChoiceOptions {
  return {
    ...(tree === true ? { tree: true as const } : {}),
    ...(map === true ? { map: true as const } : {}),
  }
}

/**
 * Whether any view is on.
 * @internal
 */
export function hasViews(views: ProvinoChoiceOptions): boolean {
  return views.tree === true || views.map === true
}

/**
 * The usage error for views asked for while reporters are named and `provino` is not among them
 * (`--tree needs the provino reporter`): they are its options. `reportersFor` throws it after it
 * parses the choices; `provino jest` throws it before it loads a third-party reporter module.
 * @internal
 */
export function viewsNeedProvino(views: ProvinoChoiceOptions): UsageError {
  const flags = [
    ...(views.tree === true ? ['--tree'] : []),
    ...(views.map === true ? ['--map'] : []),
  ]
  return new UsageError(
    `${flags.join(' and ')} ${flags.length > 1 ? 'need' : 'needs'} the provino reporter`,
  )
}
