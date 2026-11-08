// A failure's text, parsed once: its message lines and its stacks. Normalization asks this for the
// message to clean and for the user's frame, so nothing else has to know what a frame looks like.
import { ROOT_PLACEHOLDER } from './paths.ts'

/**
 * Where a frame says it ran. A file location keeps its line and column as written. An `eval`
 * frame names the innermost place `eval` was called from, when it can be read.
 */
export type Loc =
  | { readonly kind: 'file'; readonly path: string; readonly line: string; readonly col: string }
  | { readonly kind: 'native' }
  | { readonly kind: 'index'; readonly index: string }
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'eval'; readonly origin: Loc | undefined }

/** One V8 frame: `at <fn> (<loc>)` or `at <loc>`, with `async` before the function or location. */
export interface Frame {
  readonly fn: string | undefined
  readonly async: boolean
  readonly loc: Loc
}

/**
 * The text between two cause lines: its message lines, and the frames that end it. Jest chains an
 * error's cause after a `[cause]:` line, so a failure can hold several stacks.
 */
export interface Segment {
  readonly lines: readonly string[]
  readonly frames: readonly Frame[]
}

const FRAME_START = /^[ \t]+at[ \t]+(\S.*)$/
const FRAME_WITH_FUNCTION = /^(.+?) \((.*)\)$/
const ASYNC_PREFIX = /^async\s+/
const CAUSE_SEPARATOR = /^(?:\[cause\]|Caused by):/
const INDENT = /^[ \t]*/

const NON_FILE_LOCATION = /^(?:(<anonymous>)|(native)|index (\d+))$/
const POSITIONED_LOCATION = /^(.+):(\d+):(\d+)$/
const POSITION_SUFFIX = /:\d+:\d+$/
const ANONYMOUS_PREFIX = /^<anonymous>/
const EVAL_PREFIX = /^eval at /

// A path with any of these in it is Node's, a dependency's or a runner's: not the user's code.
const INTERNAL_PATH = /node:|node_modules[\\/]|jest-circus|vitest\/dist/

// Already rooted: a path, `<root>`, a drive, a UNC path, or a URL.
const ANCHORED = /^(?:[/\\<]|[A-Za-z]:|[A-Za-z][A-Za-z0-9+.-]*:\/)/

const ANONYMOUS: Loc = { kind: 'anonymous' }

/** A location, or `undefined` if the text is not one. */
function parseLoc(text: string): Loc | undefined {
  const nonFile = NON_FILE_LOCATION.exec(text)
  if (nonFile !== null) {
    if (nonFile[1] !== undefined) return ANONYMOUS
    return nonFile[2] !== undefined
      ? { kind: 'native' }
      : { kind: 'index', index: nonFile[3] ?? '' }
  }
  if (!POSITION_SUFFIX.test(text)) return undefined
  return EVAL_PREFIX.test(text) ? parseEval(text) : parsePositioned(text)
}

/** `path:line:col`. A position with no path, or on `<anonymous>`, names no file. */
function parsePositioned(text: string): Loc {
  const [, path, line, col] = POSITIONED_LOCATION.exec(text) ?? []
  if (path === undefined || line === undefined || col === undefined) return ANONYMOUS
  return ANONYMOUS_PREFIX.test(text) ? ANONYMOUS : { kind: 'file', path, line, col }
}

/**
 * `eval at fn (origin), <anonymous>:l:c`. Evals nest, so this follows the innermost origin. The
 * origin is `undefined` when the text isn't well formed.
 */
function parseEval(text: string): Loc {
  let current = text
  while (EVAL_PREFIX.test(current)) {
    const open = current.indexOf(' (')
    const close = current.lastIndexOf('), ')
    if (open === -1 || close <= open) return { kind: 'eval', origin: undefined }
    current = current.slice(open + 2, close)
  }
  return { kind: 'eval', origin: parseLoc(current) }
}

function parseFrame(line: string): Frame | undefined {
  const body = FRAME_START.exec(line)?.[1]?.trimEnd()
  if (body === undefined) return undefined
  // The function form ends in `)`. Checking first keeps a long line without one from trying the
  // pattern at every ` (` in it.
  const withFunction = body.endsWith(')') ? FRAME_WITH_FUNCTION.exec(body) : null
  const head = withFunction?.[1]
  const loc = parseLoc(withFunction?.[2] ?? body.replace(ASYNC_PREFIX, ''))
  if (loc === undefined) return undefined
  const named = head ?? body
  return {
    fn: head === undefined ? undefined : head.replace(ASYNC_PREFIX, ''),
    async: ASYNC_PREFIX.test(named),
    loc,
  }
}

