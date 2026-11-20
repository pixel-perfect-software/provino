// T11.16: the command-line parser Vitest 5.0.5 bundles, rebuilt with no dependency (speed: B14c's
// precedent). Vitest bundles cac 6.7 with its own patches (`vitest/dist/chunks/cac.*.js`: the
// `type` of every option is applied as each dotted key is set, in `setDotProp`, and
// `checkOptionValue` skips dotted names) over mri 1.2.0, so this follows that bundle branch for
// branch: mri's `toVal` and main loop, cac's `Option` names, `getMriOptions`, `CAC.parse` (every
// command's options are parsed, the last match wins), `CAC.mri`, `setDotProp`, and the three checks
// `runMatchedCommand` makes before an action (`checkUnknownOptions`, `checkOptionValue`,
// `checkRequiredArgs`). Help and version output are not rebuilt. `cli.test.ts` holds it to the real
// `parseCLI` and those checks.

/** A parsed value bag. */
export type CacBag = Record<string, unknown>

/** One cac option (`Option`'s constructor). */
export interface CacOption {
  readonly rawName: string
  /** Its names, camel-cased and shortest first (`['t', 'testNamePattern']`). */
  readonly names: readonly string[]
  /** The longest name: the key its `type` is filed under. */
  readonly name: string
  readonly isBoolean: boolean
  /** `true` for `<value>`, `false` for `[value]`, `undefined` for a boolean. */
  readonly required: boolean | undefined
  readonly negated: boolean
  readonly default: unknown
  readonly type: ((value: unknown) => unknown) | undefined
}

/** One cac command. */
export interface CacCommand {
  readonly rawName: string
  readonly name: string
  readonly args: readonly {
    readonly required: boolean
    readonly value: string
    readonly variadic: boolean
  }[]
  readonly options: readonly CacOption[]
}

/** cac's `CACError`: the message is what Vitest prints. */
export class CacError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CACError'
  }
}

const removeBrackets = (v: string): string => v.replace(/[<[].+/, '').trim()

function findAllBrackets(v: string): CacCommand['args'] {
  const res: { required: boolean; value: string; variadic: boolean }[] = []
  const parse = (
    match: RegExpExecArray,
  ): { required: boolean; value: string; variadic: boolean } => {
    let variadic = false
    let value = match[1] ?? ''
    if (value.startsWith('...')) {
      value = value.slice(3)
      variadic = true
    }
    return { required: match[0].startsWith('<'), value, variadic }
  }
  for (const match of v.matchAll(/<([^>]+)>/g)) res.push(parse(match))
  for (const match of v.matchAll(/\[([^\]]+)\]/g)) res.push(parse(match))
  return res
}

const camelcase = (input: string): string =>
  input.replace(/([a-z])-([a-z])/g, (_, p1: string, p2: string) => p1 + p2.toUpperCase())

/** cac's `camelcaseOptionName`: only the part before the first dot is camel-cased. */
export const camelcaseOptionName = (name: string): string =>
  name
    .split('.')
    .map((v, i) => (i === 0 ? camelcase(v) : v))
    .join('.')

/** cac's `Option` constructor. */
export function cacOption(rawName: string, type?: (value: unknown) => unknown): CacOption {
  const raw = rawName.replace(/\.\*/g, '')
  let negated = false
  const names = removeBrackets(raw)
    .split(',')
    .map((v) => {
      let name = v.trim().replace(/^-{1,2}/, '')
      if (name.startsWith('no-')) {
        negated = true
        name = name.replace(/^no-/, '')
      }
      return camelcaseOptionName(name)
    })
    // The bundle's comparator (`a.length > b.length ? 1 : -1`), kept as it is.
    .sort((a, b) => (a.length > b.length ? 1 : -1))
  const required = raw.includes('<') ? true : raw.includes('[') ? false : undefined
  return {
    rawName,
    names,
    name: names[names.length - 1] ?? '',
    isBoolean: required === undefined,
    required,
    negated,
    default: negated ? true : undefined,
    type,
  }
}

/** cac's `Command` constructor. */
export function cacCommand(rawName: string, options: readonly CacOption[]): CacCommand {
  return { rawName, name: removeBrackets(rawName), args: findAllBrackets(rawName), options }
}

// --- mri 1.2.0 ---------------------------------------------------------------------------------

