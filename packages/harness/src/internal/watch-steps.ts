// A watch fixture's steps, played against a session (B23c Phase 3). The session and the run log
// are the host's, so the unit tests drive a fake terminal and the recorder a real one
// (`internal/watch-record.ts`).
import type { JsonValue } from '@provino/types'
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
  /**
   * Reads a file now (a `captureFile` step, once Jest has said it wrote its results: the steps
   * wait for that) as the golden keeps it: parsed and normalized. `key` is the capture's name,
   * `<file>#<n>` for the n-th capture of that file, for the host's errors.
   */
  captureFile(file: string, key: string): Promise<JsonValue>
}

/** How the steps ended. */
export interface WatchStepsResult {
  /** The runs the last `waitRun` waited for (0 when none did). */
  readonly runs: number
  /** The session's end, when the last step was `exit`. */
  readonly exit?: PtyExit
  /** What each `captureFile` step read, by key (`<file>#<n>`), in the order the steps asked. */
  readonly captures: Readonly<Record<string, JsonValue>>
}

/** What Jest prints, after it has written `--outputFile`, once per run. */
export const RESULTS_WRITTEN = 'Test results written to'

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
 * code is `HARNESS_WATCH_FAILED`. A `captureFile` step waits for the next `RESULTS_WRITTEN` line
 * (the n-th for the n-th capture: the run log's reporter finishes before Jest writes
 * `--outputFile`, so waiting on the log alone read no file, or the run before's), then asks the
 * host to read the file; the session's one deadline, or its end, is the wait's error.
 */
export async function runWatchSteps(
  steps: readonly WatchStep[],
  host: WatchHost,
): Promise<WatchStepsResult> {
  const { session } = host
  let mark = 0
  let resultsMark = 0
  let runs = 0
  const captures: Record<string, JsonValue> = {}
  const counted = new Map<string, number>()
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
        const line = `${PATTERN_CARET}${chars.slice(0, index + 1).join('')}`
        try {
          mark = await session.waitFor(line, from)
        } catch (error) {
          throw new HarnessError(
            'HARNESS_WATCH_FAILED',
            `the prompt never drew ${JSON.stringify(line)} after the "type" step wrote ${JSON.stringify(chars[index])} (character ${index + 1} of ${chars.length}): "type" works only in a pattern prompt (\`p\` or \`t\`, or a watch plugin's). ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          )
        }
      }
    } else if ('scm' in step) {
      for (const inner of step.scm) await host.change(inner)
    } else if ('captureFile' in step) {
      const count = (counted.get(step.captureFile) ?? 0) + 1
      counted.set(step.captureFile, count)
      const key = `${step.captureFile}#${count}`
      try {
        resultsMark = await session.waitFor(RESULTS_WRITTEN, resultsMark)
      } catch (error) {
        throw new HarnessError(
          'HARNESS_WATCH_FAILED',
          `Jest never wrote its results file for capture ${key} (${JSON.stringify(RESULTS_WRITTEN)}). ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        )
      }
      captures[key] = await host.captureFile(step.captureFile, key)
    } else if ('exit' in step) {
      const exit = await session.exit
      if (exit.exitCode !== step.exit) {
        throw new HarnessError(
          'HARNESS_WATCH_FAILED',
          `the session ended with exit code ${exit.exitCode}${exit.killed ? ' (killed)' : ''}, but the "exit" step expects ${step.exit}. Output tail:\n${session.output().slice(-2000)}`,
        )
      }
      return { runs, exit, captures }
    } else {
      await host.change(step)
    }
  }
  return { runs, captures }
}
