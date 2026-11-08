// `pnpm bench:jest-config sample --fetch`: puts T11.6's sample on disk (D28). Each manifest
// repository's tarball at its commit (codeload.github.com, `curl` piped to `tar`, so the system's
// proxy settings apply; no clone: nested clones are blocked) goes to
// `.refs/jest-config-sample/repos/<owner>__<name>/`, and the shared `node_modules` that most
// configs read with is installed beside them (`.refs/jest-config-sample/node_modules`, hoisted, as
// an npm user's install is). Every repository sits under that directory, so its configs resolve
// packages from there. A repository already fetched (its `.provino-fetched` marker) is skipped.
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SampleManifest } from './sample-manifest.ts'
import { MANIFEST_PATH, repoDir, SAMPLE_DIR } from './sample-paths.ts'

/**
 * The shared `node_modules`: the presets and transformers Track 11 F4 names (ts-jest, React
 * Native, jest-expo, jest-preset-angular, babel-jest through jest, @swc/jest, esbuild-jest,
 * next/jest), the environments, and the setup, serializer, reporter and watch packages configs
 * name most. Exact versions, each at least 7 days old when chosen (2026-11-07). No TypeScript
 * loader (ts-node, esbuild-register): neither side may fall back to one.
 */
export const SHARED_PACKAGES: Readonly<Record<string, string>> = {
  '@angular/common': '22.2.4',
  '@angular/compiler': '22.2.4',
  '@angular/compiler-cli': '22.2.4',
  '@angular/core': '22.2.4',
  '@angular/platform-browser': '22.2.4',
  '@angular/platform-browser-dynamic': '22.2.4',
  '@emotion/jest': '11.14.2',
  '@happy-dom/jest-environment': '21.0.4',
  '@nx/jest': '24.0.3',
  '@react-native/jest-preset': '0.88.1',
  '@swc/core': '1.16.20',
  '@swc/jest': '0.2.39',
  '@testing-library/jest-dom': '7.0.1',
  'enzyme-to-json': '3.6.2',
  esbuild: '0.28.2',
  'esbuild-jest': '0.5.0',
  expo: '58.0.22',
  'identity-obj-proxy': '3.0.0',
  jest: '30.5.2',
  'jest-canvas-mock': '2.5.8',
  'jest-environment-jsdom': '30.5.2',
  'jest-expo': '58.0.13',
  'jest-extended': '7.0.0',
  'jest-junit': '17.0.0',
  'jest-preset-angular': '17.0.3',
  'jest-serializer-html': '7.1.0',
  'jest-styled-components': '7.4.0',
  'jest-watch-typeahead': '3.0.1',
  jsdom: '26.1.0',
  next: '16.4.3',
  react: '19.3.0',
  'react-dom': '19.3.0',
  'react-native': '0.88.1',
  rxjs: '7.8.2',
  'ts-jest': '29.4.15',
  typescript: '5.9.3',
  'zone.js': '0.15.1',
}

/** The file a fetched repository's directory holds: the commit its tree is. */
const FETCHED_MARKER = '.provino-fetched'

/**
 * Editor, agent and git metadata, and `.env` files, which a tarball may hold. Left out on
 * extraction: some sandboxes refuse to write the first kind or to read the second (the B14b run's
 * did: `.vscode`, `.claude`, `.idea`, `.mcp.json`, `.gitmodules`, `.gitconfig`, `.env*`). No
 * config in the sample is one of them; a config that reads a `.env` reads none on either side.
 */
const EXCLUDED_NAMES: readonly string[] = [
  '.vscode',
  '.idea',
  '.claude',
  '.cursor',
  '.mcp.json',
  '.gitmodules',
  '.gitconfig',
  '.env',
  '.env.*',
]

/** A command and its arguments, run with no shell. */
export interface Command {
  readonly command: string
  readonly args: readonly string[]
}

/** How `producer | consumer` ended: each one's exit code (`null` for a signal), and both stderrs. */
export interface PipeOutcome {
  readonly producer: number | null
  readonly consumer: number | null
  readonly stderr: string
}

/** Resolves with a child's exit code once it has closed (`null` for a signal or a failed spawn). */
function closed(child: ChildProcess, onError: (error: Error) => void): Promise<number | null> {
  return new Promise((resolve) => {
    child.once('error', (error) => {
      onError(error)
      resolve(null)
    })
    child.once('close', (code) => resolve(code))
  })
}

/**
 * Runs `producer | consumer` with no shell and waits for both to end, then gives both exit codes.
 * A consumer that ends first (`tar` refusing a bad tarball) leaves the producer writing into a
 * closed pipe: the `EPIPE` is expected and absorbed, and the producer is stopped, so one bad
 * repository is one failure, never a crash or a process left behind.
 */
