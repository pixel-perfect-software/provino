/**
 * The one regular expression Jest builds from `transformIgnorePatterns` (their sources joined with
 * `|`), or `null` for none. Throws the `SyntaxError` of a pattern that doesn't compile, or of a
 * set that doesn't compile joined (`\k<b>` against another pattern's groups).
 * @public
 */
export function ignoreRegExp(patterns: readonly string[]): RegExp | null {
  return patterns.length === 0 ? null : new RegExp(patterns.join('|'))
}
