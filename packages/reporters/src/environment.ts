// What the reporters read from the outside: is the output a terminal, is this CI, is an AI coding
// agent running the process, may the output be coloured. A pure function of an environment and a
// stream, so a test passes both and no reporter reads `process` itself.

/**
 * The variables that say an AI coding agent runs this process, with the agent each names: std-env
 * 4.3's `detectAgent` (the list Jest 30.5 and Vitest 5.0 read), minus the three it tests by a
 * pattern on `PATH`, `EDITOR` and `TERM_PROGRAM` (`AGENT_PATTERNS`). `AI_AGENT` comes first and
 * its value is the agent's name. A variable counts when it is set to something that is not empty,
 * `0` or `false`.
 * @public
 */
export const AGENT_VARIABLES: readonly (readonly [agent: string, variable: string])[] = [
  ['claude', 'CLAUDECODE'],
  ['claude', 'CLAUDE_CODE'],
  ['replit', 'REPL_ID'],
  ['gemini', 'GEMINI_CLI'],
  ['codex', 'CODEX_SANDBOX'],
  ['codex', 'CODEX_THREAD_ID'],
  ['opencode', 'OPENCODE'],
  ['auggie', 'AUGMENT_AGENT'],
  ['goose', 'GOOSE_PROVIDER'],
  ['junie', 'JUNIE_DATA'],
  ['junie', 'JUNIE_SHIM_PATH'],
  ['copilot', 'COPILOT_AGENT'],
  ['copilot', 'COPILOT_CLI'],
  ['cursor', 'CURSOR_AGENT'],
]

/** Agents that std-env finds by a pattern on one variable (`noTty`: only without a terminal). */
const AGENT_PATTERNS: readonly {
  readonly agent: string
  readonly variable: string
  readonly pattern: RegExp
  readonly noTty?: true
}[] = [
  { agent: 'pi', variable: 'PATH', pattern: /\.pi[\\/]agent/ },
  { agent: 'devin', variable: 'EDITOR', pattern: /devin/ },
  { agent: 'kiro', variable: 'TERM_PROGRAM', pattern: /kiro/, noTty: true },
]

/**
 * The environment variables, as `process.env` has them.
 * @public
 */
export type Environment = Readonly<Record<string, string | undefined>>

/**
 * The stream the output goes to: what a `tty.WriteStream` says about itself, and nothing else the
 * reporters need.
 * @public
 */
export interface OutputStream {
  readonly isTTY?: boolean | undefined
  readonly columns?: number | undefined
}

/**
 * What `detectOutput` reads.
 * @public
 */
export interface DetectOptions {
  /** The environment variables. Default: `process.env`. */
  readonly env?: Environment
  /** The stream the reporters write to. Default: none, so not a terminal. */
  readonly stream?: OutputStream
  /**
   * Whether this is a CI run, when the caller has already decided (`--ci`, the run's own answer).
   * Default: the `CI` variable is set to something other than empty, `0` or `false`, ignoring
   * case and surrounding spaces.
   */
  readonly ci?: boolean
  /** Colour on or off whatever the environment says (Jest's `--colors` and `--no-colors`). */
  readonly colour?: boolean
}

/**
 * How the output should look, from the environment.
 * @public
 */
export interface OutputEnvironment {
  /** The stream is a terminal. */
  readonly tty: boolean
  /** A CI run. */
  readonly ci: boolean
  /** The agent that runs this process, as std-env names it, or `undefined` when none does. */
  readonly agent: string | undefined
  /** GitHub Actions runs this process (`GITHUB_ACTIONS`). */
  readonly githubActions: boolean
  /**
   * ANSI colours: `FORCE_COLOR` (anything but `0` and `false`) turns them on and wins over
   * `NO_COLOR`; a `NO_COLOR` that is not empty turns them off; otherwise a terminal that is not
   * `TERM=dumb` and not an agent's has them (escape sequences are noise to what an agent reads).
   * CI alone does not: a CI log without a terminal stays plain unless `FORCE_COLOR` is set.
   */
  readonly colour: boolean
  /**
   * The output may be redrawn in place (a status block of the running files): a terminal that is
   * not `TERM=dumb`, in a run that is neither CI nor an agent's.
   */
  readonly live: boolean
  /** The stream's width, 80 when it doesn't say. */
  readonly columns: number
}

function isSet(value: string | undefined): value is string {
  if (value === undefined) return false
  const text = value.trim().toLowerCase()
  return text !== '' && text !== '0' && text !== 'false'
}

/** The agent that runs the process (std-env's name for it), or `undefined`. */
function agentOf(env: Environment, tty: boolean): string | undefined {
  const named = env.AI_AGENT
  if (isSet(named)) {
    const name = named.trim().toLowerCase()
    return name === 'github_copilot_vscode_agent' || name === 'github_copilot_cloud_agent'
      ? 'copilot'
      : name
  }
  for (const [agent, variable] of AGENT_VARIABLES) if (isSet(env[variable])) return agent
  for (const { agent, variable, pattern, noTty } of AGENT_PATTERNS) {
    if (noTty === true && tty) continue
    const value = env[variable]
    if (value !== undefined && pattern.test(value)) return agent
  }
  return undefined
}

/**
 * `FORCE_COLOR` over `NO_COLOR` over the terminal, as Node's own `getColorDepth` orders them; a
 * terminal an agent runs in has none unless `FORCE_COLOR` asks.
 */
function colourOf(env: Environment, tty: boolean, agent: string | undefined): boolean {
  const forced = env.FORCE_COLOR?.trim().toLowerCase()
  if (forced !== undefined) return forced !== '0' && forced !== 'false'
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false
  return tty && env.TERM !== 'dumb' && agent === undefined
}

/**
 * Reads how the output should look. Pure: it takes the environment and the stream, so callers
 * (and tests) decide what they are.
 * @public
 */
export function detectOutput(options: DetectOptions = {}): OutputEnvironment {
  const env = options.env ?? process.env
  const tty = options.stream?.isTTY === true
  const ci = options.ci ?? isSet(env.CI)
  const agent = agentOf(env, tty)
  const colour = options.colour ?? colourOf(env, tty, agent)
  const dumb = env.TERM === 'dumb'
  return {
    tty,
    ci,
    agent,
    githubActions: isSet(env.GITHUB_ACTIONS),
    colour,
    live: tty && !dumb && !ci && agent === undefined,
    columns: options.stream?.columns ?? 80,
  }
}