interface MriOptions {
  readonly alias: Record<string, string[]>
  readonly boolean: string[]
}

const isNumberLike = (value: unknown): boolean => {
  const x = Number(value)
  return x * 0 === 0
}

/** mri's `toVal` (`opts.string` is always empty here). */
function toVal(out: CacBag, key: string, val: unknown, opts: MriOptions): void {
  const old = out[key]
  let nxt: unknown
  if (typeof val === 'boolean') nxt = val
  else if (opts.boolean.includes(key)) {
    if (val === 'false') nxt = false
    else if (val === 'true') nxt = true
    else {
      ;(out._ as unknown[]).push(isNumberLike(val) ? Number(val) : val)
      nxt = !!val
    }
  } else nxt = isNumberLike(val) ? Number(val) : val
  out[key] = old == null ? nxt : Array.isArray(old) ? old.concat(nxt) : [old, nxt]
}

/** mri's main function, with an `alias` map and no `string`, `default` or `unknown`. */
function mri(args: readonly string[], options: MriOptions): CacBag {
  const out: CacBag = { _: [] }
  const alias: Record<string, string[]> = { ...options.alias }
  const booleans = [...options.boolean]
  for (const k in alias) {
    const arr = alias[k] ?? []
    for (let i = 0; i < arr.length; i++) {
      const name = arr[i] ?? ''
      const others = arr.concat(k)
      others.splice(i, 1)
      alias[name] = others
    }
  }
  for (let i = booleans.length; i-- > 0; ) {
    const arr = alias[booleans[i] ?? ''] ?? []
    for (let j = arr.length; j-- > 0; ) booleans.push(arr[j] ?? '')
  }
  const opts: MriOptions = { alias, boolean: booleans }
  const len = args.length
  for (let i = 0; i < len; i++) {
    const arg = args[i] ?? ''
    if (arg === '--') {
      out._ = (out._ as unknown[]).concat(args.slice(++i))
      break
    }
    let j = 0
    for (; j < arg.length; j++) if (arg.charCodeAt(j) !== 45) break
    if (j === 0) (out._ as unknown[]).push(arg)
    else if (arg.substring(j, j + 3) === 'no-') out[arg.substring(j + 3)] = false
    else {
      let idx = j + 1
      for (; idx < arg.length; idx++) if (arg.charCodeAt(idx) === 61) break
      const name = arg.substring(j, idx)
      const val: unknown =
        arg.substring(++idx) || i + 1 === len || `${args[i + 1]}`.charCodeAt(0) === 45 || args[++i]
      const names = j === 2 ? [name] : name.split('')
      for (let n = 0; n < names.length; n++)
        toVal(out, names[n] ?? '', n + 1 < names.length || val, opts)
    }
  }
  // mri empties each alias list as it copies (`arr.shift()`), and keys added to `out` here are not
  // visited by the loop: both kept.
  for (const k in out) {
    const arr = alias[k] ?? []
    while (arr.length > 0) out[arr.shift() ?? ''] = out[k]
  }
  return out
}

// --- cac -----------------------------------------------------------------------------------------

/** cac's `getMriOptions`. */
function mriOptionsOf(options: readonly CacOption[]): MriOptions {
  const alias: Record<string, string[]> = {}
  const boolean: string[] = []
  options.forEach((option, index) => {
    if (option.names.length > 1) alias[option.names[0] ?? ''] = option.names.slice(1)
    if (!option.isBoolean) return
    if (option.negated) {
      const hasStringTypeOption = options.some(
        (o, i) =>
          i !== index &&
          o.names.some((name) => option.names.includes(name)) &&
          typeof o.required === 'boolean',
      )
      if (!hasStringTypeOption) boolean.push(option.names[0] ?? '')
    } else boolean.push(option.names[0] ?? '')
  })
  return { alias, boolean }
}

/** The bundle's `setDotProp`: each level's value goes through the `type` filed under its dotted key. */
function setDotProp(
  obj: CacBag,
  keys: readonly string[],
  val: unknown,
  transforms: ReadonlyMap<string, (value: unknown) => unknown>,
): void {
  let t: Record<string, unknown> = obj
  for (let i = 0; i < keys.length; ++i) {
    const key = keys[i] ?? ''
    const x = t[key]
    const transform = transforms.get(keys.slice(0, i + 1).join('.')) ?? ((v: unknown) => v)
    const next = keys[i + 1] ?? ''
    const value = transform(
      i === keys.length - 1
        ? val
        : x != null
          ? x
          : next.includes('.') || !(Number(next) > -1)
            ? {}
            : [],
    )
    t[key] = value
    t = value as Record<string, unknown>
  }
}

