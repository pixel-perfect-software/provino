// `pnpm bench:vitest-config sample --fetch`: puts B25c's sample on disk (D28's terms). Each
// manifest repository's tarball at its commit (codeload.github.com, `curl` piped to `tar`, as the
// Jest sample does) goes to `.refs/vitest-config-sample/repos/<owner>__<name>/`, and the shared
// `node_modules` the configs read with is installed beside them (hoisted: every repository sits
// under that directory, so its `vitest/config` and plugin imports resolve there). A repository
// already fetched (its `.provino-fetched` marker) is skipped.
import { fetchSample } from '../jest-config/sample-fetch.ts'
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

/** The step. */
export function fetchVitestSample(options: {
  readonly log: (line: string) => void
}): Promise<number> {
  return fetchSample({
    log: options.log,
    name: 'vitest',
    paths: { SAMPLE_DIR, MANIFEST_PATH, repoDir },
    sharedPackages: SHARED_PACKAGES,
  })
}
