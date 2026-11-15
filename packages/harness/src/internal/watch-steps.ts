// A watch fixture's steps, played against a session (B23c Phase 3). The session and the run log
// are the host's, so the unit tests drive a fake terminal and the recorder a real one
// (`internal/watch-record.ts`).
import { HarnessError } from '../errors.ts'
import { type ScmStep, WATCH_KEYS, type WatchStep } from '../fixture.ts'
import type { PtyExit, PtyMatch } from '../pty.ts'

/** The part of a session the steps use. */
export interface WatchSession {
  write(text: string): void
  readonly output: () => string
  waitFor(match: PtyMatch, from?: number): Promise<number>
  readonly exit: Promise<PtyExit>
}

/** What the steps run against. */
export interface WatchHost {
  readonly session: WatchSession
  /**
   * Resolves once `count` runs have ended and Jest reads keys again (the recorder: the run log
   * and the done plugin's file both hold `count` lines). Rejects when either holds more (a run no
   * step waited for: the fixture is not deterministic), when the session ends first, or at the
   * deadline.
   */
  waitRuns(count: number): Promise<void>
  /** Applies a change to the work directory: `write`, `remove`, or one step of an `scm` list. */
  change(step: ScmStep): Promise<void>
}

/** How the steps ended. */
export interface WatchStepsResult {
  /** The runs the last `waitRun` waited for (0 when none did). */
  readonly runs: number
  /** The session's end, when the last step was `exit`. */
  readonly exit?: PtyExit
}

/** The bytes a `key` step sends. */
export function keyBytes(key: string): string {
  return WATCH_KEYS[key] ?? key
}

/**
 * What a pattern prompt draws before the text typed into it: jest-watcher's `printPatternCaret`
 * (`patternModeHelpers.ts` L12-21), which Jest's filename and test-name prompts and
 * jest-watch-typeahead's both call on every key, with colour off as the recorder runs them.
 */
export const PATTERN_CARET = ' pattern \u203a '

/**
 * Plays `steps` in order. A `waitText` looks only at output after the previous one's match, so a
 * text an earlier screen showed never satisfies a later step. `type` writes one character at a
 * time and waits for the prompt line to show the text typed so far (`PATTERN_CARET` and the
 * text), so no two characters, and no character and the key after it, reach Jest in one read: the
 * prompt draws that line while it handles the character. The text alone is not that echo: the
 * matches the prompt lists after its line hold it too (`foo` in ` › ./foo.test.ts`), and they can
 * still be arriving when the next character is written. An `exit` step that sees another exit
 * code is `HARNESS_WATCH_FAILED`.
 */
export async function runWatchSteps(
  steps: readonly WatchStep[],
  host: WatchHost,
): Promise<WatchStepsResult> {
  const { session } = host
  let mark = 0
  let runs = 0
  for (const step of steps) {
    if ('waitRun' in step) {
      await host.waitRuns(step.waitRun)
      runs = step.waitRun
    } else if ('waitText' in step) {
      mark = await session.waitFor(step.waitText, mark)
    } else if ('key' in step) {
      // What a key draws comes after it: a later `waitText` starts here at the earliest.
      mark = session.output().length
      session.write(keyBytes(step.key))
    } else if ('type' in step) {
      const chars = [...step.type]
      for (let index = 0; index < chars.length; index += 1) {
        const from = session.output().length
        session.write(chars[index] ?? '')
        mark = await session.waitFor(`${PATTERN_CARET}${chars.slice(0, index + 1).join('')}`, from)
      }
    } else if ('scm' in step) {
      for (const inner of step.scm) await host.change(inner)
    } else if ('exit' in step) {
      const exit = await session.exit
      if (exit.exitCode !== step.exit) {
        throw new HarnessError(
          'HARNESS_WATCH_FAILED',
          `the session ended with exit code ${exit.exitCode}${exit.killed ? ' (killed)' : ''}, but the "exit" step expects ${step.exit}. Output tail:\n${session.output().slice(-2000)}`,
        )
      }
      return { runs, exit }
    } else {
      await host.change(step)
    }
  }
  return { runs }
}
