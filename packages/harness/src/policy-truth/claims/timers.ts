// The evidence for the `timers` slice (T1.7): `policy/timers` drives each runner's fake timers
// through its own `jest` or `vi` object and names the value it saw; B17a's `mocking/timers-*`
// fixtures record the rest (Temporal on a Node run with `--harmony-temporal`, what the members
// return, the words of the not-faked error).
import { type Claims, each, golden } from '../evidence.ts'
import { observation } from '../observe.ts'

const timers = golden('timers')

/** The `observe` case that shows a member's return, as `facade`, `undefined` or a promise of those. */
const FACADE_ON_OFF = 'what the members that switch timers on and off return'
const FACADE_MOVE = 'what the members that move the clock return'
const FACADE_ASYNC = 'what the async members return'
const NOT_FAKED = 'advanceTimersByTime while the timers are real'

type Returns = Readonly<Record<string, unknown>>

/** `all` when every timer member returned the object, `lifecycle` when only the on/off ones did. */
function facadeReturns(g: Parameters<NonNullable<ReturnType<typeof golden>['read']>>[0]): string {
  const lifecycle = Object.values(observation(g, FACADE_ON_OFF) as Returns)
  const moving = Object.values(observation(g, FACADE_MOVE) as Returns)
  const asyncMembers = Object.values(observation(g, FACADE_ASYNC) as Returns).map(
    (value) => (value as { promise?: unknown }).promise,
  )
  if (!lifecycle.every((value) => value === 'facade')) return 'neither'
  if ([...moving, ...asyncMembers].every((value) => value === 'facade')) return 'all'
  if ([...moving, ...asyncMembers].every((value) => value === 'undefined')) return 'lifecycle'
  return 'mixed'
}

export const timersClaims: Claims = {
  'timers.toFakeDefault': timers,
  'timers.loopLimit': each(timers, [timers, golden('defaults')]),
  // Both runners fake Temporal when the Node has one (`policy/timers-temporal`, recorded with
  // `--harmony-temporal`, which Node 24 needs).
  'timers.fakeTemporal': golden('timers-temporal', {
    read: (g) =>
      (
        observation(
          g,
          'useFakeTimers() with no options fakes Temporal, and Temporal.Now follows the clock',
        ) as { faked: boolean }
      ).faked,
  }),
  'timers.legacyAvailable': timers,
  'timers.enableGlobally': each([timers, golden('defaults')], timers),
  'timers.optionNames': timers,
  'timers.notFaked': timers,
  'timers.setSystemTimeWithoutFakes': timers,
  'timers.advanceToNextTimerHonorsSteps': timers,
  'timers.facadeReturns': golden('mocking/timers-facade', { read: facadeReturns }),
  // The text the runner warns with (Jest) or throws (Vitest), and whether Jest's ends with its stack.
  'timers.messages.notFaked': golden('mocking/timers-not-faked', {
    matches: (g, value) => {
      const seen = observation(g, NOT_FAKED) as {
        threw: string
        warned: readonly string[]
        stackSection: readonly boolean[]
      }
      const text = seen.threw === 'did not throw' ? seen.warned[0] : seen.threw
      return value === `${text}${seen.stackSection[0] === true ? '\nStack Trace:\n{stack}' : ''}`
    },
  }),
}
