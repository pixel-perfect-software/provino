// `pnpm bench:vitest-config sample --build-manifest`: picks B25c's sample from GitHub (D28's terms)
// and writes `packages/dialect-vitest/oracle/sample-manifest.json`: repository, commit and path
// only. The same walk as the Jest sample's (most-starred TypeScript and JavaScript repositories,
// each one's tree at its default branch's head), taking Vitest configs by `sample-select.ts`.
//
// Needs network (api.github.com) and a logged-in GitHub CLI: every call goes through `gh api`.
// Answers are cached under `.refs/vitest-config-sample/api-cache/`, so a run that stops can be run
// again.
import { GitHub, scanRepos } from '../jest-config/sample-manifest.ts'
import {
  candidateKind,
  declaresTest,
  PER_REPO_CAP,
  SAMPLE_QUOTAS,
  type SampleKind,
} from './sample-select.ts'

/** One repository's entry in the manifest. */
export interface ManifestRepo {
  readonly repo: string
  readonly sha: string
  readonly stars: number
  readonly configs: readonly { readonly path: string; readonly kind: SampleKind }[]
}

/** The committed manifest. */
export interface SampleManifest {
  readonly $comment: readonly string[]
  readonly generated: string
  readonly quotas: Readonly<Record<SampleKind, number>>
  readonly perRepoCap: number
  readonly scanned: {
    readonly repos: number
    readonly truncatedTrees: number
    readonly errors: number
  }
  readonly repos: readonly ManifestRepo[]
}

/** Builds the manifest. */
export async function buildManifest(options: {
  readonly cacheDir: string
  readonly log: (line: string) => void
}): Promise<SampleManifest> {
  const scan = await scanRepos({
    github: new GitHub(options.cacheDir),
    log: options.log,
    quotas: SAMPLE_QUOTAS,
    classify: candidateKind,
    textKind: 'vite.config',
    textLimit: 40,
    declares: declaresTest,
  })
  return {
    $comment: [
      "B25c's Vitest config sample, rebuilt (D28's terms; T11.15). Written by `pnpm bench:vitest-config sample --build-manifest`; never hand-edited.",
      "Track 11 F4 rules: the most-starred TypeScript and JavaScript repositories on GitHub (search by stars, forks left out), configs in fixtures, templates, e2e and node_modules left out, at most 6 per repository, until each kind has F4's count.",
      'A config is vitest.config.<ext> or vite.config.<ext> whose text declares a `test` property; shallowest first within a repository. Legacy vitest.workspace files are left out: Vitest 5 reads none.',
      'Only repository, commit and path are committed; the tarballs go to .refs/vitest-config-sample/ (`sample --fetch`).',
    ],
    generated: new Date().toISOString().slice(0, 10),
    quotas: SAMPLE_QUOTAS,
    perRepoCap: PER_REPO_CAP,
    scanned: {
      repos: scan.scanned,
      truncatedTrees: scan.truncatedTrees,
      errors: scan.errors,
    },
    repos: scan.picked,
  }
}
