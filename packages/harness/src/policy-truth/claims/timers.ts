// The evidence for the `timers` slice (T1.7): `policy/timers` drives each runner's fake timers
// through its own `jest` or `vi` object and names the value it saw.
import { type Claims, each, golden, pending } from '../evidence.ts'

const timers = golden('timers')

export const timersClaims: Claims = {
  'timers.toFakeDefault': timers,
  'timers.loopLimit': each(timers, [timers, golden('defaults')]),
  'timers.fakeTemporal': pending(
    'B17a',
    'neither runner fakes a Temporal the recording Node lacks; T4.9 records it where Temporal exists',
  ),
  'timers.legacyAvailable': timers,
  'timers.enableGlobally': each([timers, golden('defaults')], timers),
  'timers.optionNames': timers,
  'timers.notFaked': timers,
  'timers.setSystemTimeWithoutFakes': timers,
  'timers.advanceToNextTimerHonorsSteps': timers,
  'timers.facadeReturns': timers,
}
