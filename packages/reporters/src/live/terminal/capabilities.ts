// What the terminal can draw, decided from the environment alone (open questions 8 and 12, D144):
// nothing is asked of the terminal, because a query needs stdin in raw mode and a wait. Both
// functions are pure and are called once, when the reporter is built.

import type { Environment } from '../../environment.ts'
import type { GlyphSet } from './glyphs.ts'

/**
 * What `detectGlyphs` reads.
 * @beta
 */
export interface GlyphOptions {
  readonly env: Environment
  /** `process.platform`. */
  readonly platform: string
  /** `false` for `--no-emoji`. Default: on. */
  readonly emoji?: boolean
}

function isOff(value: string | undefined): boolean {
  if (value === undefined) return false
  const text = value.trim().toLowerCase()
  return text === '0' || text === 'false'
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== ''
}

/** Whether a Windows terminal is one known to draw Unicode. */
function windowsDrawsUnicode(env: Environment): boolean {
  const term = env.TERM
  return (
    isSet(env.WT_SESSION) ||
    isSet(env.TERMINUS_SUBLIME) ||
    env.ConEmuTask === '{cmd::Cmder}' ||
    env.TERM_PROGRAM === 'Terminus-Sublime' ||
    env.TERM_PROGRAM === 'vscode' ||
    term === 'xterm-256color' ||
    term === 'alacritty' ||
    (term?.startsWith('rxvt-unicode') ?? false) ||
    env.TERMINAL_EMULATOR === 'JetBrains-JediTerm'
  )
}

/**
 * The glyph set: `ascii` where Unicode won't render (`TERM=linux`, and a Windows terminal that is
 * not one known to draw it), `unicode` under `--no-emoji`, `PROVINO_EMOJI=0` or `TERM=dumb`,
 * `emoji` otherwise.
 * @beta
 */
export function detectGlyphs(options: GlyphOptions): GlyphSet {
  const { env, platform } = options
  if (env.TERM === 'linux') return 'ascii'
  if (platform === 'win32' && !windowsDrawsUnicode(env)) return 'ascii'
  if (options.emoji === false || isOff(env.PROVINO_EMOJI) || env.TERM === 'dumb') return 'unicode'
  return 'emoji'
}

/**
 * What `detectHyperlinks` reads.
 * @beta
 */
export interface HyperlinkOptions {
  readonly env: Environment
  /** The output is a terminal. */
  readonly tty: boolean
  /** A CI run. */
  readonly ci: boolean
}

const HYPERLINK_PROGRAMS: ReadonlySet<string> = new Set([
  'iTerm.app',
  'WezTerm',
  'vscode',
  'ghostty',
])

/**
 * Whether to write OSC 8 hyperlinks: only to a terminal that is not CI and is known to draw them
 * (iTerm2, WezTerm, VS Code, Ghostty, Windows Terminal, VTE 0.50 or later, kitty).
 * `FORCE_HYPERLINK` overrides: `0` or `false` is off, anything else non-empty is on.
 * @beta
 */
export function detectHyperlinks(options: HyperlinkOptions): boolean {
  const { env } = options
  const forced = env.FORCE_HYPERLINK
  if (isSet(forced)) return !isOff(forced)
  if (!options.tty || options.ci) return false
  if (env.TERM_PROGRAM !== undefined && HYPERLINK_PROGRAMS.has(env.TERM_PROGRAM)) return true
  if (isSet(env.WT_SESSION) || isSet(env.KITTY_WINDOW_ID)) return true
  const vte = Number.parseInt(env.VTE_VERSION ?? '', 10)
  return vte >= 5000
}
