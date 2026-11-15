// jest-watcher `constants.ts` L8-L21: the bytes a key sends in raw mode.

/**
 * The keys watch mode reads, as the bytes a terminal in raw mode sends (`constants.ts` L10-L21).
 * Backspace is `0x08` on Windows and `0x7f` elsewhere.
 * @beta
 */
export interface JestWatchKeys {
  readonly ARROW_DOWN: string
  readonly ARROW_LEFT: string
  readonly ARROW_RIGHT: string
  readonly ARROW_UP: string
  readonly BACKSPACE: string
  readonly CONTROL_C: string
  readonly CONTROL_D: string
  readonly CONTROL_U: string
  readonly ENTER: string
  readonly ESCAPE: string
}

/**
 * The keys on `platform` (`process.platform` is what Jest reads).
 * @beta
 */
export function jestWatchKeys(platform: NodeJS.Platform): JestWatchKeys {
  return {
    ARROW_DOWN: '\u001B[B',
    ARROW_LEFT: '\u001B[D',
    ARROW_RIGHT: '\u001B[C',
    ARROW_UP: '\u001B[A',
    BACKSPACE: platform === 'win32' ? '\u0008' : '\u007F',
    CONTROL_C: '\u0003',
    CONTROL_D: '\u0004',
    CONTROL_U: '\u0015',
    ENTER: '\r',
    ESCAPE: '\u001B',
  }
}
