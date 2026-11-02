import type { NormalizedError, TestIdentity } from '@provino/types'

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

const FILE_URL = /file:\/\/(\/[^\s()'"`<>]*)/g

const FRAME_LINE = /^[ \t]*>?[ \t]*\d+ \|/
const CARET_LINE = /^[ \t]*\|[ \t]*\^+/

const DURATION = /\b\d+(?:\.\d+)?\s?(?:ms|µs|μs|ns|s)\b/g

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const HEX_ADDRESS = /\b0x[0-9a-f]{8,}\b/gi
const TMP_PATH =
  /(?:\/private)?(?:\/tmp\/|\/var\/folders\/[^/\s]+\/[^/\s]+\/[A-Za-z]\/)[^/\s:'"`()<>]+/g

// After `<root>` or a drive letter, `\a\b.ts` is a Windows path. Only those are converted, so a
// printed string like "a\nb" keeps its backslash.
const WINDOWS_PATH = /(<root>|(?<!\w)[A-Za-z]:)((?:\\[^\\\s:'"`()<>|*?]+)+)/g

const STACK_FRAME = /^\s+at\s+\S/
const FRAME_LOCATION = /^(.+):(\d+):(\d+)$/
const ERROR_NAME = /^((?:[A-Za-z_$][\w$]*)?(?:Error|Exception))(?=:|\s|$)/

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

function rootsOf(ctx: NormalizeContext): string[] {
  const seen = new Set<string>()
  for (const root of [ctx.rootDir, ...(ctx.extraRoots ?? [])]) {
    const trimmed = trimTrailingSeparators(root)
    if (trimmed === '') continue
    seen.add(trimmed)
    seen.add(trimmed.replace(/\\/g, '/'))
  }
  // Longest first, so a nested root wins over its parent.
  return [...seen].sort((a, b) => b.length - a.length)
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

function parseFrame(line: string): ParsedFrame | undefined {
  if (!STACK_FRAME.test(line)) return undefined
  const body = line.trim().replace(/^at\s+/, '')
  const parenthesised = /^(?:.*?\s)?\((.*)\)$/.exec(body)
  const location = parenthesised?.[1] ?? body.replace(/^async\s+/, '')
  return { line, location }
}

/**
 * A frame is internal if it matches `node:` (which includes `node:internal`), `node_modules/`,
 * `jest-circus` or `vitest/dist`, or if its whole location is `(<anonymous>)`. The check is on the
 * location, not the function name: `Object.<anonymous> (file:9:26)` is the user's own frame.
 */
function isInternalFrame(frame: ParsedFrame): boolean {
  if (frame.location === '<anonymous>') return true
  return INTERNAL_FRAME.some((pattern) => pattern.test(frame.line))
}

/** `<root>/a.test.ts:7:23` for a user frame; Jest prints file-level paths relative to the root. */
function userFrameOf(frames: readonly ParsedFrame[]): string | undefined {
  for (const frame of frames) {
    if (isInternalFrame(frame) || !FRAME_LOCATION.test(frame.location)) continue
    const location = frame.location
    const rooted = /^(?:[/<]|[A-Za-z]:|[a-z][a-z0-9+.-]*:\/\/)/.test(location)
    return rooted ? location : `<root>/${location}`
  }
  return undefined
}

interface SplitStack {
  readonly message: string
  readonly frames: readonly ParsedFrame[]
}

function splitStack(text: string): SplitStack {
  const messageLines: string[] = []
  const frames: ParsedFrame[] = []
  for (const line of text.split('\n')) {
    const frame = parseFrame(line)
    if (frame) frames.push(frame)
    else messageLines.push(line)
  }
  const message = messageLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { message, frames }
}

/**
 * The nine normalization rules of Track 12 F2, in order. Each has an id, so a run can report which
 * rules fired and a new kind of noise shows up as "rule X fired on 0 tests".
 * @public
 */
export const rules: readonly Rule[] = [
  { id: 'ansi', apply: (s) => s.replace(ANSI, '') },
  { id: 'crlf', apply: (s) => s.replace(/\r\n/g, '\n') },
  { id: 'file-url', apply: (s) => s.replace(FILE_URL, (_match, path: string) => decodePath(path)) },
  {
    id: 'root',
    apply: (s, ctx) => {
      let out = s
      for (const root of rootsOf(ctx)) {
        out = out.replace(new RegExp(`${escapeRegExp(root)}(?![\\w-]|\\.\\w)`, 'g'), '<root>')
      }
      return out
    },
  },
  {
    id: 'windows-separators',
    apply: (s) =>
      s.replace(
        WINDOWS_PATH,
        (_match, head: string, tail: string) => `${head}${tail.replace(/\\/g, '/')}`,
      ),
  },
  { id: 'code-frames', apply: removeCodeFrames },
  { id: 'durations', apply: (s) => s.replace(DURATION, '<dur>') },
  {
    id: 'placeholders',
    apply: (s) =>
      s.replace(UUID, '<uuid>').replace(HEX_ADDRESS, '<addr>').replace(TMP_PATH, '<tmp>'),
  },
  {
    id: 'stack',
    apply: (s) => {
      const { message, frames } = splitStack(s)
      if (frames.length === 0) return s
      const userFrame = userFrameOf(frames)
      return userFrame === undefined ? message : `${message}\nat ${userFrame}`
    },
  },
]

const STACK_RULE_ID = 'stack'
const TEXT_RULES: readonly Rule[] = rules.filter((rule) => rule.id !== STACK_RULE_ID)

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

/**
 * Applies every rule, in order. `fired` collects the ids of the rules that changed the text.
 * @public
 */
export function normalizeText(s: string, ctx: NormalizeContext, fired?: Set<string>): string {
  return applyRules(rules, s, ctx, fired)
}

/**
 * Normalizes a failure: the eight text rules, then the stack is split from the message and only
 * the first user frame is kept, as `<root>/path:line:col`. `raw` keeps the input untouched, for
 * drill-down only. `fired` also collects the `stack` rule when the text had frames.
 * @public
 */
export function normalizeError(
  raw: string,
  ctx: NormalizeContext,
  matcher?: string,
  fired?: Set<string>,
): NormalizedError {
  const { message, frames } = splitStack(applyRules(TEXT_RULES, raw, ctx, fired))
  if (frames.length > 0) fired?.add(STACK_RULE_ID)
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
  return `${id.file}::${id.path.join(' › ')}#${id.dupIndex}`
}
