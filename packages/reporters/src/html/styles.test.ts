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

  /** The declarations of the first rule whose selector is `selector`, as written. */
  function rule(selector: string, css: string = STYLES): string {
    const start = css.indexOf(`\n${selector} {`)
    assert.ok(start !== -1, `no rule for ${selector}`)
    return css.slice(start, css.indexOf('}', start))
  }

  /** The rules inside the `@media (forced-colors: active)` block, by selector. */
  function forcedColours(): Map<string, string> {
    const start = STYLES.indexOf('@media (forced-colors: active) {')
    assert.ok(start !== -1, 'no forced-colours block')
    const block = STYLES.slice(start, STYLES.indexOf('\n}\n', start))
    return new Map(
      [...block.matchAll(/^\s+([^{}\n]+)\{([^}]*)\}/gm)].map((m) => [
        (m[1] as string).trim(),
        (m[2] as string).trim(),
      ]),
    )
  }

  describe('the stylesheet, against DESIGN.md', () => {
    it('leaves the root at the browser’s size: the rem tokens mean what the design says, and the text font is the body’s', () => {
      // A font on `html` would make 1rem 13px and every `--t-*` 13/16 of its size.
      assert.doesNotMatch(rule('html'), /[\s;]font(?:-size)?\s*:/)
      assert.match(rule('body'), /font: 400 var\(--t-md\)\/1\.45 var\(--font\)/)
      assert.match(rule('html'), /scrollbar-gutter: stable/)
    })

    it('has the verdict fields and the tabs as DESIGN.md has them', () => {
      assert.match(rule('.fields'), /gap: var\(--s-2\) var\(--s-6\)/)
      assert.match(rule('.fields dt'), /font-weight: 600/)
      assert.doesNotMatch(rule('.tab'), /font-weight/)
      assert.match(rule('.tabbar'), /padding: 0 var\(--s-5\) 0 var\(--s-2\)/)
      assert.match(rule('.table-wrap'), /border-radius: var\(--r-field\)/)
      // "sample data" is not a status, so it is not Skip Amber.
      assert.match(rule('.synthetic'), /color: var\(--ink-3\)/)
    })

    it('draws a chip’s border at 3:1, as the search field’s, and a small action as a 24 px target', () => {
      assert.match(rule('.chip'), /border: 1px solid var\(--ink-3\)/)
      assert.match(rule('.search'), /border: 1px solid var\(--ink-3\)/)
      assert.match(rule('.range button, .links button'), /min-height: var\(--chip-h\)/)
      // Its `display` must not undo `hidden`: "Clear range" is hidden until there is a range. One
      // rule for every element, so no component rule can.
      assert.match(STYLES, /\n\[hidden\] \{ display: none !important; \}/)
      assert.doesNotMatch(STYLES, /\S\[hidden\] \{/)
    })

    it('draws the range form’s error as text with a mark, in the fail colour, and the field in a thicker border', () => {
      assert.match(rule('.field-error'), /color: var\(--fail\)/)
      // The overview's chart has a class of its own: a rule for every `svg` in the overview would
      // size the error's glyph.
      assert.match(STYLES, /\n\.ov-chart \{/)
      assert.doesNotMatch(STYLES, /\.overview (?:> )?svg/)
      assert.match(
        rule('.range-form input[aria-invalid="true"]'),
        /border: var\(--ring\) solid var\(--fail\)/,
      )
    })

    it('has the timeline follow its container, scrolling only under a minimum', () => {
      assert.match(rule('.lanes-scroll svg'), /min-width: var\(--chart-min\)/)
      assert.match(STYLES, /--chart-min: 480px/)
    })
  })

  describe('the stylesheet under forced colours', () => {
    const rules = forcedColours()
    const declarations = (selector: string): string => {
      const found = rules.get(selector)
      assert.ok(found !== undefined, `no forced-colours rule for ${selector}`)
      return found
    }

    it('tells the statuses of a map cell and a legend swatch apart without a background image', () => {
      // Background images (the hatches and the dots) are dropped in forced colours, so each status
      // has its own border: solid fill, a double ring, a thick ring, a dotted ring, a thin ring.
      const looks = [
        declarations('.cell'),
        declarations('.cell.s-fail'),
        declarations('.cell.s-crash'),
        declarations('.cell.s-skip'),
        declarations('.cell.s-todo'),
      ].map((text) => /border: ([^;]+);/.exec(text)?.[1] ?? '')
      assert.equal(new Set(looks).size, 5, looks.join(' | '))
      assert.match(looks[1] ?? '', /double/)
      assert.match(looks[3] ?? '', /dotted/)
      // The legend's swatches are `.cell`s too, so the same rules draw them, in system colours.
      assert.match(declarations('.cell, .bar, .slice, .t-slice'), /forced-color-adjust: none/)
      for (const selector of [
        '.cell',
        '.cell.s-fail',
        '.cell.s-crash',
        '.cell.s-skip',
        '.cell.s-todo',
      ]) {
        assert.doesNotMatch(declarations(selector), /gradient|url\(/)
      }
    })

    it('names every status for the overview’s slices and the timeline’s bars, in system colours and strokes', () => {
      for (const status of ['fail', 'crash', 'skip', 'todo']) {
        const found = declarations(`.slice.s-${status}, .t-slice.s-${status}`)
        assert.match(found, /fill: (?:Canvas|Highlight)/)
        assert.match(found, /stroke: (?:CanvasText|GrayText)/)
      }
      // Failed and crashed are heavier than the rest, and a crash is dashed as a skip is.
      assert.match(declarations('.slice.s-fail, .t-slice.s-fail'), /stroke-width: var\(--ring\)/)
      assert.match(declarations('.slice.s-crash, .t-slice.s-crash'), /stroke-dasharray/)
      assert.match(declarations('.slice.s-skip, .t-slice.s-skip'), /stroke-dasharray/)
      assert.match(declarations('.slice, .t-slice'), /fill: GrayText/)
      // Only system colours: none of the report's own tokens paints a fill, stroke or background.
      const block = [...rules.values()].join('\n')
      assert.doesNotMatch(block, /(?:fill|stroke|background|outline-color):\s*var\(--/)
      assert.match(declarations('.bar.has-fail'), /background: Highlight/)
    })
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
