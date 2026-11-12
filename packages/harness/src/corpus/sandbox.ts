// The network-off sandbox third-party code runs in (DECISIONS D40). A reference run executes a
// repository's own tests, so it runs under a macOS Seatbelt profile this module generates, from
// Tyler's own terminal only: Claude Code's sandbox cannot nest `sandbox-exec` (exit 71), and an
// agent cannot check that the network is off. Everything here that can be decided without a
// sandbox is a pure function with tests; `runProbe` is what proves, on the real machine, that the
// profile holds, and `corpus run` repeats it before every repository and refuses to start if any
// attempt got out (fail closed).
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HarnessError } from '../errors.ts'
import { isRecord } from '../internal/guards.ts'
import type { CommandWrap } from '../run-process.ts'
import { type CorpusDeps, defaultDeps, exitText, tailOf } from './deps.ts'
import { homeDir, tmpDir } from './paths.ts'

/** The system's `sandbox-exec`. */
const SANDBOX_EXEC = '/usr/bin/sandbox-exec'

/**
 * Paths under the real home directory the profile denies reading (B16 gap 2). The run's own `HOME`
 * is inside the run directory, so none of these is a place a test legitimately reads.
 */
export const DENIED_HOME_PATHS: readonly string[] = [
  '.ssh',
  '.aws',
  '.config',
  '.npmrc',
  '.netrc',
  '.gnupg',
  '.docker',
  '.kube',
  '.azure',
  '.git-credentials',
  'Library/Keychains',
  'Library/Group Containers/2BUA8C4S2C.com.1password',
  'Library/Application Support/1Password',
]

/** The mach services DNS goes through: with them denied, a lookup cannot reach the resolver. */
const DNS_SERVICES: readonly string[] = [
  'com.apple.dnssd.service',
  'com.apple.SystemConfiguration.DNSConfiguration',
  'com.apple.SystemConfiguration.configd',
  'com.apple.networkd',
  'com.apple.nsurlsessiond',
]

/**
 * What a profile is generated from.
 * @public
 */
export interface SandboxPolicy {
  /** The real home directory: where the denied credential paths are. */
  readonly home: string
  /** Directories the run may write to, as real paths: the run directory and nothing else. */
  readonly writable: readonly string[]
  /** More paths to deny reading (the probe's canary). */
  readonly deniedReads?: readonly string[]
}

