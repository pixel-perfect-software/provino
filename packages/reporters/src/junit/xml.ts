// The little XML the JUnit reporter writes: escaping, and a writer that indents elements. Text is
// cleaned first: ANSI sequences go (an assertion message may carry colours) and so does every
// character XML 1.0 can't hold (a control character other than tab, line feed and carriage return).
import { stripVTControlCharacters } from 'node:util'

/** `text` without ANSI sequences and without the characters XML 1.0 forbids. */
export function clean(text: string): string {
  return stripVTControlCharacters(text).replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: this is the XML 1.0 character class.
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g,
    '',
  )
}

/** An attribute's value, quoted with `"`. A line break is kept as a character reference. */
export function attribute(text: string): string {
  return clean(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\n', '&#10;')
    .replaceAll('\r', '&#13;')
    .replaceAll('\t', '&#9;')
}

/** Element text: `&`, `<` and `>` escaped (a `]]>` in the text can then never appear). */
export function content(text: string): string {
  return clean(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** The attributes of an element, `undefined` values left out, in the order given. */
export function attributes(values: Readonly<Record<string, string | number | undefined>>): string {
  return Object.entries(values)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([name, value]) => ` ${name}="${attribute(String(value))}"`)
    .join('')
}

/** An element to write: a name, attributes, and either text or child elements. */
export interface Element {
  readonly name: string
  readonly attributes?: Readonly<Record<string, string | number | undefined>>
  readonly text?: string
  readonly children?: readonly Element[]
}

/** The element as indented XML (two spaces a level); an element with no text or children is self-closing. */
export function write(element: Element, depth = 0): string {
  const pad = '  '.repeat(depth)
  const open = `${pad}<${element.name}${attributes(element.attributes ?? {})}`
  const children = element.children ?? []
  if (children.length > 0) {
    return `${open}>\n${children.map((child) => write(child, depth + 1)).join('\n')}\n${pad}</${element.name}>`
  }
  if (element.text !== undefined && element.text !== '') {
    return `${open}>${content(element.text)}</${element.name}>`
  }
  return `${open}/>`
}
