// The recorder's text normalizer (`@provino/harness` `normalize.ts` `createNormalizer(...).text`,
// with `internal/stack.ts` and the constants of `internal/paths.ts`), for the Provino side of a
// comparison: a recording's streams and `file:` captures went through it before `keepLines`, so a
// code frame, a duration or a stack the recorder reduced is reduced here the same way. A copy, like
// `mask.ts` and `sweep.ts`: `provino` may not import the harness. Change both:
// `recorder-text.test.ts` holds this copy to the harness's own on the same inputs.

const ROOT_PLACEHOLDER = '<root>'
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/
const PATH_LEFT_CLASS = String.raw`\w$.@~%+\-/\\`

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Where a run happened: the roots that become `<root>`. */
interface NormalizeContext {
  readonly rootDir: string
  readonly extraRoots?: readonly string[]
}

/**
 * Where a frame says it ran. A file location keeps its line and column as written. An `eval`
 * frame names the innermost place `eval` was called from, when it can be read.
 */
type Loc =
  | { readonly kind: 'file'; readonly path: string; readonly line: string; readonly col: string }
  | { readonly kind: 'native' }
  | { readonly kind: 'index'; readonly index: string }
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'eval'; readonly origin: Loc | undefined }

/** One V8 frame: `at <fn> (<loc>)` or `at <loc>`, with `async` before the function or location. */
interface Frame {
  readonly fn: string | undefined
  readonly async: boolean
  readonly loc: Loc
}

/**
 * The text between two cause lines: its message lines, and the frames that end it. Jest chains an
 * error's cause after a `[cause]:` line, so a failure can hold several stacks.
 */
