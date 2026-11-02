import type { NormalizedError, TestIdentity } from '@provino/types'
import { pathText } from './internal/keys.ts'

/**
 * Where a run happened, so machine-specific paths can be replaced with `<root>`.
 * @public
 */
export interface NormalizeContext {
  /** The directory the suite ran in (the corpus root). */
  readonly rootDir: string
  /** Other roots to replace with `<root>`, e.g. the workspace root. */
  readonly extraRoots?: readonly string[]
}

/**
 * One normalization rule (Track 12 F2). Rules are pure and run in the order of `rules`.
 * @public
 */
export interface Rule {
  readonly id: string
  readonly apply: (s: string, ctx: NormalizeContext) => string
}

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

// CSI sequences (colours, cursor moves) and OSC sequences (hyperlinks), the latter ended by BEL
// or ESC \.
const ANSI = new RegExp(
  `${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`,
  'g',
)

// `file:` with one to three slashes: Node prints three, Jest's transform errors print one. The slashes
// are not repeated in the path, and a fourth is not a file URL at all.
const FILE_URL = /(?<![A-Za-z0-9+.-])file:\/{1,3}(?!\/)([^\s()'"`<>]+)/g

const FRAME_LINE = /^[ \t]*>?[ \t]*\d+ \|/
const CARET_LINE = /^[ \t]*\|[ \t]*\^+/

// The shapes runners print for measured time: `(12 ms)` after a test name, and Jest's summary line
// `Time: 1.2 s` (with `, estimated 2 s` when it has an estimate). A configured value ("timeout of
// 5000 ms", "timed out in 50ms") or a time inside a user's string is not a measurement.
const TIME = String.raw`\d+(?:\.\d+)?\s?(?:ms|µs|μs|ns|s)`
const DURATION_IN_PARENS = new RegExp(String.raw`\(${TIME}\)`, 'g')
const DURATION_SUMMARY = new RegExp(
  String.raw`^([ \t]*Time:[ \t]+)${TIME}(?:, estimated ${TIME})?[ \t]*$`,
  'gm',
)

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const HEX_ADDRESS = /\b0x[0-9a-f]{8,}\b/gi
// The left boundary keeps `<root>/test/tmp/helper.ts` from being read as a temp path.
const TMP_PATH =
  /(?<![\w$.@~%+\-/\\>])(?:\/private)?(?:\/tmp\/|\/var\/folders\/[^/\s]+\/[^/\s]+\/[A-Za-z]\/)[^/\s:'"`()<>]+/g

// A path right after the root, with a boundary on each side, so `/home/me/work/fixture` and
// `/work/fixture@1` are not the root. A space only ends the root when it does not start another
// path segment (`/work/fixture copy/a`).
const ROOT_LEFT = String.raw`(?<![\w$.@~%+\-/\\])`
const ROOT_RIGHT = String.raw`(?=$|[\r\n/\\'"\x60:),;\]}>]|\.(?!\w)|[ \t](?![^\s/]+/))`

// After a drive letter, `\a\b.ts` is a Windows path; after `<root>` it is one only when the root
// itself is. Only those are converted, so a printed string like "a\nb" keeps its backslash.
const WINDOWS_ROOT = /^(?:[A-Za-z]:[\\/]|\\\\)/
const WINDOWS_TAIL = String.raw`((?:\\[^\\\s:'"\x60()<>|*?]+)+)`
const WINDOWS_AFTER_DRIVE = new RegExp(String.raw`((?<!\w)[A-Za-z]:)${WINDOWS_TAIL}`, 'g')
const WINDOWS_AFTER_DRIVE_OR_ROOT = new RegExp(
  String.raw`(<root>|(?<!\w)[A-Za-z]:)${WINDOWS_TAIL}`,
  'g',
)

// A V8 frame: `at <fn> (<location>)` or `at <location>`. A location ends in `:<line>:<col>` or is
// `<anonymous>`, `native` or `index <n>`.
const FRAME_START = /^[ \t]+at[ \t]+(\S.*)$/
const FRAME_WITH_FUNCTION = /^(.+?) \((.*)\)$/
const LINE_AND_COLUMN = /:\d+:\d+$/
const NON_FILE_LOCATION = /^(?:<anonymous>|native|index \d+)$/
const FRAME_LOCATION = /^(.+):(\d+):(\d+)$/
const ERROR_NAME = /^((?:[A-Za-z_$][\w$]*)?(?:Error|Exception))(?=:|\s|$)/

// Already rooted: a path, `<root>`, a drive, a UNC path, or a URL.
const ROOTED = /^(?:[/<\\]|[A-Za-z]:|[A-Za-z][A-Za-z0-9+.-]*:\/)/

const INTERNAL_FRAME = [/node:/, /node_modules[\\/]/, /jest-circus/, /vitest\/dist/]

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function decodePath(path: string): string {
  let decoded = path
  try {
    decoded = decodeURIComponent(path)
  } catch {
    // Not valid percent-encoding: keep the path as written.
  }
  return decoded.replace(/^\/([A-Za-z]:)/, '$1')
}

function trimTrailingSeparators(root: string): string {
  return root.replace(/[\\/]+$/, '')
}

function configuredRoots(ctx: NormalizeContext): string[] {
  return [ctx.rootDir, ...(ctx.extraRoots ?? [])]
}

function rootsOf(ctx: NormalizeContext): string[] {
  const seen = new Set<string>()
  for (const root of configuredRoots(ctx)) {
    const trimmed = trimTrailingSeparators(root)
    if (trimmed === '') continue
    seen.add(trimmed)
    seen.add(trimmed.replace(/\\/g, '/'))
  }
  // Longest first, so a nested root wins over its parent.
  return [...seen].sort((a, b) => b.length - a.length)
}

function replaceRoots(s: string, ctx: NormalizeContext): string {
  let out = s
  for (const root of rootsOf(ctx)) {
    out = out.replace(new RegExp(`${ROOT_LEFT}${escapeRegExp(root)}${ROOT_RIGHT}`, 'g'), '<root>')
  }
  return out
}

function convertWindowsSeparators(s: string, ctx: NormalizeContext): string {
  const afterRoot = configuredRoots(ctx).some((root) => WINDOWS_ROOT.test(root))
  return s.replace(
    afterRoot ? WINDOWS_AFTER_DRIVE_OR_ROOT : WINDOWS_AFTER_DRIVE,
    (_match, head: string, tail: string) => `${head}${tail.replace(/\\/g, '/')}`,
  )
}

/**
 * Removes every code frame, a run of `> 14 | …` lines that includes the caret line. A run without
 * a caret line is kept, so a table of `1 | 2` in a message survives.
 */
function removeCodeFrames(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let group: string[] = []
  let hasCaret = false
  const flush = (): void => {
    if (!hasCaret) out.push(...group)
    group = []
    hasCaret = false
  }
  for (const line of lines) {
    const caret = CARET_LINE.test(line)
    if (caret || FRAME_LINE.test(line)) {
      group.push(line)
      hasCaret ||= caret
    } else {
      flush()
      out.push(line)
    }
  }
  flush()
  return out.join('\n')
}

interface ParsedFrame {
  readonly line: string
  readonly location: string
}

/**
 * The file an `eval at fn (origin), <anonymous>:l:c` frame was called from. Evals nest, so this
 * follows the innermost origin. `undefined` when the location isn't an eval, or isn't well formed.
 */
function evalOrigin(location: string): string | undefined {
  let current = location
  while (current.startsWith('eval at ')) {
    const open = current.indexOf(' (')
    const close = current.lastIndexOf('), ')
    if (open === -1 || close <= open) return undefined
    current = current.slice(open + 2, close)
  }
  return current === location ? undefined : current
}

function isLocation(text: string): boolean {
  return LINE_AND_COLUMN.test(text) || NON_FILE_LOCATION.test(text)
}

function parseFrame(line: string): ParsedFrame | undefined {
  const start = FRAME_START.exec(line)
  const body = start?.[1]?.trimEnd()
  if (body === undefined) return undefined
  const withFunction = FRAME_WITH_FUNCTION.exec(body)
  const location = withFunction?.[2] ?? body.replace(/^async\s+/, '')
  if (!isLocation(location)) return undefined
  return { line, location: evalOrigin(location) ?? location }
}

/**
 * A frame is internal if it matches `node:` (which includes `node:internal`), `node_modules/`,
 * `jest-circus` or `vitest/dist`, or if its location is `<anonymous>` (with or without a position)
 * or an eval whose origin can't be read. The check is on the location, not the function name:
 * `Object.<anonymous> (file:9:26)` is the user's own frame.
 */
function isInternalFrame(frame: ParsedFrame): boolean {
  if (frame.location.startsWith('<anonymous>') || frame.location.startsWith('eval at ')) return true
  return INTERNAL_FRAME.some((pattern) => pattern.test(frame.line))
}

/** `<root>/a.test.ts:7:23` for a user frame; Jest prints file-level paths relative to the root. */
function userFrameOf(frames: readonly ParsedFrame[]): string | undefined {
  for (const frame of frames) {
    if (isInternalFrame(frame) || !FRAME_LOCATION.test(frame.location)) continue
    return ROOTED.test(frame.location) ? frame.location : `<root>/${frame.location}`
  }
  return undefined
}

interface SplitStack {
  /** Everything but the stacks, untrimmed. */
  readonly head: string
  readonly frames: readonly ParsedFrame[]
}

const CAUSE_SEPARATOR = /^(?:\[cause\]|Caused by):/

/**
 * Splits a failure into its message and its stacks. In V8's layout a stack is the run of frame
 * lines that ends the text (blank lines after it don't count). Jest chains an error's cause after
 * a `[cause]:` line, so a run followed by one of those ends a stack too. A frame-shaped line
 * anywhere else, such as one printed in a diff, stays in the message.
 */
function splitStack(text: string): SplitStack {
  const lines = text.split('\n')
  const frames: ParsedFrame[] = []
  const stackLines = new Set<number>()
  let i = 0
  while (i < lines.length) {
    const first = parseFrame(lines[i] ?? '')
    if (first === undefined) {
      i++
      continue
    }
    const run: ParsedFrame[] = [first]
    let end = i + 1
    for (
      let next = parseFrame(lines[end] ?? '');
      next !== undefined;
      next = parseFrame(lines[end] ?? '')
    ) {
      run.push(next)
      end++
    }
    let after = end
    while (after < lines.length && (lines[after] ?? '').trim() === '') after++
    if (after === lines.length || CAUSE_SEPARATOR.test(lines[after] ?? '')) {
      frames.push(...run)
      for (let line = i; line < end; line++) stackLines.add(line)
    }
    i = end
  }
  return { head: lines.filter((_line, index) => !stackLines.has(index)).join('\n'), frames }
}

function tidy(message: string): string {
  return message.replace(/\n{3,}/g, '\n\n').trim()
}

function stackRule(s: string): string {
  const { head, frames } = splitStack(s)
  if (frames.length === 0) return s
  const message = tidy(head)
  const userFrame = userFrameOf(frames)
  return userFrame === undefined ? message : `${message}\nat ${userFrame}`
}

/**
 * The nine normalization rules of Track 12 F2, in order. Each has an id, so a run can report which
 * rules fired and a new kind of noise shows up as "rule X fired on 0 tests".
 * @public
 */
export const rules: readonly Rule[] = [
  { id: 'ansi', apply: (s) => s.replace(ANSI, '') },
  { id: 'crlf', apply: (s) => s.replace(/\r\n/g, '\n') },
  {
    id: 'file-url',
    apply: (s) => s.replace(FILE_URL, (_match, path: string) => decodePath(`/${path}`)),
  },
  { id: 'root', apply: replaceRoots },
  { id: 'windows-separators', apply: convertWindowsSeparators },
  { id: 'code-frames', apply: removeCodeFrames },
  {
    id: 'durations',
    apply: (s) => s.replace(DURATION_IN_PARENS, '(<dur>)').replace(DURATION_SUMMARY, '$1<dur>'),
  },
  {
    id: 'placeholders',
    apply: (s) =>
      s.replace(UUID, '<uuid>').replace(HEX_ADDRESS, '<addr>').replace(TMP_PATH, '<tmp>'),
  },
  { id: 'stack', apply: stackRule },
]

const STACK_RULE_ID = 'stack'
// Frames are paths, so only the path rules may touch them; the stack is split off before the rest
// run, which then see the message alone. A frame in `test/tmp/` or `10s.test.ts` stays as it is.
const PATH_RULES: readonly Rule[] = rules.filter((rule) =>
  ['ansi', 'crlf', 'file-url', 'root', 'windows-separators'].includes(rule.id),
)
const MESSAGE_RULES: readonly Rule[] = rules.filter((rule) =>
  ['code-frames', 'durations', 'placeholders'].includes(rule.id),
)

function applyRules(
  list: readonly Rule[],
  s: string,
  ctx: NormalizeContext,
  fired: Set<string> | undefined,
): string {
  let out = s
  for (const rule of list) {
    const next = rule.apply(out, ctx)
    if (next !== out) fired?.add(rule.id)
    out = next
  }
  return out
}

/** Path rules on the whole text, then the stack split off, then the message rules on the message. */
function normalizeParts(
  text: string,
  ctx: NormalizeContext,
  fired: Set<string> | undefined,
): SplitStack {
  const { head, frames } = splitStack(applyRules(PATH_RULES, text, ctx, fired))
  if (frames.length > 0) fired?.add(STACK_RULE_ID)
  return { head: applyRules(MESSAGE_RULES, head, ctx, fired), frames }
}

/**
 * Applies every rule. `fired` collects the ids of the rules that changed the text. The path rules
 * run on the whole text, the code-frame, duration and placeholder rules on the message only (the
 * stack is split off first), and the stack is reduced to its first user frame.
 * @public
 */
export function normalizeText(s: string, ctx: NormalizeContext, fired?: Set<string>): string {
  const { head, frames } = normalizeParts(s, ctx, fired)
  if (frames.length === 0) return head
  const message = tidy(head)
  const userFrame = userFrameOf(frames)
  return userFrame === undefined ? message : `${message}\nat ${userFrame}`
}

/**
 * Normalizes a failure: the stack is split from the message, only the first user frame is kept, as
 * `<root>/path:line:col`, and the message is cleaned by the eight text rules. `raw` keeps the input
 * untouched, for drill-down only. `fired` also collects the `stack` rule when the text had frames.
 * @public
 */
export function normalizeError(
  raw: string,
  ctx: NormalizeContext,
  matcher?: string,
  fired?: Set<string>,
): NormalizedError {
  const { head, frames } = normalizeParts(raw, ctx, fired)
  const message = tidy(head)
  const name = ERROR_NAME.exec(message)?.[1]
  const userFrame = userFrameOf(frames)
  return {
    ...(name === undefined ? {} : { name }),
    message,
    ...(matcher === undefined ? {} : { matcher }),
    ...(userFrame === undefined ? {} : { userFrame }),
    raw,
  }
}

/**
 * The key a test is compared by across runners: `file::a › b#0`, with its title path joined by
 * ` › ` and its duplicate index after `#`.
 * @public
 */
export function testKey(id: TestIdentity): string {
  return `${id.file}::${pathText(id.path)}#${id.dupIndex}`
}
