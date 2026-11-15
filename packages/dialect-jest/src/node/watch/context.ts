// What every part of the watch mode writes with: the output stream, the colours and the escapes.
import type { TextStyle } from '@provino/types'
import type { JestWatchKeys } from './keys.ts'
import type { JestResizeSource } from './prompt.ts'
import type { JestTerminalEscapes } from './terminal.ts'

/**
 * A stream the watch mode writes to (Jest's `outputStream`).
 * @beta
 */
export interface JestWatchOutput {
  write(text: string): unknown
}

/**
 * The terminal the watch mode draws on: where it writes, how it colours (the host's choice, as
 * chalk's is Jest's), the escapes, the screen clear and the keys of this platform.
 * @beta
 */
export interface JestWatchTerminal {
  readonly out: JestWatchOutput
  readonly style: TextStyle
  readonly escapes: JestTerminalEscapes
  readonly clear: string
  readonly keys: JestWatchKeys
  /** Resizes redraw an open prompt (Jest listens on `process.stdout`). */
  readonly resizes?: JestResizeSource
}