/** An SBPL string literal; a path with a quote, backslash or control character is refused. */
function sbplString(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: a control character in a path is the thing refused
  if (!path.isAbsolute(value) || /["\\\u0000-\u001f]/.test(value)) {
    throw new HarnessError(
      'HARNESS_CORPUS_NO_SANDBOX',
      `a sandbox path must be absolute and free of quotes, backslashes and control characters: ${JSON.stringify(value)}`,
    )
  }
  return `"${value}"`
}

/**
 * The Seatbelt profile (SBPL) for one run, as text:
 *
 * - **Network:** everything denied except loopback and unix-domain sockets under the run's own
 *   directories (`writable`); the DNS mach services denied too, so a name cannot be resolved by
 *   the system resolver either.
 * - **Reads:** everything allowed except the credential paths under the real home and any extra
 *   `deniedReads`.
 * - **Writes:** everything denied except the run's directories, `/dev/null` and the terminal
 *   devices.
 *
 * Rules later in a profile win, so each deny comes before the allows that carve out its holes.
 * @public
 */
export function seatbeltProfile(policy: SandboxPolicy): string {
  const home = path.resolve(policy.home)
  const denied = [
    ...DENIED_HOME_PATHS.map((relative) => path.join(home, relative)),
    ...(policy.deniedReads ?? []),
  ]
  const lines = [
    '(version 1)',
    '(allow default)',
    ';; network: loopback, and unix sockets under the run directory',
    '(deny network*)',
    '(allow network* (remote ip "localhost:*"))',
    '(allow network* (local ip "localhost:*"))',
    ...policy.writable.flatMap((entry) => [
      `(allow network* (remote unix-socket (subpath ${sbplString(entry)})))`,
      `(allow network* (local unix-socket (subpath ${sbplString(entry)})))`,
    ]),
    ';; DNS goes through mach services, which a network rule does not cover',
    ...DNS_SERVICES.map((name) => `(deny mach-lookup (global-name "${name}"))`),
    ';; credentials',
    ...denied.map((entry) => `(deny file-read* (subpath ${sbplString(entry)}))`),
    ';; writes: the run directory only',
    '(deny file-write*)',
    ...policy.writable.map((entry) => `(allow file-write* (subpath ${sbplString(entry)}))`),
    '(allow file-write* (literal "/dev/null") (literal "/dev/dtracehelper") (literal "/dev/tty"))',
    '(allow file-write* (regex #"^/dev/(fd/[0-9]+|stdout|stderr|ttys[0-9]+)$"))',
  ]
  return `${lines.join('\n')}\n`
}

/**
 * The allowlisted environment every corpus child starts from, for an install and for a run
 * (B16 gap 2): nothing is inherited, so there are no tokens, no proxy variables and no
 * `NODE_OPTIONS`. `pathPrefix` comes first on `PATH`, then the node binary's directory (so `node`
 * is the one running the harness) and the system's.
 * @public
 */
export function baseEnv(options: {
  readonly home: string
  readonly tmp: string
  readonly nodeDir?: string | undefined
  readonly pathPrefix?: readonly string[] | undefined
}): NodeJS.ProcessEnv {
  const nodeDir = options.nodeDir ?? path.dirname(process.execPath)
  return {
    PATH: [...(options.pathPrefix ?? []), nodeDir, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(
      ':',
    ),
    HOME: options.home,
    TMPDIR: options.tmp,
    CI: '1',
    TZ: 'UTC',
    LANG: 'en_US.UTF-8',
    FORCE_COLOR: '0',
  }
}

/**
 * The environment a sandboxed run starts from: `baseEnv` with `HOME` and `TMPDIR` inside the run
 * directory. The subject's own `env` comes last, so it can set what a repository's script sets.
 * @public
 */
export function sandboxEnv(options: {
  /** The run directory: `HOME` is `<runDir>/home`, `TMPDIR` is `<runDir>/tmp`. */
  readonly runDir: string
  /** The directories to put on `PATH` first (`node_modules/.bin` of the clone). */
  readonly pathPrefix?: readonly string[]
  readonly extra?: Readonly<Record<string, string>>
  /** The node binary's directory, so `node` resolves to the one running the harness. */
  readonly nodeDir?: string
}): NodeJS.ProcessEnv {
  return {
    ...baseEnv({
      home: homeDir(options.runDir),
      tmp: tmpDir(options.runDir),
      nodeDir: options.nodeDir,
      pathPrefix: options.pathPrefix,
    }),
    ...options.extra,
  }
}

/**
 * The command that runs `command args` under the profile at `profileFile`.
 * @public
 */
export function sandboxed(
  profileFile: string,
  command: string,
  args: readonly string[],
): { readonly command: string; readonly args: readonly string[] } {
  return { command: SANDBOX_EXEC, args: ['-f', profileFile, command, ...args] }
}

/**
 * The wrap that runs every command under the profile at `profileFile`.
 * @public
 */
export function sandboxWrap(profileFile: string): CommandWrap {
  return (command, args) => sandboxed(profileFile, command, args)
}

/**
 * Refuses a platform that has no sandbox yet: only macOS (Seatbelt) is implemented. A Linux
 * container comes with B18's pinned machine.
 * @public
 */
export function assertSandboxPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'darwin') {
    throw new HarnessError(
      'HARNESS_CORPUS_NO_SANDBOX',
      `the corpus runs third-party tests only under macOS Seatbelt (this is ${platform}); a Linux container arrives with B18`,
    )
  }
}

/**
 * Writes a run's profile into its directory and returns the file. The run directory is writable;
 * the real home's credential paths and the work directory's canary are not readable.
 * @public
 */
export async function writeProfile(options: {
  readonly runDir: string
  readonly workRoot: string
  readonly home?: string
}): Promise<string> {
  // Seatbelt matches real paths, so the run directory is made and resolved first.
  const writable = await realpathOf(options.runDir)
  const profile = seatbeltProfile({
    home: options.home ?? os.userInfo().homedir,
    writable: [writable],
    deniedReads: [await canaryDir(options.workRoot)],
  })
  const file = path.join(options.runDir, 'sandbox.sb')
  await writeFile(file, profile)
  return file
}

const CANARY_FILE = 'secret.txt'
const CANARY_TEXT = 'provino-corpus-canary: a sandboxed run reading this is a leak\n'

/** The directory the profile denies reading, with a canary file in it. */
async function canaryDir(workRoot: string): Promise<string> {
  const dir = path.join(await realpathOf(workRoot), '_canary')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, CANARY_FILE), CANARY_TEXT)
  return dir
}

async function realpathOf(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  return realpath(dir)
}

/**
 * One thing the probe tried, and what happened.
 * @public
 */