/** cac's `CAC.mri` for one command. */
function cacMri(
  argv: readonly string[],
  globals: readonly CacOption[],
  command: CacCommand | undefined,
): { args: unknown[]; options: CacBag; given: (readonly [string, unknown])[] } {
  const cliOptions = [...globals, ...(command?.options ?? [])]
  const mriOptions = mriOptionsOf(cliOptions)
  let argsAfterDoubleDashes: string[] = []
  let rest = argv
  const doubleDashesIndex = argv.indexOf('--')
  if (doubleDashesIndex > -1) {
    argsAfterDoubleDashes = argv.slice(doubleDashesIndex + 1)
    rest = argv.slice(0, doubleDashesIndex)
  }
  const raw = mri(rest, mriOptions)
  const parsed: CacBag = { _: [] }
  for (const name of Object.keys(raw)) parsed[camelcaseOptionName(name)] = raw[name]
  const options: CacBag = { '--': argsAfterDoubleDashes }
  const transforms = new Map<string, (value: unknown) => unknown>()
  for (const option of cliOptions) {
    if (option.default !== undefined)
      for (const name of option.names) options[name] = option.default
    if (option.type !== undefined && !transforms.has(option.name))
      transforms.set(option.name, option.type)
  }
  const given: (readonly [string, unknown])[] = []
  for (const key of Object.keys(parsed)) {
    if (key === '_') continue
    given.push([key, parsed[key]])
    setDotProp(options, key.split('.'), parsed[key], transforms)
  }
  return { args: parsed._ as unknown[], options, given }
}

/** What `CAC.parse` gives, with the keys the command line set (before defaults). */
export interface CacParsed {
  readonly args: readonly unknown[]
  readonly options: CacBag
  /** The command that matched (by its first argument, else the default command). */
  readonly command: CacCommand | undefined
  readonly commandName: string | undefined
  /** The camel-cased keys mri read, with mri's value, in its order (before defaults and `type`s). */
  readonly given: readonly (readonly [string, unknown])[]
}

/** cac's `CAC.parse(argv, { run: false })` over `args` (the arguments after the program name). */
export function cacParse(
  args: readonly string[],
  globals: readonly CacOption[],
  commands: readonly CacCommand[],
): CacParsed {
  let result: CacParsed | undefined
  for (const command of commands) {
    const parsed = cacMri(args, globals, command)
    const commandName = parsed.args[0]
    if (typeof commandName === 'string' && command.name === commandName) {
      result = { ...parsed, args: parsed.args.slice(1), command, commandName }
    }
  }
  if (result === undefined) {
    for (const command of commands) {
      if (command.name === '')
        result = { ...cacMri(args, globals, command), command, commandName: undefined }
    }
  }
  return (
    result ?? { ...cacMri(args, globals, undefined), command: undefined, commandName: undefined }
  )
}

const hasOption = (options: readonly CacOption[], name: string): boolean => {
  const top = name.split('.')[0] ?? ''
  return options.some((option) => option.names.includes(top))
}

/** `runMatchedCommand`'s checks, in its order: unknown options, option values, required arguments. */
export function cacCheck(parsed: CacParsed, globals: readonly CacOption[]): void {
  const command = parsed.command
  if (command === undefined) return
  for (const name of Object.keys(parsed.options)) {
    if (name !== '--' && !hasOption(command.options, name) && !hasOption(globals, name)) {
      throw new CacError(`Unknown option \`${name.length > 1 ? `--${name}` : `-${name}`}\``)
    }
  }
  const options = [...globals, ...command.options]
  for (const option of options) {
    if (option.name.includes('.')) continue
    const value = parsed.options[option.name]
    if (option.required) {
      const hasNegated = options.some((o) => o.negated && o.names.includes(option.name))
      if (value === true || (value === false && !hasNegated)) {
        throw new CacError(`option \`${option.rawName}\` value is missing`)
      }
    }
  }
  const minimalArgsCount = command.args.filter((arg) => arg.required).length
  if (parsed.args.length < minimalArgsCount) {
    throw new CacError(`missing required args for command \`${command.rawName}\``)
  }
}
