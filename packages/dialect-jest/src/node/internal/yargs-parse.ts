// T11.7: the part of yargs 17.7.3 / yargs-parser 21.1.1 that Jest's `buildArgv` uses, rebuilt (no
// dependency on either). `jest-cli` calls `yargs(args).options(table)` with yargs' defaults, so
// the parser runs with yargs-parser's default configuration (camel-case expansion, dot notation,
// boolean negation, duplicate-argument arrays, greedy arrays, short-option groups, number
// parsing) plus the three settings yargs itself adds: `populate--`, `parse-positional-numbers`
// off (the positionals are converted afterwards, by yargs' `kParsePositionalNumbers`), and
// `requiresArg` (an `narg` of `NaN`). The code follows yargs-parser's `parse()` branch for branch
// (`build/lib/yargs-parser.js`), minus the parts Jest's setup never reaches (counts, `normalize`,
// `coerce`, config files, environment variables, defaults, `halt-at-non-option`,
// `unknown-options-as-args`). `cli.test.ts` compares the result with the real `buildArgv` on a
// fixed corpus and a generated one.

/** A parsed value bag. */
export type Bag = Record<string, unknown>

/** One option as `jest-cli` hands it to yargs. */
export interface YargsOption {
  readonly key: string
  readonly alias?: string | undefined
  readonly type?: 'boolean' | 'string' | 'number' | 'array' | undefined
  /** yargs `string: true` (an array whose elements stay strings). */
  readonly string?: boolean | undefined
  /** yargs `requiresArg: true` (an `narg` of `NaN`). */
  readonly requiresArg?: boolean | undefined
}

/** What yargs-parser's `detailed()` gives the yargs layer. */
export interface YargsParsed {
  /** The argv, with `_` (strings) and, when there was a `--`, `'--'` (the arguments after it). */
  readonly argv: Bag
  /** The last parse error (`Not enough arguments following: x`), which yargs throws. */
  readonly error: Error | null
}

const NEGATIVE = /^-([0-9]+(\.[0-9]+)?|\.[0-9]+)$/
const NEGATED_BOOLEAN = /^--no-(.+)/

/** yargs-parser `string-utils.js` `camelCase`. */
export function camelCase(input: string): string {
  let str = input
  const isCamelCase = str !== str.toLowerCase() && str !== str.toUpperCase()
  if (!isCamelCase) str = str.toLowerCase()
  if (!str.includes('-') && !str.includes('_')) return str
  let camelcase = ''
  let nextChrUpper = false
  const leadingHyphens = str.match(/^-+/)
  for (let i = leadingHyphens ? (leadingHyphens[0]?.length ?? 0) : 0; i < str.length; i++) {
    let chr = str.charAt(i)
    if (nextChrUpper) {
      nextChrUpper = false
      chr = chr.toUpperCase()
    }
    if (i !== 0 && (chr === '-' || chr === '_')) nextChrUpper = true
    else if (chr !== '-' && chr !== '_') camelcase += chr
  }
  return camelcase
}

/** yargs-parser `string-utils.js` `decamelize`. */
export function decamelize(str: string, joinString: string): string {
  const lowercase = str.toLowerCase()
  let notCamelcase = ''
  for (let i = 0; i < str.length; i++) {
    const chrLower = lowercase.charAt(i)
    const chrString = str.charAt(i)
    if (chrLower !== chrString && i > 0) notCamelcase += `${joinString}${lowercase.charAt(i)}`
    else notCamelcase += chrString
  }
  return notCamelcase
}

/** yargs-parser `string-utils.js` `looksLikeNumber`. */
export function looksLikeNumber(x: unknown): boolean {
  if (x === null || x === undefined) return false
  if (typeof x === 'number') return true
  const text = String(x)
  if (/^0x[0-9a-f]+$/i.test(text)) return true
  if (/^0[^.]/.test(text)) return false
  return /^[-]?(?:\d+(?:\.\d*)?|\.\d+)(e[-+]?\d+)?$/.test(text)
}