export interface ProbeAttempt {
  readonly name: ProbeName
  /** `ok`: it worked. `error`: it failed, with the system error code (`EPERM`, `ENOTFOUND`…). */
  readonly outcome: 'ok' | 'error' | 'timeout'
  readonly code?: string
}

/**
 * The attempts a probe makes: those that must fail inside the profile, and loopback, which must
 * work. `socket` connects to a unix socket outside the run's directories.
 * @public
 */
export type ProbeName = 'tcp' | 'dns' | 'https' | 'socket' | 'canary' | 'ssh' | 'loopback'

/** The attempts that must fail, in the order the report prints them. */
export const BLOCKED_ATTEMPTS: readonly ProbeName[] = [
  'tcp',
  'dns',
  'https',
  'socket',
  'canary',
  'ssh',
]

const PROBE_NAMES: readonly ProbeName[] = [...BLOCKED_ATTEMPTS, 'loopback']

const NETWORK_ATTEMPTS: ReadonlySet<ProbeName> = new Set(['tcp', 'dns', 'https', 'socket'])
const DENIAL_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES'])

/**
 * What the probe decided.
 * @public
 */
export interface ProbeVerdict {
  readonly ok: boolean
  /** One line per attempt, ready to print. */
  readonly lines: readonly string[]
  /** What went wrong, empty when `ok`. */
  readonly problems: readonly string[]
}

/**
 * Judges a probe, failing closed. Inside the profile every blocked attempt must have failed, and
 * the failure must be attributable to the sandbox: a denial code (`EPERM`, `EACCES`), or the same
 * attempt succeeding outside the profile (`control`), which shows the network is up and only the
 * profile stands in the way. A missing attempt, a timeout, an unexpected success, or a loopback
 * attempt that failed is a problem. Nothing is assumed: an attempt the results do not mention is
 * treated as having succeeded.
 * @public
 */
export function evaluateProbe(
  inside: readonly ProbeAttempt[],
  control?: readonly ProbeAttempt[],
): ProbeVerdict {
  const lines: string[] = []
  const problems: string[] = []
  const find = (list: readonly ProbeAttempt[] | undefined, name: ProbeName) =>
    list?.find((attempt) => attempt.name === name)
  for (const name of BLOCKED_ATTEMPTS) {
    const attempt = find(inside, name)
    if (attempt === undefined) {
      lines.push(`${name.padEnd(9)} MISSING`)
      problems.push(
        `${name}: the probe did not report this attempt, so it is treated as having succeeded`,
      )
      continue
    }
    if (attempt.outcome === 'ok') {
      lines.push(`${name.padEnd(9)} LEAK (it worked inside the profile)`)
      problems.push(`${name}: succeeded inside the profile`)
      continue
    }
    if (attempt.outcome === 'timeout') {
      lines.push(`${name.padEnd(9)} INCONCLUSIVE (timed out)`)
      problems.push(`${name}: timed out, which does not show the profile blocked it`)
      continue
    }
    const denied = attempt.code !== undefined && DENIAL_CODES.has(attempt.code)
    const controlWorked = find(control, name)?.outcome === 'ok'
    // A file read is attributable to the profile only by the denial code: ENOENT is "no such file".
    const attributable = NETWORK_ATTEMPTS.has(name) ? denied || controlWorked : denied
    if (!attributable) {
      lines.push(
        `${name.padEnd(9)} INCONCLUSIVE (${attempt.code ?? 'failed'}; not a denial, and it did not work outside the profile either)`,
      )
      problems.push(
        `${name}: failed with ${attempt.code ?? 'an error'}, which does not show the profile blocked it`,
      )
      continue
    }
    lines.push(`${name.padEnd(9)} blocked (${attempt.code ?? 'failed'})`)
  }
  const loopback = find(inside, 'loopback')
  if (loopback?.outcome !== 'ok') {
    lines.push(
      `${'loopback'.padEnd(9)} FAILED (${loopback?.code ?? loopback?.outcome ?? 'missing'})`,
    )
    problems.push('loopback: a test server on 127.0.0.1 could not be reached inside the profile')
  } else {
    lines.push(`${'loopback'.padEnd(9)} works`)
  }
  return { ok: problems.length === 0, lines, problems }
}

/**
 * Reads what `probe-child.ts` printed: one JSON object per line. Anything it cannot parse is
 * dropped, so the attempts it names are the ones the verdict sees.
 * @public
 */
