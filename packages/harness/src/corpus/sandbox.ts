// The network-off sandbox third-party code runs in (DECISIONS D40). A reference run executes a
// repository's own tests, so it runs under a macOS Seatbelt profile this module generates, from
// Tyler's own terminal only: Claude Code's sandbox cannot nest `sandbox-exec` (exit 71), and an
// agent cannot check that the network is off. Everything here that can be decided without a
// sandbox is a pure function with tests; `runProbe` is what proves, on the real machine, that the
// profile holds, and `corpus run` repeats it before every repository and refuses to start if any
// attempt got out (fail closed).
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HarnessError } from '../errors.ts'
import { isRecord } from '../internal/guards.ts'
import { type CorpusDeps, defaultDeps } from './deps.ts'

/** The system's `sandbox-exec`. */
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'

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
 * - **Network:** everything denied except loopback and unix sockets; the DNS mach services denied
 *   too, so a name cannot be resolved by the system resolver either.
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
    ';; network: loopback and unix sockets only',
    '(deny network*)',
    '(allow network* (remote ip "localhost:*"))',
    '(allow network* (local ip "localhost:*"))',
    '(allow network* (remote unix-socket))',
    '(allow network* (local unix-socket))',
    ';; DNS goes through mach services, which a network rule does not cover',
    ...DNS_SERVICES.map((name) => `(deny mach-lookup (global-name ${serviceName(name)}))`),
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

/** A mach service name literal (no slashes: not a path). */
function serviceName(name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`bad service name ${name}`)
  return `"${name}"`
}

/**
 * The environment a sandboxed run starts from: an allowlist (B16 gap 2). Nothing is inherited, so
 * there are no tokens, no proxy variables and no `NODE_OPTIONS`. `HOME` and `TMPDIR` are inside the
 * run directory. The subject's own `env` comes last, so it can set what a repository's script sets.
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
  const nodeDir = options.nodeDir ?? path.dirname(process.execPath)
  const systemPath = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']
  return {
    PATH: [...(options.pathPrefix ?? []), nodeDir, ...systemPath].join(':'),
    HOME: path.join(options.runDir, 'home'),
    TMPDIR: path.join(options.runDir, 'tmp'),
    CI: '1',
    TZ: 'UTC',
    LANG: 'en_US.UTF-8',
    FORCE_COLOR: '0',
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

/** The real paths a run's profile may write to: `mkdir -p` first, then `realpath` (Seatbelt matches real paths). */
export async function realWritable(dirs: readonly string[]): Promise<string[]> {
  const real: string[] = []
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true })
    real.push(await realpath(dir))
  }
  return real
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
  const [writable] = await realWritable([options.runDir])
  if (writable === undefined) throw new Error('unreachable')
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
 * The attempts a probe makes: four that must fail inside the profile, and loopback, which must
 * work.
 * @public
 */
export type ProbeName = 'tcp' | 'dns' | 'https' | 'canary' | 'ssh' | 'loopback'

/** The attempts that must fail, in the order the report prints them. */
export const BLOCKED_ATTEMPTS: readonly ProbeName[] = ['tcp', 'dns', 'https', 'canary', 'ssh']

const NETWORK_ATTEMPTS: ReadonlySet<ProbeName> = new Set(['tcp', 'dns', 'https'])
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
  const names: readonly string[] = [...BLOCKED_ATTEMPTS, 'loopback']
  const attempts: ProbeAttempt[] = []
  for (const line of output.split('\n')) {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(value) || typeof value.name !== 'string' || !names.includes(value.name)) continue
    const name = BLOCKED_ATTEMPTS.find((candidate) => candidate === value.name) ?? 'loopback'
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
}

/**
 * The probe's script: this repository's `probe-child.ts`, which runs under the profile.
 * @internal
 */
export function probeChildPath(): string {
  return fileURLToPath(new URL('./probe-child.ts', import.meta.url))
}

/**
 * Runs the probe (T12.10's sandbox check): the child makes the attempts once inside the profile
 * and once outside it as a control, and `evaluateProbe` judges both. Throws
 * `HARNESS_CORPUS_SANDBOX_LEAK` when the verdict is not ok, so `corpus run` can never start on a
 * profile that leaks. On a platform without Seatbelt it throws `HARNESS_CORPUS_NO_SANDBOX`.
 * @public
 */
export async function runProbe(options: ProbeOptions): Promise<ProbeVerdict> {
  assertSandboxPlatform()
  const deps = options.deps ?? defaultDeps
  const probeDir = path.join(options.workRoot, '_probe')
  await mkdir(probeDir, { recursive: true })
  const canary = path.join(await canaryDir(options.workRoot), CANARY_FILE)
  const home = options.home ?? os.userInfo().homedir
  const profile = await writeProfile({ runDir: probeDir, workRoot: options.workRoot, home })
  const env = sandboxEnv({ runDir: probeDir })
  await mkdir(env.HOME ?? probeDir, { recursive: true })
  await mkdir(env.TMPDIR ?? probeDir, { recursive: true })
  const childArgs = [
    '--conditions=provino-source',
    probeChildPath(),
    '--canary',
    canary,
    '--ssh',
    path.join(home, '.ssh', 'provino-probe-canary'),
  ]
  const run = async (wrapped: boolean) => {
    const target = wrapped
      ? sandboxed(profile, process.execPath, childArgs)
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
      `the probe printed nothing inside the profile (exit ${inside.result.exitCode ?? inside.result.signal}), so the sandbox cannot be trusted: ${inside.result.output.trim().slice(-400)}`,
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
}
