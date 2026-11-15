// jest-watcher `lib/Prompt.ts` L11-L115: the line a pattern prompt edits, key by key.
import type { JestWatchKeys } from './keys.ts'

/**
 * Where the prompt's scrolled list starts (`ScrollOptions`).
 * @beta
 */
export interface JestScrollOptions {
  readonly offset: number
  readonly max: number
}

/**
 * A terminal whose resizes redraw the prompt (Jest listens on `process.stdout`).
 * @beta
 */
export interface JestResizeSource {
  on(event: 'resize', listener: () => void): unknown
  removeListener(event: 'resize', listener: () => void): unknown
}

/**
 * The prompt: `enter` starts it, `put` takes each key, Enter ends it with the value, Esc cancels.
 * @beta
 */
export class JestPrompt {
  #value = ''
  #onChange: () => void = () => {}
  #onSuccess: (value: string) => void = () => {}
  #onCancel: (value: string) => void = () => {}
  #offset = -1
  #promptLength = 0
  #selection: string | null = null
  #entering = true
  readonly #keys: JestWatchKeys
  readonly #resizes: JestResizeSource | undefined
  readonly #onResize = (): void => {
    this.#onChange()
  }

  constructor(keys: JestWatchKeys, resizes?: JestResizeSource) {
    this.#keys = keys
    this.#resizes = resizes
  }

  /** `Prompt.ts` L37-L58. */
  enter(
    onChange: (pattern: string, options: JestScrollOptions) => void,
    onSuccess: (pattern: string) => void,
    onCancel: () => void,
  ): void {
    this.#entering = true
    this.#value = ''
    this.#onSuccess = onSuccess
    this.#onCancel = onCancel
    this.#selection = null
    this.#offset = -1
    this.#promptLength = 0
    this.#onChange = () => onChange(this.#value, { max: 10, offset: this.#offset })
    this.#onChange()
    this.#resizes?.on('resize', this.#onResize)
  }

  setPromptLength(length: number): void {
    this.#promptLength = length
  }

  setPromptSelection(selected: string): void {
    this.#selection = selected
  }

  /** `Prompt.ts` L68-L105. */
  put(key: string): void {
    const keys = this.#keys
    switch (key) {
      case keys.ENTER:
        this.#entering = false
        this.#onSuccess(this.#selection ?? this.#value)
        this.abort()
        break
      case keys.ESCAPE:
        this.#entering = false
        this.#onCancel(this.#value)
        this.abort()
        break
      case keys.ARROW_DOWN:
        this.#offset = Math.min(this.#offset + 1, this.#promptLength - 1)
        this.#onChange()
        break
      case keys.ARROW_UP:
        this.#offset = Math.max(this.#offset - 1, -1)
        this.#onChange()
        break
      case keys.ARROW_LEFT:
      case keys.ARROW_RIGHT:
        break
      case keys.CONTROL_U:
        this.#value = ''
        this.#offset = -1
        this.#selection = null
        this.#onChange()
        break
      default:
        this.#value = key === keys.BACKSPACE ? this.#value.slice(0, -1) : this.#value + key
        this.#offset = -1
        this.#selection = null
        this.#onChange()
        break
    }
  }

  /** `Prompt.ts` L107-L111. */
  abort(): void {
    this.#entering = false
    this.#value = ''
    this.#resizes?.removeListener('resize', this.#onResize)
  }

  isEntering(): boolean {
    return this.#entering
  }
}
