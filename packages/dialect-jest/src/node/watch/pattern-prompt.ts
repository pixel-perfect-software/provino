// jest-watcher `PatternPrompt.ts` L16-L61 and `lib/patternModeHelpers.ts` L12-L34, with jest-core's
// `TestPathPatternPrompt.ts` and `TestNamePatternPrompt.ts` (L15-L32 each): the Pattern Mode
// screen and the caret line each key redraws.
import type { JestWatchTerminal } from './context.ts'
import type { JestPrompt, JestScrollOptions } from './prompt.ts'
import { jestStringLength } from './terminal.ts'

/** `PatternPrompt.ts` L16-L21. */
function usage(terminal: JestWatchTerminal, entity: string): string {
  const { style } = terminal
  return (
    `\n${style.bold('Pattern Mode Usage')}\n` +
    ` ${style.dim('› Press')} Esc ${style.dim('to exit pattern mode.')}\n` +
    ` ${style.dim('› Press')} Enter ` +
    `${style.dim(`to filter by a ${entity} regex pattern.`)}\n` +
    '\n'
  )
}

/** `PatternPrompt.ts` L23: the rows of the usage, counted on the plain text. */
const USAGE_ROWS = '\nPattern Mode Usage\n x\n x\n\n'.split('\n').length

/**
 * `printPatternCaret` (`patternModeHelpers.ts` L12-L21): erase below, the ` pattern › ` line, save
 * the cursor.
 * @beta
 */
export function printPatternCaret(pattern: string, terminal: JestWatchTerminal): void {
  const { out, escapes, style } = terminal
  out.write(escapes.eraseDown)
  out.write(`${style.dim(' pattern ›')} ${pattern}`)
  out.write(escapes.cursorSavePosition)
}

/**
 * `printRestoredPatternCaret` (`patternModeHelpers.ts` L23-L34): the cursor to the end of the
 * pattern on the prompt's row, then restored.
 * @beta
 */
export function printRestoredPatternCaret(
  pattern: string,
  currentUsageRows: number,
  terminal: JestWatchTerminal,
): void {
  const { out, escapes, style } = terminal
  const inputText = `${style.dim(' pattern ›')} ${pattern}`
  out.write(escapes.cursorTo(jestStringLength(inputText), currentUsageRows - 1))
  out.write(escapes.cursorRestorePosition)
}

/**
 * The filename (`entity` `filenames`) or test-name (`tests`) prompt: `run` draws the screen and
 * hands the keys to `prompt`, each change erases the line and draws the caret again.
 * @beta
 */
export class JestPatternPrompt {
  #currentUsageRows = USAGE_ROWS
  readonly #terminal: JestWatchTerminal
  readonly #prompt: JestPrompt
  readonly #entity: string

  constructor(terminal: JestWatchTerminal, prompt: JestPrompt, entity: 'filenames' | 'tests') {
    this.#terminal = terminal
    this.#prompt = prompt
    this.#entity = entity
  }

  /** `PatternPrompt.ts` L36-L55. */
  run(
    onSuccess: (value: string) => void,
    onCancel: () => void,
    options?: { readonly header: string },
  ): void {
    const { out, escapes, clear } = this.#terminal
    out.write(escapes.cursorHide)
    out.write(clear)
    if (typeof options?.header === 'string' && options.header !== '') {
      out.write(`${options.header}\n`)
      this.#currentUsageRows = USAGE_ROWS + options.header.split('\n').length
    } else {
      this.#currentUsageRows = USAGE_ROWS
    }
    out.write(usage(this.#terminal, this.#entity))
    out.write(escapes.cursorShow)
    this.#prompt.enter((pattern, scroll) => this.#onChange(pattern, scroll), onSuccess, onCancel)
  }

  /** `PatternPrompt.ts` L57-L60, then the subclass's `_printPrompt`. */
  #onChange(pattern: string, _options: JestScrollOptions): void {
    const { out, escapes } = this.#terminal
    out.write(escapes.eraseLine)
    out.write(escapes.cursorLeft)
    printPatternCaret(pattern, this.#terminal)
    printRestoredPatternCaret(pattern, this.#currentUsageRows, this.#terminal)
  }
}