export async function pipeProcesses(producer: Command, consumer: Command): Promise<PipeOutcome> {
  let stderr = ''
  const note = (text: string) => {
    stderr += text
  }
  const source = spawn(producer.command, producer.args, { stdio: ['ignore', 'pipe', 'pipe'] })
  const sink = spawn(consumer.command, consumer.args, { stdio: ['pipe', 'ignore', 'pipe'] })
  source.stderr?.on('data', (chunk: Buffer) => note(chunk.toString()))
  sink.stderr?.on('data', (chunk: Buffer) => note(chunk.toString()))
  const ignoreBrokenPipe = (error: Error) => {
    if (Reflect.get(error, 'code') !== 'EPIPE') note(`${error.message}\n`)
  }
  sink.stdin?.on('error', ignoreBrokenPipe)
  source.stdout?.on('error', ignoreBrokenPipe)
  let producerFinished = false
  source.stdout?.once('end', () => {
    producerFinished = true
  })
  if (source.stdout && sink.stdin) source.stdout.pipe(sink.stdin)
  const onSpawnError = (error: Error) => note(`${error.message}\n`)
  const [producerCode, consumerCode] = await Promise.all([
    closed(source, onSpawnError),
    closed(sink, onSpawnError).then((code) => {
      // A consumer that ended before the producer's output did will never read the rest. One that
      // ended after it (the usual case, `tar` done) leaves the producer to exit by itself.
      if (!producerFinished && source.exitCode === null && source.signalCode === null) {
        source.kill('SIGTERM')
      }
      return code
    }),
  ])
  return { producer: producerCode, consumer: consumerCode, stderr }
}

/**
 * Gets a repository's directory ready: `'fetched'` when it already holds this commit's tree (its
 * marker names the commit), else `'fetch'`, with whatever was there removed first, so files the
 * commit doesn't have (another commit's, or a part-extracted run's) can't survive. Throws when the
 * old tree can't be removed.
 */
export function prepareRepoDir(dest: string, sha: string): 'fetched' | 'fetch' {
  const marker = join(dest, FETCHED_MARKER)
  if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === sha) return 'fetched'
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  return 'fetch'
}

/** Downloads a repository's tarball at a commit and extracts it into `dest` (`curl … | tar -xz`). */
function download(url: string, dest: string): Promise<PipeOutcome> {
  const excludes = EXCLUDED_NAMES.flatMap((name) => ['--exclude', name, '--exclude', `*/${name}`])
  return pipeProcesses(
    { command: 'curl', args: ['-fsSL', '--retry', '3', url] },
    { command: 'tar', args: ['-xzf', '-', '-C', dest, '--strip-components=1', ...excludes] },
  )
}

function run(command: string, args: readonly string[], cwd: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.on('close', (code) => resolve(code))
  })
}

/** The step. */
export async function fetchSample(options: {
  readonly log: (line: string) => void
}): Promise<number> {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as SampleManifest
  mkdirSync(join(SAMPLE_DIR, 'repos'), { recursive: true })
  let failed = 0
  const queue = [...manifest.repos]
  const workers = Array.from({ length: 4 }, async () => {
    for (let entry = queue.shift(); entry !== undefined; entry = queue.shift()) {
      const dest = repoDir(entry.repo)
      let state: 'fetched' | 'fetch'
      try {
        state = prepareRepoDir(dest, entry.sha)
      } catch (error) {
        failed++
        options.log(
          `  FAIL ${entry.repo}@${entry.sha.slice(0, 8)}: can't remove the old tree: ${error instanceof Error ? error.message : String(error)}`,
        )
        continue
      }
      if (state === 'fetched') continue
      const result = await download(
        `https://codeload.github.com/${entry.repo}/tar.gz/${entry.sha}`,
        dest,
      )
      if (result.producer !== 0 || result.consumer !== 0) {
        failed++
        options.log(
          `  FAIL ${entry.repo}@${entry.sha.slice(0, 8)}: curl ${result.producer}, tar ${result.consumer}: ${result.stderr.trim().slice(0, 200)}`,
        )
        continue
      }
      writeFileSync(join(dest, FETCHED_MARKER), `${entry.sha}\n`)
      options.log(`  fetched ${entry.repo}@${entry.sha.slice(0, 8)}`)
    }
  })
  await Promise.all(workers)
  writeFileSync(
    join(SAMPLE_DIR, 'package.json'),
    `${JSON.stringify({ name: 'provino-jest-config-sample', private: true, dependencies: SHARED_PACKAGES }, null, 2)}\n`,
  )
  writeFileSync(
    join(SAMPLE_DIR, 'pnpm-workspace.yaml'),
    [
      '# The shared node_modules of the Jest config sample (written by `bench:jest-config sample --fetch`).',
      'packages: []',
      'minimumReleaseAge: 10080',
      'nodeLinker: hoisted',
      '# No install scripts run; reading a config needs none.',
      'strictDepBuilds: false',
      '',
    ].join('\n'),
  )
  options.log('installing the shared node_modules')
  const install = await run('pnpm', ['install', '--ignore-scripts'], SAMPLE_DIR)
  if (install !== 0) {
    options.log(`FAIL pnpm install exited ${install}`)
    return 1
  }
  options.log(
    failed === 0
      ? `fetched all ${manifest.repos.length} repositories`
      : `FAIL ${failed} repositories didn't fetch`,
  )
  return failed === 0 ? 0 : 1
}
