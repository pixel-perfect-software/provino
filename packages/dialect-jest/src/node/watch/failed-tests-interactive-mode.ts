// jest-core `FailedTestsInteractiveMode.ts` L14-L195 (Jest 30.5.2): `i` after a run with failed
// tests steps through them one at a time, each run alone (`^fullName$` in its file), with `s` to
// skip one, `r` to start again, and `q` or Esc to leave.
import type { JestWatchTerminal } from './context.ts'
import type { JestWatchResults } from './hooks.ts'

/**
 * A test that failed, by its full name and its file (`AssertionLocation`).
 * @beta
 */
export interface JestAssertionLocation {
  readonly fullName: string
  readonly path: string
}

/**
 * jest-util `specialChars.ARROW` (`specialChars.ts` L9).
 * @beta
 */
export const JEST_ARROW: string = ' › '

/**
 * jest-util `pluralize` (`pluralize.ts` L8-L10).
 * @beta
 */
export function jestPluralize(word: string, count: number): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/**
 * The interactive failed-tests mode (`FailedTestsInteractiveMode`). `run` calls `updateConfig`
 * with the test to run next, or with nothing when the mode ends.
 * @beta
 */
export class JestFailedTestsInteractiveMode {
  #isActive = false
  #countPaths = 0
  #skippedNum = 0
  #testAssertions: JestAssertionLocation[] = []
  #updateTestRunnerConfig: ((failure?: JestAssertionLocation) => void) | undefined
  readonly #terminal: JestWatchTerminal

  constructor(terminal: JestWatchTerminal) {
    this.#terminal = terminal
  }

  isActive(): boolean {
    return this.#isActive
  }

  /** L37-L70 */
  put(key: string): void {
    const { keys } = this.#terminal
    switch (key) {
      case 's': {
        if (this.#skippedNum === this.#testAssertions.length) break
        this.#skippedNum += 1
        // move skipped test to the end
        const first = this.#testAssertions.shift()
        if (first !== undefined) this.#testAssertions.push(first)
        if (this.#testAssertions.length - this.#skippedNum > 0) this.#run()
        else this.#drawUIDoneWithSkipped()
        break
      }
      case 'q':
      case keys.ESCAPE:
        this.#abort()
        break
      case 'r':
        this.#restart()
        break
      case keys.ENTER:
        if (this.#testAssertions.length === 0) this.#abort()
        else this.#run()
        break
      default:
    }
  }

  /** L72-L83 */
  run(
    failedTestAssertions: readonly JestAssertionLocation[],
    updateConfig: (failure?: JestAssertionLocation) => void,
  ): void {
    if (failedTestAssertions.length === 0) return
    this.#testAssertions = [...failedTestAssertions]
    this.#countPaths = this.#testAssertions.length
    this.#updateTestRunnerConfig = updateConfig
    this.#isActive = true
    this.#run()
  }

  /** L85-L97 */
  updateWithResults(results: JestWatchResults): void {
    if (!results.snapshot.failure && results.numFailedTests > 0) {
      this.#drawUIOverlay()
      return
    }
    this.#testAssertions.shift()
    if (this.#testAssertions.length === 0) {
      this.#drawUIOverlay()
      return
    }
    // Go to the next test
    this.#run()
  }

  /** L99-L102 */
  #clearTestSummary(): void {
    const { out, escapes } = this.#terminal
    out.write(escapes.cursorUp(6))
    out.write(escapes.eraseDown)
  }

  #describeKey(key: string, description: string): string {
    const { style } = this.#terminal
    return `${style.dim(`${JEST_ARROW}Press`)} ${key} ${style.dim(description)}`
  }

  /** L104-L113 */
  #drawUIDone(): void {
    const { out, style } = this.#terminal
    out.write(this.#terminal.clear)
    const messages = [
      style.bold('Watch Usage'),
      this.#describeKey('Enter', 'to return to watch mode.'),
    ]
    out.write(`${messages.join('\n')}\n`)
  }

  /** L115-L139 */
  #drawUIDoneWithSkipped(): void {
    const { out } = this.#terminal
    out.write(this.#terminal.clear)
    let stats = `${jestPluralize('test', this.#countPaths)} reviewed`
    if (this.#skippedNum > 0) stats = `${stats}, ${this.#skippedText()}`
    const message = [
      this.#progressLabel(),
      `${JEST_ARROW}${stats}`,
      '\n',
      this.#terminal.style.bold('Watch Usage'),
      this.#describeKey('r', 'to restart Interactive Mode.'),
      this.#describeKey('q', 'to quit Interactive Mode.'),
      this.#describeKey('Enter', 'to return to watch mode.'),
    ]
    out.write(`\n${message.join('\n')}`)
  }

  /** L141-L167 */
  #drawUIProgress(): void {
    this.#clearTestSummary()
    const numPass = this.#countPaths - this.#testAssertions.length
    const numRemaining = this.#countPaths - numPass - this.#skippedNum
    let stats = `${jestPluralize('test', numRemaining)} remaining`
    if (this.#skippedNum > 0) stats = `${stats}, ${this.#skippedText()}`
    const message = [
      this.#progressLabel(),
      `${JEST_ARROW}${stats}`,
      '\n',
      this.#terminal.style.bold('Watch Usage'),
      this.#describeKey('s', 'to skip the current test.'),
      this.#describeKey('q', 'to quit Interactive Mode.'),
      this.#describeKey('Enter', 'to return to watch mode.'),
    ]
    this.#terminal.out.write(`\n${message.join('\n')}`)
  }

  #progressLabel(): string {
    return this.#terminal.style.bold('Interactive Test Progress')
  }

  #skippedText(): string {
    const { style } = this.#terminal
    return style.bold(style.yellow(`${jestPluralize('test', this.#skippedNum)} skipped`))
  }

  /** L169-L173 */
  #drawUIOverlay(): void {
    if (this.#testAssertions.length === 0) this.#drawUIDone()
    else this.#drawUIProgress()
  }

  /** L175-L179 */
  #run(): void {
    this.#updateTestRunnerConfig?.(this.#testAssertions[0])
  }

  /** L181-L188 */
  #abort(): void {
    this.#isActive = false
    this.#skippedNum = 0
    this.#updateTestRunnerConfig?.()
  }

  /** L190-L194 */
  #restart(): void {
    this.#skippedNum = 0
    this.#countPaths = this.#testAssertions.length
    this.#run()
  }
}
