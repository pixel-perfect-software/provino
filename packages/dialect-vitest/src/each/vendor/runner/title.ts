// provino: an extract of Vitest 5.0.5 `packages/vitest/src/runtime/runner/suite.ts`:
// `formatTitle` (L980-L1052) and `handleRegexMatch` (L1055-L1074), bodies unchanged except the two
// patches marked below. Vitest 5.0 has no @vitest/runner package; the runner lives in `vitest`.
import type { InspectOptions } from '../utils/display.ts'
import { format, formatRegExp, inspect, truncateString } from '../utils/display.ts'
import { isNegativeNaN, isObject, objectAttr } from '../utils/helpers.ts'

// provino: exported, and `runner.config.taskTitleValueFormatTruncate` is a parameter (the worker's
// runner config is not here); annotated for isolatedDeclarations
export function formatTitle(
  template: string,
  items: any[],
  idx: number,
  taskTitleValueFormatTruncate: number,
): string {
  if (template.includes('%#') || template.includes('%$')) {
    // '%#' match index of the test case
    template = template
      .replace(/%%/g, '__vitest_escaped_%__')
      .replace(/%#/g, `${idx}`)
      .replace(/%\$/g, `${idx + 1}`)
      .replace(/__vitest_escaped_%__/g, '%%')
  }
  const count = template.split('%').length - 1

  if (template.includes('%f')) {
    const placeholders = template.match(/%f/g) || []
    placeholders.forEach((_, i) => {
      if (isNegativeNaN(items[i]) || Object.is(items[i], -0)) {
        // Replace the i-th occurrence of '%f' with '-%f'
        let occurrence = 0
        template = template.replace(/%f/g, (match) => {
          occurrence++
          return occurrence === i + 1 ? '-%f' : match
        })
      }
    })
  }

  const inspectOptions = {
    truncate: taskTitleValueFormatTruncate,
  } satisfies InspectOptions

  const isObjectItem = isObject(items[0])
  function formatAttribute(s: string) {
    return s.replace(/\$([$\p{ID_Continue}.]+)/gu, (_, key: string) => {
      const isArrayKey = /^\d+$/.test(key)
      if (!isObjectItem && !isArrayKey) {
        return `$${key}`
      }
      const arrayElement = isArrayKey ? objectAttr(items, key) : undefined
      const value = isObjectItem ? objectAttr(items[0], key, arrayElement) : arrayElement
      // print string without quotes
      if (typeof value === 'string') {
        return inspectOptions.truncate ? truncateString(value, inspectOptions.truncate) : value
      }
      return inspect(value, inspectOptions)
    })
  }

  let output = ''
  let i = 0
  handleRegexMatch(
    template,
    formatRegExp,
    // format "%"
    (match) => {
      if (i < count) {
        output += format([match[0], items[i++]], inspectOptions)
      } else {
        output += match[0]
      }
    },
    // format "$"
    (nonMatch) => {
      output += formatAttribute(nonMatch)
    },
  )
  return output
}

// based on https://github.com/unocss/unocss/blob/2e74b31625bbe3b9c8351570749aa2d3f799d919/packages/autocomplete/src/parse.ts#L11
function handleRegexMatch(
  input: string,
  regex: RegExp,
  onMatch: (match: RegExpMatchArray) => void,
  onNonMatch: (nonMatch: string) => void,
) {
  let lastIndex = 0
  for (const m of input.matchAll(regex)) {
    if (lastIndex < m.index) {
      onNonMatch(input.slice(lastIndex, m.index))
    }
    onMatch(m)
    lastIndex = m.index + m[0].length
  }
  if (lastIndex < input.length) {
    onNonMatch(input.slice(lastIndex))
  }
}