/** `combineAliases`: aliases that share a name are merged into one group. */
function combineAliases(aliases: ReadonlyMap<string, readonly string[]>): Map<string, string[]> {
  let aliasArrays: string[][] = []
  const combined = new Map<string, string[]>()
  for (const [key, list] of aliases) aliasArrays.push([...list, key])
  let change = true
  while (change) {
    change = false
    for (let i = 0; i < aliasArrays.length; i++) {
      for (let ii = i + 1; ii < aliasArrays.length; ii++) {
        const left = aliasArrays[i] ?? []
        const right = aliasArrays[ii] ?? []
        if (left.some((value) => right.includes(value))) {
          aliasArrays[i] = left.concat(right)
          aliasArrays = aliasArrays.filter((_, index) => index !== ii)
          change = true
          break
        }
      }
    }
  }
  for (const group of aliasArrays) {
    const unique = group.filter((value, index, self) => self.indexOf(value) === index)
    const lastAlias = unique.pop()
    if (lastAlias !== undefined) combined.set(lastAlias, unique)
  }
  return combined
}

function sanitizeKey(key: string | undefined): string {
  return key === '__proto__' ? '___proto___' : (key ?? '')
}

function stripQuotes(val: unknown): unknown {
  return typeof val === 'string' &&
    (val[0] === "'" || val[0] === '"') &&
    val[val.length - 1] === val[0]
    ? val.substring(1, val.length - 1)
    : val
}

type Flag = ReadonlyMap<string, unknown>

/**
 * Parses `args` as yargs does for Jest's options: `help` and `version` (booleans yargs adds, with
 * the alias `h` for `help`) and the given options.
 */
