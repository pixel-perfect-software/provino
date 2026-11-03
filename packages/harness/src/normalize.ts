import type { NormalizedError, TestIdentity } from '@provino/types'
import { escapeRegExp } from './internal/guards.ts'
import { pathText } from './internal/keys.ts'
import { PATH_LEFT_CLASS, ROOT_PLACEHOLDER, WINDOWS_ABSOLUTE } from './internal/paths.ts'
import { messageOf, parseStack, userFrameOf } from './internal/stack.ts'

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
 * `scope` is where it runs: `path` rules on the whole text, stack included (frames are paths);
 * `message` rules on the text that is left once the stack is split off; the `stack` rule is the
 * split itself, which reduces the stack to its first user frame.
 * @public
 */
export interface Rule {
  readonly id: string
  readonly scope: 'path' | 'message' | 'stack'
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

const ERROR_NAME = /^((?:[A-Za-z_$][\w$]*)?(?:Error|Exception))(?=:|\s|$)/

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
  readonly scope: Rule['scope']
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

/**
 * The nine normalization rules of Track 12 F2, in order. Each has an id, so a run can report which
 * rules fired and a new kind of noise shows up as "rule X fired on 0 tests".
 * @public
 */
export const rules: readonly Rule[] = SPECS.map(({ id, scope, run }) => ({
  id,
  scope,
  apply: (s, ctx) => run(s, compile(ctx)),
}))

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
 * Normalizes text and failures against one context, which is compiled once.
 * @internal
 */
export interface Normalizer {
  /** See `normalizeText`. */
  readonly text: (s: string, fired?: Set<string>) => string
  /** See `normalizeError`. */
  readonly error: (raw: string, matcher?: string, fired?: Set<string>) => NormalizedError
}

/**
 * A normalizer for one context. `normalizeText` and `normalizeError` compile their context on
 * every call; a converter normalizes many failures in one run, so it makes one of these instead.
 * @internal
 */
export function createNormalizer(ctx: NormalizeContext): Normalizer {
  const compiled = compile(ctx)
  return {
    text(s, fired) {
      const { message, userFrame, hasStack } = split(s, compiled, fired)
      return hasStack ? withUserFrame(message, userFrame) : message
    },
    error(raw, matcher, fired) {
      const { message: untidied, userFrame } = split(raw, compiled, fired)
      const message = tidy(untidied)
      const name = ERROR_NAME.exec(message)?.[1]
      return {
        ...(name === undefined ? {} : { name }),
        message,
        ...(matcher === undefined ? {} : { matcher }),
        ...(userFrame === undefined ? {} : { userFrame }),
        raw,
      }
    },
  }
}

/**
 * Applies every rule. `fired` collects the ids of the rules that changed the text. The path rules
 * run on the whole text, the code-frame, duration and placeholder rules on the message only (the
 * stack is split off first), and the stack is reduced to its first user frame.
 * @public
 */
export function normalizeText(s: string, ctx: NormalizeContext, fired?: Set<string>): string {
  return createNormalizer(ctx).text(s, fired)
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
  return createNormalizer(ctx).error(raw, matcher, fired)
}

/**
 * The key a test is compared by across runners: `file::a › b#0`, with its title path joined by
 * ` › ` and its duplicate index after `#`. A `\` or `›` inside a title is escaped with `\`, so two
 * tests with different title paths never share a key.
 * @public
 */
export function testKey(id: TestIdentity): string {
  return `${id.file}::${pathText(id.path)}#${id.dupIndex}`
}
