// Decision D22: a global a file leaves behind that the environment can't remove is a warning, not
// a failure. The environment's `teardown` returns an `EnvironmentTeardownReport` naming the keys;
// this reads it and builds the `console` event the worker sends for it.
import type { RuntimeEventOf } from '@provino/types'
import { WorkerError } from '../../errors.ts'
import { isRecord, isStringArray } from './guards.ts'

/**
 * The keys a `teardown` reported it could not remove. A clean teardown returns nothing (or
 * anything that is not a report), which is no keys. A value that has a `leakedGlobals` key must be
 * an array of strings: an environment that tried to report and got the shape wrong is
 * `ORCH_BAD_ENVIRONMENT`, charged to the file like any teardown failure.
 * @internal
 */
export function leakedGlobalsOf(report: unknown, environmentName: string): readonly string[] {
  if (!isRecord(report) || !('leakedGlobals' in report)) return []
  const { leakedGlobals } = report
  if (!isStringArray(leakedGlobals)) {
    throw new WorkerError(
      'ORCH_BAD_ENVIRONMENT',
      `The environment "${environmentName}" returned a teardown report whose leakedGlobals is not an array of strings`,
    )
  }
  return leakedGlobals
}

const globals = (keys: readonly string[]): string =>
  `${keys.length} ${keys.length === 1 ? 'global' : 'globals'}`

/**
 * The `console` event for a warning: level `warn`, on stderr, charged to no task. It has the
 * fields the console capture gives a `console.warn` call, so a reporter treats it the same. (It is
 * built by hand because `console.warn` would indent it inside a `console.group` that is open.)
 */
function leakWarningEvent(text: string): RuntimeEventOf<'console'> {
  return {
    type: 'console',
    taskId: null,
    stream: 'stderr',
    level: 'warn',
    text,
    origin: null,
    t: performance.now(),
  }
}

/**
 * The warning for a file whose (file-scoped) teardown left `keys` behind. It names the file and
 * the keys, and says what the cost is: the next files in this worker see them.
 * @internal
 */
export function fileLeakEvent(file: string, keys: readonly string[]): RuntimeEventOf<'console'> {
  return leakWarningEvent(
    `Provino: ${file} left ${globals(keys)} behind that the environment could not remove: ${keys.join(', ')}. Later files in this worker can see ${keys.length === 1 ? 'it' : 'them'}.\n`,
  )
}

/**
 * The warning for a worker-scoped environment (isolation `none`) whose teardown at `stop` left
 * `keys` behind.
 * @internal
 */
export function workerLeakEvent(keys: readonly string[]): RuntimeEventOf<'console'> {
  return leakWarningEvent(
    `Provino: the environment could not remove ${globals(keys)} when the worker stopped: ${keys.join(', ')}.\n`,
  )
}