export function yargsParse(args: readonly string[], options: readonly YargsOption[]): YargsParsed {
  // --- the flags yargs builds from `.options()` (yargs-factory.js `option()`) -----------------
  const bools = new Map<string, unknown>()
  const strings = new Map<string, unknown>()
  const numbers = new Map<string, unknown>()
  const arrays = new Map<string, unknown>()
  const nargs = new Map<string, unknown>()
  const trackedKeys: string[] = []
  const aliasInput = new Map<string, string[]>()
  const track = (key: string): void => {
    if (!trackedKeys.includes(key)) trackedKeys.push(key)
  }
  // `help` (yargs' `addHelpOpt`), `version` (`.version(v)`), then `.alias('help', 'h')`.
  track('help')
  bools.set('help', true)
  track('version')
  bools.set('version', true)
  aliasInput.set('help', ['h'])
  for (const option of options) {
    track(option.key)
    if (option.alias !== undefined) aliasInput.set(option.key, [option.alias])
    const typed = (table: Map<string, unknown>): void => {
      table.set(option.key, true)
      track(option.key)
      if (option.alias !== undefined) {
        table.set(option.alias, true)
        track(option.alias)
      }
    }
    if (option.type === 'boolean') typed(bools)
    if (option.type === 'array') typed(arrays)
    if (option.type === 'number') typed(numbers)
    if (option.type === 'string' || option.string === true) typed(strings)
    if (option.requiresArg === true) nargs.set(option.key, Number.NaN)
  }

  // --- aliases (yargs-parser `extendAliases`) ------------------------------------------------
  const aliases = combineAliases(aliasInput)
  const flagAliases = new Map<string, string[]>()
  for (const source of [trackedKeys, [...aliases.keys()], [...arrays.keys()]]) {
    for (const key of source) {
      if (flagAliases.has(key)) continue
      const list = [...(aliases.get(key) ?? [])]
      flagAliases.set(key, list)
      for (const x of [...list, key]) {
        if (/-/.test(x)) {
          const c = camelCase(x)
          if (c !== key && !list.includes(c)) list.push(c)
        }
      }
      for (const x of [...list, key]) {
        if (x.length > 1 && /[A-Z]/.test(x)) {
          const c = decamelize(x, '-')
          if (c !== key && !list.includes(c)) list.push(c)
        }
      }
      for (const x of list) {
        flagAliases.set(x, [key, ...list.filter((y) => x !== y)])
      }
    }
  }

  function checkAllAliases(key: string, flag: Flag): unknown {
    const toCheck = [...(flagAliases.get(key) ?? []), key]
    const found = toCheck.find((candidate) => flag.has(candidate))
    return found === undefined ? false : flag.get(found)
  }

  // --- the parse -----------------------------------------------------------------------------
  let error: Error | null = null
  let notFlags: string[] = []
  const argv: Bag = Object.assign(Object.create(null) as Bag, { _: [] as unknown[] })

  function guessType(key: string): 'boolean' | 'string' | 'number' | 'array' {
    if (checkAllAliases(key, strings)) return 'string'
    if (checkAllAliases(key, numbers)) return 'number'
    if (checkAllAliases(key, bools)) return 'boolean'
    if (checkAllAliases(key, arrays)) return 'array'
    return 'boolean'
  }

  function defaultValue(key: string): unknown {
    const type = guessType(key)
    if (type === 'boolean') return true
    if (type === 'string') return ''
    if (type === 'number') return undefined
    return []
  }

  function maybeCoerceNumber(key: string, input: unknown): unknown {
    let value = input
    // `parse-positional-numbers` is off: the positionals are converted after the parse.
    if (key === '_') return value
    if (!checkAllAliases(key, strings) && !checkAllAliases(key, bools) && !Array.isArray(value)) {
      const shouldCoerceNumber =
        looksLikeNumber(value) && Number.isSafeInteger(Math.floor(Number.parseFloat(`${value}`)))
      if (shouldCoerceNumber || (value !== undefined && checkAllAliases(key, numbers))) {
        value = Number(value)
      }
    }
    return value
  }

  function processValue(key: string, input: unknown, shouldStripQuotes: boolean): unknown {
    let val = input
    if (shouldStripQuotes) val = stripQuotes(val)
    if (checkAllAliases(key, bools) && typeof val === 'string') val = val === 'true'
    return Array.isArray(val)
      ? val.map((v: unknown) => maybeCoerceNumber(key, v))
      : maybeCoerceNumber(key, val)
  }

  function setKey(obj: Bag, keys: readonly string[], value: unknown): void {
    let o: Bag = obj
    for (const rawKey of keys.slice(0, -1)) {
      const key = sanitizeKey(rawKey)
      if (typeof o === 'object' && o[key] === undefined) o[key] = {}
      const inner = o[key]
      if (typeof inner !== 'object' || Array.isArray(inner)) {
        // an array whose last item is an empty object that the rest of the key fills in
        if (Array.isArray(inner)) inner.push({})
        else o[key] = [inner, {}]
        const list = o[key] as Bag[]
        o = list[list.length - 1] as Bag
      } else {
        o = inner as Bag
      }
    }
    const key = sanitizeKey(keys[keys.length - 1])
    const isTypeArray = checkAllAliases(keys.join('.'), arrays)
    const isValueArray = Array.isArray(value)
    const current = o[key]
    if (value === 1) {
      // yargs-parser compares with `increment()` (no argument: 1), meant for its count options, so
      // a numeric 1 is added to whatever the key holds: `--x=1 --x=1` is `x: 2`, `--x=2 --x=1` is 3
      o[key] = current === undefined ? 1 : (current as number) + 1
    } else if (Array.isArray(current)) {
      // `duplicate-arguments-array` and `flatten-duplicate-arrays` are on.
      o[key] = isTypeArray && isValueArray ? current.concat(value) : current.concat([value])
    } else if (current === undefined && isTypeArray) {
      o[key] = isValueArray ? value : [value]
    } else if (!(current === undefined || checkAllAliases(key, bools))) {
      o[key] = [current, value]
    } else {
      o[key] = value
    }
  }

  function addNewAlias(key: string, alias: string): void {
    if (!(flagAliases.get(key)?.length ?? 0)) flagAliases.set(key, [alias])
    if (!(flagAliases.get(alias)?.length ?? 0)) addNewAlias(alias, key)
  }

  function setArg(key: string, val: unknown, shouldStripQuotes = false): void {
    if (/-/.test(key)) {
      const alias = key.split('.').map(camelCase).join('.')
      addNewAlias(key, alias)
    }
    const value = processValue(key, val, shouldStripQuotes)
    const splitKey = key.split('.')
    setKey(argv, splitKey, value)
    // the aliases of the full key
    for (const x of flagAliases.get(key) ?? []) setKey(argv, x.split('.'), value)
    // the aliases of the first element of a dot-notation key
    if (splitKey.length > 1) {
      for (const x of flagAliases.get(splitKey[0] ?? '') ?? []) {
        const keyProperties = x.split('.').concat(splitKey.slice(1))
        if (!(flagAliases.get(key) ?? []).includes(keyProperties.join('.'))) {
          setKey(argv, keyProperties, value)
        }
      }
    }
  }

  function pushPositional(arg: string): void {
    ;(argv._ as unknown[]).push(arg)
  }

  // `requiresArg` is an `narg` of `NaN`, which yargs-parser reads as "exactly one".
  function eatNargs(index: number, key: string, argAfterEqualSign?: string): number {
    let available = argAfterEqualSign === undefined ? 0 : 1
    // nargs does not consume flag arguments (`-abc`, `--foo`) and stops at one.
    for (let ii = index + 1; ii < args.length; ii++) {
      const candidate = args[ii] ?? ''
      if (!/^-[^0-9]/.test(candidate) || NEGATIVE.test(candidate)) available++
      else break
    }
    if (available < 1) error = new Error(`Not enough arguments following: ${key}`)
    let consumed = Math.min(available, 1)
    if (argAfterEqualSign !== undefined && consumed > 0) {
      setArg(key, argAfterEqualSign)
      consumed--
    }
    for (let ii = index + 1; ii < consumed + index + 1; ii++) setArg(key, args[ii])
    return index + consumed
  }

  // an array option eats every argument up to the next flag
  function eatArray(start: number, key: string, argAfterEqualSign?: string): number {
    let index = start
    const argsToSet: unknown[] = []
    let next: string | undefined = argAfterEqualSign || args[index + 1]
    const nargsCount = checkAllAliases(key, nargs)
    if (
      next === undefined ||
      (argAfterEqualSign === undefined && /^-/.test(next) && !NEGATIVE.test(next))
    ) {
      // no value: argsToSet stays empty
    } else {
      // a value in --option=value is eaten as is
      if (argAfterEqualSign !== undefined) {
        argsToSet.push(processValue(key, argAfterEqualSign, true))
      }
      for (let ii = index + 1; ii < args.length; ii++) {
        if (typeof nargsCount === 'number' && nargsCount && argsToSet.length >= nargsCount) break
        next = args[ii] ?? ''
        if (/^-/.test(next) && !NEGATIVE.test(next)) break
        index = ii
        argsToSet.push(processValue(key, next, false))
      }
    }
    if (
      typeof nargsCount === 'number' &&
      ((nargsCount && argsToSet.length < nargsCount) ||
        (Number.isNaN(nargsCount) && argsToSet.length === 0))
    ) {
      error = new Error(`Not enough arguments following: ${key}`)
    }
    setArg(key, argsToSet)
    return index
  }

  function takesValue(key: string, index: number, afterEqual?: string): number | undefined {
    if (checkAllAliases(key, arrays)) return eatArray(index, key, afterEqual)
    if (checkAllAliases(key, nargs) !== false) return eatNargs(index, key, afterEqual)
    return undefined
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    const truncatedArg = arg.replace(/^-{3,}/, '---')
    let m: RegExpMatchArray | null
    if (/^---+(=|$)/.test(truncatedArg)) {
      // options without a key name are invalid, so they are positionals
      pushPositional(arg)
    } else if (/^--.+=/.test(arg)) {
      // --key=value
      m = arg.match(/^--?([^=]+)=([\s\S]*)$/)
      if (m !== null) {
        const key = m[1] ?? ''
        const value = m[2] ?? ''
        const taken = takesValue(key, i, value)
        if (taken !== undefined) i = taken
        else setArg(key, value, true)
      }
    } else if (NEGATED_BOOLEAN.test(arg)) {
      m = arg.match(NEGATED_BOOLEAN)
      if (m !== null) {
        const key = m[1] ?? ''
        setArg(key, checkAllAliases(key, arrays) ? [false] : false)
      }
    } else if (/^--.+/.test(arg)) {
      // --key value
      m = arg.match(/^--?(.+)/)
      if (m !== null) {
        const key = m[1] ?? ''
        const taken = takesValue(key, i)
        if (taken !== undefined) {
          i = taken
        } else {
          const next = args[i + 1]
          if (
            next !== undefined &&
            (!/^-/.test(next) || NEGATIVE.test(next)) &&
            !checkAllAliases(key, bools)
          ) {
            setArg(key, next)
            i++
          } else if (/^(true|false)$/.test(next ?? '')) {
            setArg(key, next)
            i++
          } else {
            setArg(key, defaultValue(key))
          }
        }
      }
    } else if (/^-.\..+=/.test(arg)) {
      // dot-notation flag separated by '='
      m = arg.match(/^-([^=]+)=([\s\S]*)$/)
      if (m !== null) setArg(m[1] ?? '', m[2])
    } else if (/^-.\..+/.test(arg) && !NEGATIVE.test(arg)) {
      // dot-notation flag separated by space
      const next = args[i + 1]
      m = arg.match(/^-(.\..+)/)
      if (m !== null) {
        const key = m[1] ?? ''
        if (next !== undefined && !/^-/.test(next) && !checkAllAliases(key, bools)) {
          setArg(key, next)
          i++
        } else {
          setArg(key, defaultValue(key))
        }
      }
    } else if (/^-[^-]+/.test(arg) && !NEGATIVE.test(arg)) {
      // a group of short flags
      const letters = arg.slice(1, -1).split('')
      let broken = false
      for (let j = 0; j < letters.length; j++) {
        const next = arg.slice(j + 2)
        const letter = letters[j] ?? ''
        const following = letters[j + 1]
        if (following && following === '=') {
          const value = arg.slice(j + 3)
          const taken = takesValue(letter, i, value)
          if (taken !== undefined) i = taken
          else setArg(letter, value)
          broken = true
          break
        }
        if (next === '-') {
          setArg(letter, next)
          continue
        }
        // a letter followed by a number is the letter's value
        if (
          /[A-Za-z]/.test(letter) &&
          /^-?\d+(\.\d*)?(e-?\d+)?$/.test(next) &&
          checkAllAliases(next, bools) === false
        ) {
          setArg(letter, next)
          broken = true
          break
        }
        if (following && /\W/.test(following)) {
          setArg(letter, next)
          broken = true
          break
        }
        setArg(letter, defaultValue(letter))
      }
      const key = arg.slice(-1)
      if (!broken && key !== '-') {
        const taken = takesValue(key, i)
        if (taken !== undefined) {
          i = taken
        } else {
          const next = args[i + 1]
          if (
            next !== undefined &&
            (!/^(-|--)[^-]/.test(next) || NEGATIVE.test(next)) &&
            !checkAllAliases(key, bools)
          ) {
            setArg(key, next)
            i++
          } else if (/^(true|false)$/.test(next ?? '')) {
            setArg(key, next)
            i++
          } else {
            setArg(key, defaultValue(key))
          }
        }
      }
    } else if (/^-[0-9]$/.test(arg) && NEGATIVE.test(arg) && checkAllAliases(arg.slice(1), bools)) {
      // a single-digit boolean alias, as in `xargs -0`
      const key = arg.slice(1)
      setArg(key, defaultValue(key))
    } else if (arg === '--') {
      notFlags = args.slice(i + 1)
      break
    } else {
      pushPositional(arg)
    }
  }

  // `populate--`: what follows `--` is kept apart (yargs appends it to `_` afterwards).
  if (notFlags.length > 0) argv['--'] = [...notFlags]

  return { argv: Object.assign({}, argv), error }
}
