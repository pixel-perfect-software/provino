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
    assert.doesNotMatch(afterTokens, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/)
    // A length is a token, apart from the one-pixel hairlines of the visually-hidden text and the
    // media query's breakpoint.
    const lengths = afterTokens
      .split('\n')
      .filter((line) => !line.startsWith('@media'))
      .flatMap((line) => [...line.matchAll(/(-?\d*\.?\d+)(px|rem|em)\b/g)].map((m) => m[0]))
    assert.deepEqual([...new Set(lengths)].sort(), ['-1px', '1px'])
  })

  for (const [scheme, tokens] of SCHEMES) {
    const get = (name: string): string => {
      const value = tokens.get(name)
      assert.ok(value !== undefined, `no --${name} in the ${scheme} scheme`)
      return value
    }

    it(`has AA contrast in the ${scheme} scheme: text 4.5:1, borders, bars and the focus ring 3:1`, () => {
      for (const ground of ['bg', 'surface']) {
        for (const text of [
          'text',
          'text-muted',
          'accent',
          'pass',
          'fail',
          'skip',
          'todo',
          'crash',
        ]) {
          const ratio = contrast(get(text), get(ground))
          assert.ok(ratio >= 4.5, `--${text} on --${ground} is ${ratio.toFixed(2)}:1, under 4.5:1`)
        }
        for (const part of ['border', 'focus']) {
          const ratio = contrast(get(part), get(ground))
          assert.ok(ratio >= 3, `--${part} on --${ground} is ${ratio.toFixed(2)}:1, under 3:1`)
        }
      }
      const bar = contrast(get('bar'), get('rule'))
      assert.ok(bar >= 3, `--bar on its track --rule is ${bar.toFixed(2)}:1, under 3:1`)
    })
  }
})
