// `core.timeouts.message` for Jest: the words jest-circus 30.5.2 gives a test's or a hook's timeout
// (`utils.ts` `_makeTimeoutMessage`, L314-L320), as the failure has them. jest-circus rejects with
// that string, and `_getError` (`jestAdapterInit.ts`) turns a thrown value that is no error into
// `thrown: ${prettyFormat(value, { maxDepth: 3 })}`, which for a string is the text in double
// quotes. Recorded: `runtime/timeouts` (a test and a hook), `runtime/done-callback` (a test that
// takes `done`), `runtime/done-hooks` (a hook that takes `done`), also `facade/test-timeout-hooks`
// and `facade/set-timeout-late` (a timeout given late, and a negative one, which prints as given).
import type { FormatTimeout } from '@provino/types'

/** The second line of the message: the same for a test and a hook, as Jest words it. */
const ADVICE =
  'Add a timeout value to this test to increase the timeout, if this is a long-running test. See https://jestjs.io/docs/api#testname-fn-timeout.'

/**
 * Words a timeout as jest-circus does: `Exceeded timeout of <ms> ms for a <test|hook>[ while
 * waiting for `done()` to be called].`, then the advice, quoted the way a thrown string is
 * printed.
 * @public
 */
export const formatTimeout: FormatTimeout = ({ subject, ms, done }) =>
  `thrown: "Exceeded timeout of ${ms} ms for a ${subject}${
    done ? ' while waiting for `done()` to be called' : ''
  }.\n${ADVICE}"`
