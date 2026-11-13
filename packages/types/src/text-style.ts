/**
 * The styles the text reporters use (`createStyle`'s result in `@provino/reporters`). Each
 * function wraps its text in an SGR sequence and its reset, and puts the sequence back after any
 * reset inside the text, so styles nest; with colour off each returns its text as it was given.
 * A dialect that builds a piece of text for a reporter (a closing line, a snapshot summary) takes
 * one.
 * @public
 */
export interface TextStyle {
  bold(text: string): string
  dim(text: string): string
  red(text: string): string
  green(text: string): string
  yellow(text: string): string
  magenta(text: string): string
  /**
   * A status word on a coloured block (inverse, bold): Jest's ` PASS ` and ` FAIL ` badges. With
   * colour off it is the bare word, as Jest prints it, so `PASS path` stays a line anyone can match.
   */
  badge(word: string, colour: 'green' | 'red' | 'yellow'): string
}