function indentOf(line: string): string {
  return INDENT.exec(line)?.[0] ?? ''
}

// The matcher hint Jest prints first in a `toThrow` failure: `expect(received).toThrow(expected)`,
// with `.not`, `.rejects` or `.resolves` between, and after `Error: ` in a test's failure message.
// Every layout of that failure (a received message, a diff of messages, `Expected message: not`)
// ends with the received error's stack, so the hint marks it whatever the lines between say.
const TO_THROW_HINT =
  /^[ \t]*(?:\w*Error: )?expect\(.*?\)(?:\.(?:not|rejects|resolves))*\.toThrow(?:Error)?\(/

/** Whether a segment's message is a Jest `toThrow` failure, by its matcher hint. */
function isToThrowFailure(lines: readonly string[], end: number): boolean {
  return lines.slice(0, end).some((line) => TO_THROW_HINT.test(line))
}

/**
 * Splits a failure into segments at its `[cause]:` and `Caused by:` lines. In V8's layout a stack
 * is the run of frame lines that ends a segment (blank lines after it don't count), all indented
 * alike. A frame-shaped line anywhere else, such as one printed in a diff, stays in the message.
 *
 * One exception: a Jest `toThrow` failure (its matcher hint says so) prints the received error's
 * code frame and stack (6 spaces) right above its own stack (4 spaces). Those frames are another
 * error's stack, so they are dropped from both this error's stack and its message, as the
 * `code-frames` rule drops the code frame above them, and the user frame comes from Jest's own
 * stack: the matcher call, as Vitest reports it. Differently indented frame lines in any other
 * failure stay in the message.
 */
export function parseStack(text: string): Segment[] {
  const groups: string[][] = [[]]
  for (const line of text.split('\n')) {
    if (CAUSE_SEPARATOR.test(line)) groups.push([])
    groups.at(-1)?.push(line)
  }
  return groups.map((lines) => {
    let end = lines.length
    while (end > 0 && (lines[end - 1] ?? '').trim() === '') end--
    let start = end
    const frames: Frame[] = []
    const indent = indentOf(lines[end - 1] ?? '')
    for (;;) {
      const line = lines[start - 1]
      const frame = start > 0 && line !== undefined ? parseFrame(line) : undefined
      if (frame === undefined || line === undefined || indentOf(line) !== indent) break
      frames.push(frame)
      start--
    }
    frames.reverse()
    let embedded = start
    while (embedded > 0 && parseFrame(lines[embedded - 1] ?? '') !== undefined) embedded--
    const kept = embedded < start && isToThrowFailure(lines, embedded) ? embedded : start
    return { lines: [...lines.slice(0, kept), ...lines.slice(end)], frames }
  })
}

/** The text with every stack removed. */
export function messageOf(segments: readonly Segment[]): string {
  return segments.flatMap((segment) => segment.lines).join('\n')
}

/** The file a frame ran in, if it names one. An `eval` frame uses the file it was called from. */
function fileOf(loc: Loc): Extract<Loc, { kind: 'file' }> | undefined {
  if (loc.kind === 'eval') return loc.origin === undefined ? undefined : fileOf(loc.origin)
  return loc.kind === 'file' ? loc : undefined
}

/**
 * The first frame in the user's code, as `<root>/a.test.ts:7:23`. A frame is the user's if it names
 * a file and the file is not Node's, a dependency's or a runner's. The check is on the file, not the
 * function: `Object.<anonymous> (file:9:26)` is the user's own frame. Jest prints file-level paths
 * relative to the root, so a path that isn't rooted is made `<root>`-relative.
 */
export function userFrameOf(segments: readonly Segment[]): string | undefined {
  for (const { frames } of segments) {
    for (const frame of frames) {
      const file = fileOf(frame.loc)
      if (file === undefined || INTERNAL_PATH.test(file.path)) continue
      const path = ANCHORED.test(file.path) ? file.path : `${ROOT_PLACEHOLDER}/${file.path}`
      return `${path}:${file.line}:${file.col}`
    }
  }
  return undefined
}
