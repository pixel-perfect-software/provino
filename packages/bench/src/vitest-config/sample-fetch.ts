// `pnpm bench:vitest-config sample --fetch`: puts B25c's sample on disk (D28's terms). Each
// manifest repository's tarball at its commit (codeload.github.com, `curl` piped to `tar`, as the
// Jest sample does) goes to `.refs/vitest-config-sample/repos/<owner>__<name>/`, and the shared
// `node_modules` the configs read with is installed beside them (hoisted: every repository sits
// under that directory, so its `vitest/config` and plugin imports resolve there). A repository
// already fetched (its `.provino-fetched` marker) is skipped.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Command, pipeProcesses, prepareRepoDir } from '../jest-config/sample-fetch.ts'
import type { SampleManifest } from './sample-manifest.ts'
import { MANIFEST_PATH, repoDir, SAMPLE_DIR } from './sample-paths.ts'

/**
 * The shared `node_modules`: Vitest at the pinned 5.0.5 (Vite comes with it), and the plugins,
 * environments and helpers Vitest configs name most. Every one but `vitest` resolves to what the
 * registry's newest release at least 7 days old is when the install runs (`minimumReleaseAge`),
 * and the lockfile the install writes in the sample directory records the result. No TypeScript
 * loader: neither side may fall back to one.
 */
export const SHARED_PACKAGES: Readonly<Record<string, string>> = {
  vitest: '5.0.5',
  '@vitest/coverage-istanbul': '5.0.5',
  '@vitest/coverage-v8': '5.0.5',
  '@vitejs/plugin-react': '*',
  '@vitejs/plugin-vue': '*',
  '@sveltejs/vite-plugin-svelte': '*',
  'vite-tsconfig-paths': '*',
  'vite-plugin-svgr': '*',
  '@testing-library/jest-dom': '*',
  'happy-dom': '*',
  jsdom: '*',
  react: '*',
  'react-dom': '*',
  svelte: '*',
  typescript: '5.9.3',
  vue: '*',
}

const FETCHED_MARKER = '.provino-fetched'

/** Editor, agent and git metadata, and `.env` files, which a tarball may hold: left out on extraction. */
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

function download(url: string, dest: string) {
  const excludes = EXCLUDED_NAMES.flatMap((name) => ['--exclude', name, '--exclude', `*/${name}`])
  const producer: Command = { command: 'curl', args: ['-fsSL', '--retry', '3', url] }
  const consumer: Command = {
    command: 'tar',
    args: ['-xzf', '-', '-C', dest, '--strip-components=1', ...excludes],
  }
  return pipeProcesses(producer, consumer)
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
    `${JSON.stringify({ name: 'provino-vitest-config-sample', private: true, dependencies: SHARED_PACKAGES }, null, 2)}\n`,
  )
  writeFileSync(
    join(SAMPLE_DIR, 'pnpm-workspace.yaml'),
    [
      '# The shared node_modules of the Vitest config sample (written by `bench:vitest-config sample --fetch`).',
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
