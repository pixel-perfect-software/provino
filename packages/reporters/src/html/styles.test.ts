// The stylesheet's contract with the design pass: every colour is a token with a light and a dark
// value, no rule holds a colour, a font size or a spacing of its own, and the tokens meet WCAG 2.2
// AA contrast in both schemes (1.4.3 for text, 1.4.11 for the borders, bars and focus ring).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DARK_COLOURS, LIGHT_COLOURS, STYLES } from './page/styles.ts'

/** The colour tokens of a block of declarations. */
function colours(block: string): Map<string, string> {
  return new Map(
    [...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6});/g)].map((m) => [
      m[1] as string,
      m[2] as string,
    ]),
  )
}

/** WCAG's relative luminance of `#rrggbb`. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = Number.parseInt(hex.slice(at, at + 2), 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG's contrast ratio of two colours. */
function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (light + 0.05) / (dark + 0.05)
}

const SCHEMES = [
  ['light', colours(LIGHT_COLOURS)],
  ['dark', colours(DARK_COLOURS)],
] as const

describe('the stylesheet', () => {
  it('has the same colour tokens in both schemes, light on `:root` and dark under prefers-color-scheme', () => {
    const [light, dark] = [SCHEMES[0][1], SCHEMES[1][1]]
    assert.ok(light.size >= 12)
    assert.deepEqual([...dark.keys()].sort(), [...light.keys()].sort())
    const root = STYLES.indexOf(':root {')
    const media = STYLES.indexOf('@media (prefers-color-scheme: dark)')
    assert.ok(root !== -1 && media > root)
    assert.ok(STYLES.slice(root, media).includes(LIGHT_COLOURS))
    assert.ok(STYLES.slice(media).includes(DARK_COLOURS))
    assert.match(STYLES, /color-scheme: light dark;/)
  })

  it('holds no colour, font size or spacing in a rule: they are all custom properties', () => {
    const rules = STYLES.replace(LIGHT_COLOURS, '').replace(DARK_COLOURS, '')
    // Everything after the `:root` block is a rule.
    const afterTokens = rules.slice(rules.indexOf('*, *::before'))
    // A colour is a token: a rule may mix tokens (`color-mix(…)`) or take a hue from one
    // (`hsl(var(--h) var(--slice-s) var(--slice-l))`), never write one down.
    assert.doesNotMatch(afterTokens, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\((?!var\()/)
    // A length is a token, apart from the one-pixel hairlines (and the visually-hidden text's) and
    // the media queries' breakpoint.
    const lengths = afterTokens
      .split('\n')
      .filter((line) => !line.startsWith('@media'))
      .flatMap((line) => [...line.matchAll(/(-?\d*\.?\d+)(px|rem|em|ch)\b/g)].map((m) => m[0]))
    assert.ok(lengths.length > 0)
    assert.deepEqual(
      [...new Set(lengths)].filter((length) => length !== '1px' && length !== '-1px'),
      [],
    )
    // A duration is a token too.
    assert.doesNotMatch(afterTokens, /\d(?:ms|s)\b(?!\))/)
  })

  it('has no hatch, dot or ring written as a number of its own: the patterns come from tokens', () => {
    assert.match(STYLES, /--hatch-fail: color-mix\(in srgb, var\(--bg\)/)
    assert.doesNotMatch(STYLES, /rgba\(/)
    // The motion is the one expand rotation, and none under reduced motion.
    assert.equal(STYLES.match(/transition:/g)?.length, 2)
    assert.match(
      STYLES,
      /@media \(prefers-reduced-motion: reduce\) \{ \* \{ transition: none !important; \} \}/,
    )
  })

  for (const [scheme, tokens] of SCHEMES) {
    const get = (name: string): string => {
      const value = tokens.get(name)
      assert.ok(value !== undefined, `no --${name} in the ${scheme} scheme`)
      return value
    }

    it(`has AA contrast in the ${scheme} scheme: text 4.5:1, the focus ring, field borders and marks 3:1`, () => {
      // Text and glyphs on Paper, Panel Grey and Code Paper (the grounds text sits on).
      for (const ground of ['bg', 'panel', 'code-bg']) {
        for (const text of ['ink', 'ink-2', 'ink-3', 'accent', 'pass', 'fail', 'skip', 'todo']) {
          const ratio = contrast(get(text), get(ground))
          assert.ok(ratio >= 4.5, `--${text} on --${ground} is ${ratio.toFixed(2)}:1, under 4.5:1`)
        }
      }
      // The focus ring and a field's border (`--ink-3`) against what they are drawn on, and the
      // fills of the drawn marks against Paper.
      for (const ground of ['bg', 'panel']) {
        for (const part of ['accent', 'ink-3']) {
          const ratio = contrast(get(part), get(ground))
          assert.ok(ratio >= 3, `--${part} on --${ground} is ${ratio.toFixed(2)}:1, under 3:1`)
        }
      }
      for (const fill of ['pass-fill', 'fail-fill', 'skip-fill', 'todo']) {
        const ratio = contrast(get(fill), get('bg'))
        assert.ok(ratio >= 3, `--${fill} on --bg is ${ratio.toFixed(2)}:1, under 3:1`)
      }
      // A selected chip's text on its wash.
      const chip = contrast(get('ink'), get('accent-wash'))
      assert.ok(chip >= 4.5, `--ink on --accent-wash is ${chip.toFixed(2)}:1, under 4.5:1`)
    })
  }
})
