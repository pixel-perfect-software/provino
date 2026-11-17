import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectGlyphs, detectHyperlinks } from './capabilities.ts'
import { GLYPHS } from './glyphs.ts'
import { displayWidth } from './width.ts'

test('emoji is the default on a terminal that draws Unicode', () => {
  assert.equal(detectGlyphs({ env: {}, platform: 'darwin' }), 'emoji')
  assert.equal(detectGlyphs({ env: { TERM: 'xterm-256color' }, platform: 'linux' }), 'emoji')
})

test('ascii where Unicode will not render', () => {
  assert.equal(detectGlyphs({ env: { TERM: 'linux' }, platform: 'linux' }), 'ascii')
  assert.equal(detectGlyphs({ env: {}, platform: 'win32' }), 'ascii')
  assert.equal(detectGlyphs({ env: { TERM: 'xterm' }, platform: 'win32' }), 'ascii')
  // TERM=linux wins over --no-emoji: ascii is the narrower set.
  assert.equal(detectGlyphs({ env: { TERM: 'linux' }, platform: 'linux', emoji: false }), 'ascii')
})

test('a Windows terminal known to draw Unicode gets emoji', () => {
  const win = (env: Record<string, string>) => detectGlyphs({ env, platform: 'win32' })
  assert.equal(win({ WT_SESSION: '1' }), 'emoji')
  assert.equal(win({ TERMINUS_SUBLIME: '1' }), 'emoji')
  assert.equal(win({ ConEmuTask: '{cmd::Cmder}' }), 'emoji')
  assert.equal(win({ TERM_PROGRAM: 'Terminus-Sublime' }), 'emoji')
  assert.equal(win({ TERM_PROGRAM: 'vscode' }), 'emoji')
  assert.equal(win({ TERM: 'xterm-256color' }), 'emoji')
  assert.equal(win({ TERM: 'alacritty' }), 'emoji')
  assert.equal(win({ TERM: 'rxvt-unicode-256color' }), 'emoji')
  assert.equal(win({ TERMINAL_EMULATOR: 'JetBrains-JediTerm' }), 'emoji')
  assert.equal(win({ ConEmuTask: 'other' }), 'ascii')
})

test('--no-emoji, PROVINO_EMOJI=0 and TERM=dumb give unicode', () => {
  assert.equal(detectGlyphs({ env: {}, platform: 'darwin', emoji: false }), 'unicode')
  assert.equal(detectGlyphs({ env: { PROVINO_EMOJI: '0' }, platform: 'darwin' }), 'unicode')
  assert.equal(detectGlyphs({ env: { PROVINO_EMOJI: 'false' }, platform: 'darwin' }), 'unicode')
  assert.equal(detectGlyphs({ env: { TERM: 'dumb' }, platform: 'darwin' }), 'unicode')
  assert.equal(detectGlyphs({ env: { PROVINO_EMOJI: '1' }, platform: 'darwin' }), 'emoji')
})

test('every emoji glyph is two columns and every symbol one', () => {
  for (const key of ['pass', 'fail', 'skipped', 'todo', 'slow', 'passed', 'failed'] as const) {
    assert.equal(displayWidth(GLYPHS.emoji[key]), 2, key)
  }
  for (const key of ['pass', 'fail', 'skipped', 'todo'] as const) {
    assert.equal(displayWidth(GLYPHS.unicode[key]), 1, key)
  }
  for (const frame of GLYPHS.emoji.spinner) assert.equal(displayWidth(frame), 1)
  assert.deepEqual(GLYPHS.ascii.spinner, ['-', '\\', '|', '/'])
  assert.equal(GLYPHS.ascii.barFull + GLYPHS.ascii.barEmpty, '#.')
})

test('hyperlinks: only a known terminal, not CI', () => {
  const links = (env: Record<string, string>, tty = true, ci = false) =>
    detectHyperlinks({ env, tty, ci })
  assert.equal(links({ TERM_PROGRAM: 'iTerm.app' }), true)
  assert.equal(links({ TERM_PROGRAM: 'WezTerm' }), true)
  assert.equal(links({ TERM_PROGRAM: 'vscode' }), true)
  assert.equal(links({ TERM_PROGRAM: 'ghostty' }), true)
  assert.equal(links({ WT_SESSION: 'abc' }), true)
  assert.equal(links({ KITTY_WINDOW_ID: '1' }), true)
  assert.equal(links({ VTE_VERSION: '5000' }), true)
  assert.equal(links({ VTE_VERSION: '4999' }), false)
  assert.equal(links({ TERM_PROGRAM: 'Apple_Terminal' }), false)
  assert.equal(links({}), false)
  assert.equal(links({ TERM_PROGRAM: 'iTerm.app' }, false), false)
  assert.equal(links({ TERM_PROGRAM: 'iTerm.app' }, true, true), false)
})

test('FORCE_HYPERLINK overrides in both directions', () => {
  assert.equal(detectHyperlinks({ env: { FORCE_HYPERLINK: '1' }, tty: false, ci: true }), true)
  assert.equal(
    detectHyperlinks({
      env: { FORCE_HYPERLINK: '0', TERM_PROGRAM: 'iTerm.app' },
      tty: true,
      ci: false,
    }),
    false,
  )
  assert.equal(
    detectHyperlinks({
      env: { FORCE_HYPERLINK: '', TERM_PROGRAM: 'iTerm.app' },
      tty: true,
      ci: false,
    }),
    true,
  )
})
