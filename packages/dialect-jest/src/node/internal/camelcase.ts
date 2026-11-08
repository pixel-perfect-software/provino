// `camelcase` 6.3.0 (`index.js`) with its defaults and `{ locale: 'en-US' }`, the call
// jest-validate's `validateCLIOptions` makes (L98: `camelcase(arg, { locale: 'en-US' })`). It is
// not yargs-parser's own `camelCase` (which the parser uses for dashed flags): the two differ on
// capitals and separators, and both are kept as upstream has them.

const UPPERCASE = /\p{Lu}/u
const LOWERCASE = /\p{Ll}/u
const LEADING_SEPARATORS = /^[_.\- ]+/
const SEPARATORS_AND_IDENTIFIER = /[_.\- ]+([\p{Alpha}\p{N}_]|$)/gu
const NUMBERS_AND_IDENTIFIER = /\d+([\p{Alpha}\p{N}_]|$)/gu

const LOCALE = 'en-US'

function lower(text: string): string {
  return text.toLocaleLowerCase(LOCALE)
}

function upper(text: string): string {
  return text.toLocaleUpperCase(LOCALE)
}

function preserveCamelCase(input: string): string {
  let text = input
  let isLastCharLower = false
  let isLastCharUpper = false
  let isLastLastCharUpper = false
  for (let i = 0; i < text.length; i++) {
    const character = text[i] ?? ''
    if (isLastCharLower && UPPERCASE.test(character)) {
      text = `${text.slice(0, i)}-${text.slice(i)}`
      isLastCharLower = false
      isLastLastCharUpper = isLastCharUpper
      isLastCharUpper = true
      i++
    } else if (isLastCharUpper && isLastLastCharUpper && LOWERCASE.test(character)) {
      text = `${text.slice(0, i - 1)}-${text.slice(i - 1)}`
      isLastLastCharUpper = isLastCharUpper
      isLastCharUpper = false
      isLastCharLower = true
    } else {
      isLastCharLower = lower(character) === character && upper(character) !== character
      isLastLastCharUpper = isLastCharUpper
      isLastCharUpper = upper(character) === character && lower(character) !== character
    }
  }
  return text
}

/** `camelcase(input, { locale: 'en-US' })`. */
export function camelcase(input: string): string {
  let text = input.trim()
  if (text.length === 0) return ''
  if (text.length === 1) return lower(text)
  if (text !== lower(text)) text = preserveCamelCase(text)
  text = text.replace(LEADING_SEPARATORS, '')
  text = lower(text)
  SEPARATORS_AND_IDENTIFIER.lastIndex = 0
  NUMBERS_AND_IDENTIFIER.lastIndex = 0
  return text
    .replace(SEPARATORS_AND_IDENTIFIER, (_match, identifier: string) => upper(identifier))
    .replace(NUMBERS_AND_IDENTIFIER, (match) => upper(match))
}