export function parseProbeOutput(output: string): ProbeAttempt[] {
  const attempts: ProbeAttempt[] = []
  for (const line of output.split('\n')) {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(value)) continue
    const name = PROBE_NAMES.find((candidate) => candidate === value.name)
    if (name === undefined) continue
    const outcome = value.outcome
    if (outcome !== 'ok' && outcome !== 'error' && outcome !== 'timeout') continue
    attempts.push({
      name,
      outcome,
      ...(typeof value.code === 'string' ? { code: value.code } : {}),
    })
  }
  return attempts
}

/**
 * What `runProbe` is given.
 * @public
 */
export interface ProbeOptions {
  readonly workRoot: string
  readonly deps?: CorpusDeps
  /** The real home; the probe tries to read a file under its `.ssh`. Default: the user's. */
  readonly home?: string
  /** The platform to judge (tests only). Default: this one. */
  readonly platform?: NodeJS.Platform
  /** Where the child's `socket` attempt connects (tests only). Default: `listenOutsideRun`. */
  readonly listen?: () => Promise<OutsideSocket>
}

/** The probe's script: this repository's `probe-child.ts`, which runs under the profile. */
function probeChildPath(): string {
  return fileURLToPath(new URL('./probe-child.ts', import.meta.url))
}

/**
 * A listening unix socket, which the probe's `socket` attempt connects to.
 * @internal
 */
export interface OutsideSocket {
  readonly path: string
  readonly close: () => Promise<void>
}

/**
 * A listening unix socket in a fresh temporary directory, which is no run's directory. A short
 * path (a unix socket's name has a length limit).
 * @internal
 */
export async function listenOutsideRun(): Promise<OutsideSocket> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'provino-probe-'))
  const socketPath = path.join(dir, 's')
  const server = net.createServer((connection) => connection.end())
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
  } catch (cause) {
    await rm(dir, { recursive: true, force: true })
    throw cause
  }
  return {
    path: socketPath,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/**
 * Runs the probe (T12.10's sandbox check): the parent listens on a unix socket outside the run's
 * directories; the child makes the attempts once inside the profile
 * and once outside it as a control, and `evaluateProbe` judges both. Throws
 * `HARNESS_CORPUS_SANDBOX_LEAK` when the verdict is not ok, so `corpus run` can never start on a
 * profile that leaks. On a platform without Seatbelt it throws `HARNESS_CORPUS_NO_SANDBOX`.
 * @public
 */
export async function runProbe(options: ProbeOptions): Promise<ProbeVerdict> {
  assertSandboxPlatform(options.platform)
  const deps = options.deps ?? defaultDeps
  const probeDir = path.join(options.workRoot, '_probe')
  await mkdir(probeDir, { recursive: true })
  const canary = path.join(await canaryDir(options.workRoot), CANARY_FILE)
  const home = options.home ?? os.userInfo().homedir
  const profile = await writeProfile({ runDir: probeDir, workRoot: options.workRoot, home })
  const env = sandboxEnv({ runDir: probeDir })
  await mkdir(homeDir(probeDir), { recursive: true })
  await mkdir(tmpDir(probeDir), { recursive: true })
  const outsideSocket = await (options.listen ?? listenOutsideRun)()
  try {
    const childArgs = [
      '--conditions=provino-source',
      probeChildPath(),
      '--canary',
      canary,
      '--ssh',
      path.join(home, '.ssh', 'provino-probe-canary'),
      '--socket',
      outsideSocket.path,
    ]
    const run = async (wrapped: boolean) => {
      const target = wrapped
        ? sandboxWrap(profile)(process.execPath, childArgs)
        : { command: process.execPath, args: childArgs }
      const result = await deps.run(target.command, target.args, {
        cwd: probeDir,
        env: wrapped ? env : { PATH: env.PATH ?? '', HOME: env.HOME ?? probeDir },
        timeoutMs: 60_000,
        keepStreams: true,
      })
      return { result, attempts: parseProbeOutput(result.streams?.stdout ?? '') }
    }
    const inside = await run(true)
    if (inside.attempts.length === 0) {
      throw new HarnessError(
        'HARNESS_CORPUS_SANDBOX_LEAK',
        `the probe printed nothing inside the profile (${exitText(inside.result)}), so the sandbox cannot be trusted: ${tailOf(inside.result, 400)}`,
      )
    }
    const outside = await run(false)
    const verdict = evaluateProbe(inside.attempts, outside.attempts)
    if (!verdict.ok) {
      throw new HarnessError(
        'HARNESS_CORPUS_SANDBOX_LEAK',
        `the sandbox probe failed:\n${verdict.lines.map((line) => `  ${line}`).join('\n')}`,
      )
    }
    return verdict
  } finally {
    await outsideSocket.close()
  }
}
