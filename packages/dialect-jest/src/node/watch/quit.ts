// jest-core `plugins/Quit.ts` L11-L34: `q` leaves raw mode, writes a newline and ends with 0.
// Jest calls `process.exit(0)`; here the host's `exit` ends the session and the command returns 0.
import type { JestWatchTerminal } from './context.ts'
import type { JestWatchPlugin } from './plugin.ts'

/**
 * The terminal's input as watch mode reads it: raw mode when it is a terminal, `utf8` chunks.
 * @beta
 */
export interface JestWatchStdin {
  readonly setRawMode?: (mode: boolean) => unknown
  resume(): unknown
  pause(): unknown
  setEncoding(encoding: 'utf8'): unknown
  on(event: 'data', listener: (chunk: string) => void): unknown
  off(event: 'data', listener: (chunk: string) => void): unknown
}

/**
 * `QuitPlugin`: `q`, `quit watch mode`.
 * @beta
 */
export function jestQuitPlugin(
  terminal: JestWatchTerminal,
  stdin: JestWatchStdin,
  exit: (code: number) => void,
): JestWatchPlugin {
  return {
    isInternal: true,
    getUsageInfo: () => ({ key: 'q', prompt: 'quit watch mode' }),
    run: async () => {
      if (typeof stdin.setRawMode === 'function') stdin.setRawMode(false)
      terminal.out.write('\n')
      exit(0)
    },
  }
}
