// jest-core `SnapshotInteractiveMode.ts` L16-L248 (Jest 30.5.2): `i` after a run with snapshots
// that don't match steps through their tests one at a time, each run alone, with `u` to update the
// one shown, `s` to skip it, `r` to start again, and `q` or Esc to leave.
import type { JestWatchTerminal } from './context.ts'
import {
  JEST_ARROW,
  type JestAssertionLocation,
  jestPluralize,
} from './failed-tests-interactive-mode.ts'
import type { JestWatchResults } from './hooks.ts'

/**
 * The interactive snapshot mode (`SnapshotInteractiveMode`). `run` calls `onConfigChange` with the
 * test to run next and whether its snapshots are updated, or with `null` when the mode ends.
 * @beta
 */
export class JestSnapshotInteractiveMode {
  #isActive = false
  #updateTestRunnerConfig: (
    assertion: JestAssertionLocation | null,
    shouldUpdateSnapshot: boolean,
  ) => unknown = () => {}
  #testAssertions: (JestAssertionLocation | undefined)[] = []
  #countPaths = 0
  #skippedNum = 0
  readonly #terminal: JestWatchTerminal

  constructor(terminal: JestWatchTerminal) {
    this.#terminal = terminal
  }

  isActive(): boolean {
    return this.#isActive
  }

  getSkippedNum(): number {
    return this.#skippedNum
  }

  /** L41-L44 */
  #clearTestSummary(): void {
    const { out, escapes } = this.#terminal
    out.write(escapes.cursorUp(6))
    out.write(escapes.eraseDown)
  }

  #press(key: string, what: string): string {
    const { style } = this.#terminal
    return `${style.dim(`${JEST_ARROW}Press `)}${key}${style.dim(what)}`
  }

  /** The stats line after the count: how many were updated and skipped. */
  #tally(stats: string, numPass: number, skipped: boolean): string {
    const { style } = this.#terminal
    let text = stats
    if (numPass)
      text += `, ${style.bold(style.green(`${jestPluralize('snapshot', numPass)} updated`))}`
    if (skipped && this.#skippedNum) {
      text += `, ${style.bold(style.yellow(`${jestPluralize('snapshot', this.#skippedNum)} skipped`))}`
    }
    return text
  }

  /** L46-L87 */
  #drawUIProgress(): void {
    const { style } = this.#terminal
    this.#clearTestSummary()
    const numPass = this.#countPaths - this.#testAssertions.length
    const numRemaining = this.#countPaths - numPass - this.#skippedNum
    const stats = this.#tally(
      style.bold(style.dim(`${jestPluralize('snapshot', numRemaining)} remaining`)),
      numPass,
      true,
    )
    const messages = [
      `\n${style.bold('Interactive Snapshot Progress')}`,
      JEST_ARROW + stats,
      `\n${style.bold('Watch Usage')}`,
      this.#press('u', ' to update failing snapshots for this test.'),
      this.#press('s', ' to skip the current test.'),
      this.#press('q', ' to quit Interactive Snapshot Mode.'),
      this.#press('Enter', ' to trigger a test run.'),
    ]
    this.#terminal.out.write(`${messages.filter(Boolean).join('\n')}\n`)
  }

  /** L89-L121 */
  #drawUIDoneWithSkipped(): void {
    const { out, style } = this.#terminal
    out.write(this.#terminal.clear)
    const numPass = this.#countPaths - this.#testAssertions.length
    const stats = this.#tally(
      style.bold(style.dim(`${jestPluralize('snapshot', this.#countPaths)} reviewed`)),
      numPass,
      true,
    )
    const messages = [
      `\n${style.bold('Interactive Snapshot Result')}`,
      JEST_ARROW + stats,
      `\n${style.bold('Watch Usage')}`,
      this.#press('r', ' to restart Interactive Snapshot Mode.'),
      this.#press('q', ' to quit Interactive Snapshot Mode.'),
    ]
    out.write(`${messages.filter(Boolean).join('\n')}\n`)
  }

  /** L123-L146 */
  #drawUIDone(): void {
    const { out, style } = this.#terminal
    out.write(this.#terminal.clear)
    const numPass = this.#countPaths - this.#testAssertions.length
    const stats = this.#tally(
      style.bold(style.dim(`${jestPluralize('snapshot', this.#countPaths)} reviewed`)),
      numPass,
      false,
    )
    const messages = [
      `\n${style.bold('Interactive Snapshot Result')}`,
      JEST_ARROW + stats,
      `\n${style.bold('Watch Usage')}`,
      this.#press('Enter', ' to return to watch mode.'),
    ]
    out.write(`${messages.filter(Boolean).join('\n')}\n`)
  }

  /** L148-L158 */
  #drawUIOverlay(): void {
    if (this.#testAssertions.length === 0) {
      this.#drawUIDone()
      return
    }
    if (this.#testAssertions.length - this.#skippedNum === 0) {
      this.#drawUIDoneWithSkipped()
      return
    }
    this.#drawUIProgress()
  }

  /** L160-L195 */
  put(key: string): void {
    const { keys } = this.#terminal
    switch (key) {
      case 's': {
        if (this.#skippedNum === this.#testAssertions.length) break
        this.#skippedNum += 1
        // move skipped test to the end
        this.#testAssertions.push(this.#testAssertions.shift())
        if (this.#testAssertions.length - this.#skippedNum > 0) this.#run(false)
        else this.#drawUIDoneWithSkipped()
        break
      }
      case 'u':
        this.#run(true)
        break
      case 'q':
      case keys.ESCAPE:
        this.abort()
        break
      case 'r':
        this.restart()
        break
      case keys.ENTER:
        if (this.#testAssertions.length === 0) this.abort()
        else this.#run(false)
        break
      default:
        break
    }
  }

  /** L197-L201 */
  abort(): void {
    this.#isActive = false
    this.#skippedNum = 0
    this.#updateTestRunnerConfig(null, false)
  }

  /** L203-L207 */
  restart(): void {
    this.#skippedNum = 0
    this.#countPaths = this.#testAssertions.length
    this.#run(false)
  }

  /** L209-L224 */
  updateWithResults(results: JestWatchResults): void {
    if (results.snapshot.failure) {
      this.#drawUIOverlay()
      return
    }
    this.#testAssertions.shift()
    if (this.#testAssertions.length - this.#skippedNum === 0) {
      this.#drawUIOverlay()
      return
    }
    // Go to the next test
    this.#run(false)
  }

  /** L226-L229. With every test gone (`u` on the result screen), Jest passes `undefined`. */
  #run(shouldUpdateSnapshot: boolean): void {
    this.#updateTestRunnerConfig(this.#testAssertions[0] ?? null, shouldUpdateSnapshot)
  }

  /** L231-L247 */
  run(
    failedSnapshotTestAssertions: readonly JestAssertionLocation[],
    onConfigChange: (
      assertion: JestAssertionLocation | null,
      shouldUpdateSnapshot: boolean,
    ) => unknown,
  ): void {
    if (failedSnapshotTestAssertions.length === 0) return
    this.#testAssertions = [...failedSnapshotTestAssertions]
    this.#countPaths = this.#testAssertions.length
    this.#updateTestRunnerConfig = onConfigChange
    this.#isActive = true
    this.#run(false)
  }
}