interface Segment {
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
function parseStack(text: string): Segment[] {
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
function messageOf(segments: readonly Segment[]): string {
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
function userFrameOf(segments: readonly Segment[]): string | undefined {
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

// A path right after the root, with a boundary on each side, so `/home/me/work/fixture` and
// `/work/fixture@1` are not the root. A space only ends the root when it does not start another
// path segment (`/work/fixture copy/a`). A temp path needs the same left boundary, and `>` too, which
// keeps `<root>/test/tmp/helper.ts` from being read as a temp path.
const PATH_LEFT = `(?<![${PATH_LEFT_CLASS}])`
const ROOT_RIGHT = String.raw`(?=$|[\r\n/\\'"\x60:),;\]}>]|\.(?!\w)|[ \t](?![^\s/]+/))`
const TMP_PATH = new RegExp(
  String.raw`(?<![${PATH_LEFT_CLASS}>])(?:\/private)?(?:\/tmp\/|\/var\/folders\/[^/\s]+\/[^/\s]+\/[A-Za-z]\/)[^/\s:'"\x60()<>]+`,
  'g',
)

// After a drive letter, `\a\b.ts` is a Windows path; after `<root>` it is one only when a root
// itself is. Only those are converted, so a printed string like "a\nb" keeps its backslash.
const WINDOWS_TAIL = String.raw`((?:\\[^\\\s:'"\x60()<>|*?]+)+)`

function decodePath(path: string): string {
  let decoded = path
  try {
    decoded = decodeURIComponent(path)
  } catch {
    // Not valid percent-encoding: keep the path as written.
  }
  return decoded.replace(/^\/([A-Za-z]:)/, '$1')
}

/** What a context turns into once: the patterns its roots need. */
interface Compiled {
  /** One pattern per root, longest first, so a nested root wins over its parent. */
  readonly rootPatterns: readonly RegExp[]
  /** A drive letter followed by backslash segments, and `<root>` too when a root is Windows. */
  readonly windowsPaths: RegExp
}

function compile(ctx: NormalizeContext): Compiled {
  const configured = [ctx.rootDir, ...(ctx.extraRoots ?? [])]
  const roots = new Set<string>()
  for (const root of configured) {
    const trimmed = root.replace(/[\\/]+$/, '')
    if (trimmed === '') continue
    roots.add(trimmed)
    roots.add(trimmed.replace(/\\/g, '/'))
  }
  const afterRoot = configured.some((root) => WINDOWS_ABSOLUTE.test(root))
  return {
    rootPatterns: [...roots]
      .sort((a, b) => b.length - a.length)
      .map((root) => new RegExp(`${PATH_LEFT}${escapeRegExp(root)}${ROOT_RIGHT}`, 'g')),
    windowsPaths: new RegExp(
      String.raw`(${afterRoot ? `${ROOT_PLACEHOLDER}|` : ''}(?<!\w)[A-Za-z]:)${WINDOWS_TAIL}`,
      'g',
    ),
  }
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

function tidy(message: string): string {
  return message.replace(/\n{3,}/g, '\n\n').trim()
}

/** The message, then `at <user frame>` when the stack has one. */
function withUserFrame(message: string, userFrame: string | undefined): string {
  const tidied = tidy(message)
  return userFrame === undefined ? tidied : `${tidied}\nat ${userFrame}`
}

/** A rule as the normalizer runs it: against a context that is already compiled. */
interface RuleSpec {
  readonly id: string
  readonly scope: 'path' | 'message' | 'stack'
  readonly run: (s: string, compiled: Compiled) => string
}

const STACK_RULE_ID = 'stack'

const SPECS: readonly RuleSpec[] = [
  { id: 'ansi', scope: 'path', run: (s) => s.replace(ANSI, '') },
  { id: 'crlf', scope: 'path', run: (s) => s.replace(/\r\n/g, '\n') },
  {
    id: 'file-url',
    scope: 'path',
    run: (s) => s.replace(FILE_URL, (_match, path: string) => decodePath(`/${path}`)),
  },
  {
    id: 'root',
    scope: 'path',
    run: (s, { rootPatterns }) =>
      rootPatterns.reduce((out, pattern) => out.replace(pattern, ROOT_PLACEHOLDER), s),
  },
  {
    id: 'windows-separators',
    scope: 'path',
    run: (s, { windowsPaths }) =>
      s.replace(
        windowsPaths,
        (_match, head: string, tail: string) => `${head}${tail.replace(/\\/g, '/')}`,
      ),
  },
  { id: 'code-frames', scope: 'message', run: removeCodeFrames },
  {
    id: 'durations',
    scope: 'message',
    run: (s) => s.replace(DURATION_IN_PARENS, '(<dur>)').replace(DURATION_SUMMARY, '$1<dur>'),
  },
  {
    id: 'placeholders',
    scope: 'message',
    run: (s) => s.replace(UUID, '<uuid>').replace(HEX_ADDRESS, '<addr>').replace(TMP_PATH, '<tmp>'),
  },
  {
    id: STACK_RULE_ID,
    scope: 'stack',
    run: (s) => {
      const segments = parseStack(s)
      if (segments.every((segment) => segment.frames.length === 0)) return s
      return withUserFrame(messageOf(segments), userFrameOf(segments))
    },
  },
]

// Frames are paths, so only the path rules may touch them; the stack is split off before the rest
// run, which then see the message alone. A frame in `test/tmp/` or `10s.test.ts` stays as it is.
const PATH_RULES: readonly RuleSpec[] = SPECS.filter((rule) => rule.scope === 'path')
const MESSAGE_RULES: readonly RuleSpec[] = SPECS.filter((rule) => rule.scope === 'message')

function applyRules(
  list: readonly RuleSpec[],
  s: string,
  compiled: Compiled,
  fired: Set<string> | undefined,
): string {
  let out = s
  for (const rule of list) {
    const next = rule.run(out, compiled)
    if (next !== out) fired?.add(rule.id)
    out = next
  }
  return out
}

interface Split {
  /** Everything but the stacks, untidied. */
  readonly message: string
  readonly userFrame: string | undefined
  readonly hasStack: boolean
}

/** Path rules on the whole text, then the stack split off, then the message rules on the message. */
function split(text: string, compiled: Compiled, fired: Set<string> | undefined): Split {
  const segments = parseStack(applyRules(PATH_RULES, text, compiled, fired))
  const hasStack = segments.some((segment) => segment.frames.length > 0)
  if (hasStack) fired?.add(STACK_RULE_ID)
  return {
    message: applyRules(MESSAGE_RULES, messageOf(segments), compiled, fired),
    userFrame: userFrameOf(segments),
    hasStack,
  }
}

/**
 * The recorder's `normalizer.text` over these roots (the first is the run's root): the path rules
 * on the whole text, the stack split off and reduced to its first user frame, the code-frame,
 * duration and placeholder rules on the message.
 */
export function recorderText(roots: readonly string[]): (text: string) => string {
  const [rootDir = '', ...extraRoots] = roots
  const compiled = compile({ rootDir, extraRoots })
  return (s) => {
    const { message, userFrame, hasStack } = split(s, compiled, undefined)
    return hasStack ? withUserFrame(message, userFrame) : message
  }
}
