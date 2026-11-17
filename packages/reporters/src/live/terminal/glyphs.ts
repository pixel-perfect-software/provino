// The three glyph sets (D144). Which one a run uses is `detectGlyphs`' answer
// (`capabilities.ts`). Emoji are chosen so every one is two columns wide on its own
// (`Emoji_Presentation`), with no variation selector: the footer's alignment never depends on the
// terminal.

/**
 * The glyph set: `emoji` where the terminal draws them, `unicode` for plain symbols, `ascii`
 * where Unicode won't render.
 * @beta
 */
export type GlyphSet = 'emoji' | 'unicode' | 'ascii'

/**
 * What the renderer draws a status as.
 * @beta
 */
export interface Glyphs {
  readonly set: GlyphSet
  readonly pass: string
  readonly fail: string
  readonly skipped: string
  readonly todo: string
  /** A slow file's mark. */
  readonly slow: string
  /** A passing run's mark in the end card. */
  readonly passed: string
  /** A failing run's mark in the end card. */
  readonly failed: string
  /** The spinner's frames, one per step. */
  readonly spinner: readonly string[]
  /** A filled and an empty cell of the progress bar. */
  readonly barFull: string
  readonly barEmpty: string
  /** One cell of the rule that separates the finished files from the live footer. */
  readonly rule: string
}

const BRAILLE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/**
 * The glyph sets by name.
 * @beta
 */
export const GLYPHS: Readonly<Record<GlyphSet, Glyphs>> = {
  emoji: {
    set: 'emoji',
    pass: '✅',
    fail: '❌',
    // U+23E9 has Emoji_Presentation, so it is two columns everywhere; U+23ED does not.
    skipped: '⏩',
    todo: '📝',
    slow: '🐢',
    passed: '🎉',
    failed: '💥',
    spinner: BRAILLE,
    barFull: '█',
    barEmpty: '░',
    rule: '─',
  },
  unicode: {
    set: 'unicode',
    pass: '✓',
    fail: '✕',
    skipped: '○',
    todo: '✎',
    slow: 'slow',
    passed: 'passed',
    failed: 'failed',
    spinner: BRAILLE,
    barFull: '█',
    barEmpty: '░',
    rule: '─',
  },
  ascii: {
    set: 'ascii',
    pass: 'ok',
    fail: 'x',
    skipped: '-',
    todo: '*',
    slow: 'slow',
    passed: 'passed',
    failed: 'failed',
    spinner: ['-', '\\', '|', '/'],
    barFull: '#',
    barEmpty: '.',
    rule: '-',
  },
}
