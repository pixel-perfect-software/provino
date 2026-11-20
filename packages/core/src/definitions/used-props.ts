// Which keys a function reads from its fixtures argument, from its source text (T5.9): the
// parameter at `index` must be an object pattern, and each of its properties is a key. Provino's
// own code, following the rules of Vitest 5.0.5's `getUsedProps` (`runner/fixture.ts`): comments
// are dropped first, a function lowered from `async` (`__async(this, null, function* ...`) is read
// from its generator, a default or a rename (`{ a = 1, b: c }`) names `a` and `b`, and a rest
// element is refused.
import { type DefinitionWords, definitionError, type ErrorSite } from './errors.ts'

/** Any function: its source is what is read. */
export type AnyFunction = (...args: never[]) => unknown

/** Where to read the props from, when it is not the function itself (a wrapper's original). */
export interface PropsSource {
  /** The parameter that holds the fixtures. */
  readonly index: number
  /** The function whose source is read. */
  readonly original: AnyFunction
}

/** Why the props are read: a suite hook's errors say what to do instead. */
export interface PropsReading {
  /** The parameter that holds the fixtures, unless `propsFrom` named it (default 0). */
  readonly index?: number
  readonly suiteHook?: 'beforeAll' | 'afterAll' | 'aroundAll'
  readonly site?: ErrorSite
}

const NONE: ReadonlySet<string> = new Set()
const memo = new WeakMap<AnyFunction, ReadonlySet<string>>()
const sources = new WeakMap<AnyFunction, PropsSource>()

/** Records that `fn`'s props are read from `source` (a wrapper of a user function). */
export function propsFrom(fn: AnyFunction, source: PropsSource): void {
  sources.set(fn, source)
}

/** The keys `fn` destructures from its fixtures argument; memoized per function. */
export function usedProps(
  fn: AnyFunction,
  words: DefinitionWords,
  reading: PropsReading = {},
): ReadonlySet<string> {
  const known = memo.get(fn)
  if (known !== undefined) return known
  const { index, original } = sources.get(fn) ?? { index: reading.index ?? 0, original: fn }
  const props = readProps(Function.prototype.toString.call(original), index, words, reading)
  memo.set(fn, props)
  return props
}

/**
 * The keys `fn`'s parameter at `index` destructures, or none when it is not an object pattern
 * (where a parse error would be): for a function that may take something else there (core's
 * suite hooks get the suite first). Memoized per function.
 */
export function destructuredProps(fn: AnyFunction, index: number): ReadonlySet<string> {
  const known = loose.get(fn)
  if (known !== undefined) return known
  let props: ReadonlySet<string>
  try {
    props = readProps(Function.prototype.toString.call(fn), index, { format: undefined }, {})
  } catch {
    // Not an object pattern, or a rest element: nothing a definition could be read into.
    props = NONE
  }
  loose.set(fn, props)
  return props
}

const loose = new WeakMap<AnyFunction, ReadonlySet<string>>()

const LOWERED_ASYNC = /__async\((?:this|null), (?:null|arguments|\[[_0-9, ]*\]), function\*/

function readProps(
  source: string,
  index: number,
  words: DefinitionWords,
  reading: PropsReading,
): ReadonlySet<string> {
  let text = withoutComments(source)
  if (LOWERED_ASYNC.test(text)) text = text.split(/__async\((?:this|null),/)[1] ?? text
  const match = /[^(]*\(([^)]*)/.exec(text)
  if (match === null) return NONE
  const args = splitTopLevel(match[1] ?? '')
  const argument = args[index]
  if (argument === undefined) return NONE
  if (!(argument.startsWith('{') && argument.endsWith('}'))) {
    const position = ordinal(index + 1)
    throw definitionError(
      words,
      {
        kind: 'parse',
        code: 'not-destructured',
        key: '',
        message: `The ${position} parameter of a function that reads definitions must be an object pattern, as in ({ task }) => {}, not "${argument}".`,
        params: {
          position,
          received: argument,
          next: ordinal(index + 2),
          ...(reading.suiteHook === undefined ? {} : { suiteHook: reading.suiteHook }),
        },
      },
      reading.site,
    )
  }
  const props = splitTopLevel(argument.slice(1, -1).replace(/\s/g, '')).map((prop) =>
    prop.replace(/:.*|=.*/g, ''),
  )
  const last = props.at(-1)
  if (last?.startsWith('...')) {
    throw definitionError(
      words,
      {
        kind: 'parse',
        code: 'rest-element',
        key: '',
        message: `A function that reads definitions cannot take a rest element (${last}): name each key.`,
        params: { received: last },
      },
      reading.site,
    )
  }
  return new Set(props)
}

/** `s` with its `//` and `/* *\/` comments removed (Vitest's `filterOutComments`'s rules). */
function withoutComments(s: string): string {
  let out = ''
  let state: 'none' | 'line' | 'block' = 'none'
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (state === 'line') {
      if (c === '\n') state = 'none'
    } else if (state === 'block') {
      if (s[i - 1] === '*' && c === '/') state = 'none'
    } else if (c === '/' && s[i + 1] === '/') {
      state = 'line'
    } else if (c === '/' && s[i + 1] === '*') {
      state = 'block'
      i += 2
    } else {
      out += c
    }
  }
  return out
}

/** Splits on the commas outside `{}` and `[]`, trimming each part and dropping empty ones. */
function splitTopLevel(s: string): string[] {
  const parts: string[] = []
  const closers: string[] = []
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '{' || c === '[') closers.push(c === '{' ? '}' : ']')
    else if (c === closers.at(-1)) closers.pop()
    else if (closers.length === 0 && c === ',') {
      const part = s.slice(start, i).trim()
      if (part !== '') parts.push(part)
      start = i + 1
    }
  }
  const tail = s.slice(start).trim()
  if (tail !== '') parts.push(tail)
  return parts
}

/** `1st`, `2nd`, `3rd`, `4th`, `11th`, … */
export function ordinal(n: number): string {
  const j = n % 10
  const k = n % 100
  if (j === 1 && k !== 11) return `${n}st`
  if (j === 2 && k !== 12) return `${n}nd`
  if (j === 3 && k !== 13) return `${n}rd`
  return `${n}th`
}
