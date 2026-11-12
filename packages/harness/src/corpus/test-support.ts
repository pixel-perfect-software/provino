// Fakes for the corpus tests: a repository entry, a `CorpusDeps` that answers by command name, and
// a tarball built with the real `tar`. Nothing here reaches the network or starts a runner.
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ProcessOptions, ProcessResult } from '../run-process.ts'
import type { CorpusDeps } from './deps.ts'
import type { CorpusRepo, CorpusSubject } from './manifest.ts'

/** A subject that runs Jest in the repository root. */
export function makeSubject(overrides: Partial<CorpusSubject> = {}): CorpusSubject {
  return {
    id: 'demo',
    cwd: '.',
    runner: 'jest',
    runnerVersion: '30.5.2',
    config: ['jest.config.js'],
    argv: ['--ci'],
    env: {},
    r6: false,
    ...overrides,
  }
}

/** A pinned repository entry. */
export function makeRepo(overrides: Partial<CorpusRepo> = {}): CorpusRepo {
  return {
    id: 'demo',
    repo: 'owner/demo',
    f5Sha: 'abcdef0',
    sha: `abcdef0${'1'.repeat(33)}`,
    commitDate: '2026-10-30T00:00:00Z',
    tarballSha256: '0'.repeat(64),
    licence: 'MIT',
    pilot: true,
    install: { name: 'npm', lockfile: 'package-lock.json' },
    testScript: 'jest',
    subjects: [makeSubject()],
    ...overrides,
  }
}

/** A finished process, as `runProcess` reports one. */
export function finished(
  exitCode: number | null,
  stdout = '',
  stderr = '',
  extra: Partial<ProcessResult> = {},
): ProcessResult {
  return {
    exitCode,
    signal: null,
    output: `${stdout}${stderr}`,
    timedOut: false,
    wallMs: 1,
    problems: [],
    streams: { stdout, stderr },
    ...extra,
  }
}

/** One command a fake saw. */
export interface Call {
  readonly command: string
  readonly args: readonly string[]
  readonly options: ProcessOptions
}

/**
 * A `CorpusDeps` that records every call and answers through `handler`; a handler that returns
 * `undefined` falls through to `fallback` (default: exit 0, no output).
 */
export function fakeDeps(
  handler: (call: Call) => ProcessResult | Promise<ProcessResult | undefined> | undefined,
  fallback?: CorpusDeps,
): CorpusDeps & { readonly calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    run: async (command, args, options) => {
      const call = { command, args, options }
      calls.push(call)
      const answer = await handler(call)
      if (answer !== undefined) return answer
      return fallback === undefined ? finished(0) : fallback.run(command, args, options)
    },
  }
}

/** A fresh directory under the system temp directory. */
export async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `provino-corpus-${prefix}-`))
}

/** Writes `files` (path to text) under `dir`. */
export async function writeTree(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, text] of Object.entries(files)) {
    const target = path.join(dir, name)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, text)
  }
}

/**
 * A `.tar.gz` of `files` under one top directory (`<repo>-<sha>/`, as codeload serves), made with
 * the system `tar`. Returns the tarball's path.
 */
export async function makeTarball(
  dir: string,
  files: Record<string, string>,
  top = 'demo-abcdef0',
): Promise<string> {
  const tree = path.join(dir, 'tarball-tree')
  await writeTree(path.join(tree, top), files)
  const tarball = path.join(dir, 'fixture.tar.gz')
  const result = spawnSync('tar', ['-czf', tarball, '-C', tree, top], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`tar failed: ${result.stderr}`)
  return tarball
}
