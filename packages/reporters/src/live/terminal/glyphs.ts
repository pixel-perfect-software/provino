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
  /** The guides of the `--tree` view: each is three columns wide, so a level of depth costs three. */
  readonly tree: TreeGuides
  /** A file's cell in the `--map` view: one glyph per outcome, each the same width. */
  readonly cell: MapCells
}

/**
 * The guides that draw a tree, each three columns wide.
 * @beta
 */
export interface TreeGuides {
  /** Before a row that has a sibling after it. */
  readonly branch: string
  /** Before the last row of its parent. */
  readonly last: string
  /** Under a row that has siblings after it: carries the line down. */
  readonly pipe: string
  /** Under the last row of its parent: nothing to carry. */
  readonly blank: string
}

/**
 * What the status map draws for a file that passed, failed, was skipped whole, or has only todo
 * tests. The emoji set uses squares of two columns; the others use letters, which read without
 * colour too.
 * @beta
 */
export interface MapCells {
  readonly pass: string
  readonly fail: string
  readonly skipped: string
  readonly todo: string
}

const BRAILLE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** Box-drawing guides: every terminal that draws the progress bar draws them. */
const BOX_TREE: TreeGuides = { branch: '├─ ', last: '└─ ', pipe: '│  ', blank: '   ' }

/** The map's cells where emoji are not drawn: a letter for each outcome. */
const LETTER_CELLS: MapCells = { pass: '.', fail: 'X', skipped: 's', todo: 't' }

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
    tree: BOX_TREE,
    // U+1F7E9, U+1F7E5, U+1F7E8 and U+2B1C all have Emoji_Presentation: two columns everywhere.
    cell: { pass: '🟩', fail: '🟥', skipped: '🟨', todo: '⬜' },
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
    tree: BOX_TREE,
    cell: LETTER_CELLS,
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
    tree: { branch: '|- ', last: '\\- ', pipe: '|  ', blank: '   ' },
    cell: LETTER_CELLS,
  },
}
