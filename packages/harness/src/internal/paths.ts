// What the path rules and the converters share about how a path is written.

/** What a configured root is replaced with. */
export const ROOT_PLACEHOLDER: string = '<root>'

/** A drive letter followed by a separator (`C:\work`, `C:/work`), or a UNC path (`\\server\share`). */
export const WINDOWS_ABSOLUTE: RegExp = /^(?:[A-Za-z]:[\\/]|\\\\)/

/**
 * Characters that, right before a path, show it is the tail of a longer one (`/home/me` before
 * `/work`) or part of a word, so it is not a path of its own. Written for the inside of a
 * character class.
 */
export const PATH_LEFT_CLASS: string = String.raw`\w$.@~%+\-/\\`
