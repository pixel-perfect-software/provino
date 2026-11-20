// `pnpm bench:vitest-config sample --build-manifest`: picks B25c's sample from GitHub (D28's terms)
// and writes `packages/dialect-vitest/oracle/sample-manifest.json`: repository, commit and path
// only. The same walk as the Jest sample's (most-starred TypeScript and JavaScript repositories,
// each one's tree at its default branch's head), taking Vitest configs by `sample-select.ts`.
//
// Needs network (api.github.com) and a logged-in GitHub CLI: every call goes through `gh api`.
// Answers are cached under `.refs/vitest-config-sample/api-cache/`, so a run that stops can be run
// again.
import {
  packageJsonTexts as fileTexts,
  GitHub,
  popularRepos,
  type SearchItem,
} from '../jest-config/sample-manifest.ts'
import {
  candidateKind,
  declaresTest,
  emptyTally,
  PER_REPO_CAP,
  quotasFull,
  SAMPLE_QUOTAS,
  type SampleKind,
  type Tally,
  takeConfigs,
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

interface TreeEntry {
  readonly path: string
  readonly type: string
}

async function repoCandidates(
  github: GitHub,
  item: SearchItem,
): Promise<{ sha: string; candidates: string[]; truncated: boolean } | undefined> {
  const head = await github.get(
    `repos/${item.full_name}/commits/${encodeURIComponent(item.default_branch)}`,
    'application/vnd.github.sha',
  )
  if (head.status !== 200 || typeof head.body !== 'string') return undefined
  const sha = head.body.trim()
  const tree = await github.get(`repos/${item.full_name}/git/trees/${sha}?recursive=1`)
  if (tree.status !== 200) return undefined
  const body = tree.body as { tree?: TreeEntry[]; truncated?: boolean }
  const candidates = (body.tree ?? [])
    .filter((entry) => entry.type === 'blob' && candidateKind(entry.path) !== undefined)
    .map((entry) => entry.path)
  return { sha, candidates, truncated: body.truncated === true }
}

/** Builds the manifest. */
export async function buildManifest(options: {
  readonly cacheDir: string
  readonly log: (line: string) => void
}): Promise<SampleManifest> {
  const github = new GitHub(options.cacheDir)
  const repos = await popularRepos(github)
  options.log(`${repos.length} candidate repositories (TypeScript and JavaScript, by stars)`)
  const tally: Tally = emptyTally()
  const picked: ManifestRepo[] = []
  let scanned = 0
  let truncatedTrees = 0
  let errors = 0
  const CONCURRENCY = 8
  for (let start = 0; start < repos.length && !quotasFull(tally); start += CONCURRENCY) {
    const batch = repos.slice(start, start + CONCURRENCY)
    const listed = await Promise.all(
      batch.map(async (item) => {
        try {
          const found = await repoCandidates(github, item)
          if (found === undefined) return { item, found: undefined }
          const viteConfigs = found.candidates
            .filter((path) => candidateKind(path) === 'vite.config')
            .sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1))
            .slice(0, 40)
          const texts =
            viteConfigs.length === 0
              ? new Map<string, string>()
              : await fileTexts(github, item.full_name, found.sha, viteConfigs)
          return { item, found, texts }
        } catch (error) {
          options.log(
            `  ${item.full_name}: ${error instanceof Error ? error.message : String(error)}`,
          )
          return { item, found: undefined, error: true }
        }
      }),
    )
    // Taken in star order, whatever order the batch answered in.
    for (const entry of listed) {
      scanned++
      if ('error' in entry && entry.error) errors++
      if (entry.found === undefined || quotasFull(tally)) continue
      if (entry.found.truncated) truncatedTrees++
      const texts =
        'texts' in entry ? (entry.texts ?? new Map<string, string>()) : new Map<string, string>()
      const configs = takeConfigs(
        entry.found.candidates,
        (path) => {
          const text = texts.get(path)
          return text !== undefined && declaresTest(text)
        },
        tally,
      )
      if (configs.length > 0) {
        picked.push({
          repo: entry.item.full_name,
          sha: entry.found.sha,
          stars: entry.item.stargazers_count,
          configs,
        })
      }
    }
    const total = Object.values(tally).reduce((sum, count) => sum + count, 0)
    options.log(
      `  scanned ${scanned}, picked ${picked.length} repos, ${total} configs (${github.calls} API calls)`,
    )
  }
  if (!quotasFull(tally)) {
    options.log(`quotas not full after every candidate: ${JSON.stringify(tally)}`)
  }
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
    scanned: { repos: scanned, truncatedTrees, errors },
    repos: picked,
  }
}
