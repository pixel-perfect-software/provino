// `pnpm bench:jest-config sample --build-manifest`: picks T11.6's sample from GitHub (D28) and
// writes `packages/dialect-jest/oracle/sample-manifest.json`: repository, commit and path only.
// It walks the most-starred TypeScript and JavaScript repositories (GitHub search, by stars), lists
// each one's tree at its default branch's head commit, reads its `package.json` files' text, and
// takes configs by `sample-select.ts`'s rules until every format's quota is full.
//
// Needs network (api.github.com) and a logged-in GitHub CLI: every call goes through `gh api`, so
// no credential passes through this code. Answers are cached under
// `.refs/jest-config-sample/api-cache/`, so a run that stops can be run again.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  candidateFormat,
  emptyTally,
  hasJestObject,
  PER_REPO_CAP,
  quotasFull,
  SAMPLE_QUOTAS,
  type SampleFormat,
  type Tally,
  takeConfigs,
} from './sample-select.ts'

const run = promisify(execFile)

/** One repository's entry in the manifest. */
export interface ManifestRepo {
  readonly repo: string
  readonly sha: string
  readonly stars: number
  readonly configs: readonly { readonly path: string; readonly format: SampleFormat }[]
}

/** The committed manifest. */
export interface SampleManifest {
  readonly $comment: readonly string[]
  readonly generated: string
  readonly quotas: Readonly<Record<SampleFormat, number>>
  readonly perRepoCap: number
  /** Repositories looked at and why some gave nothing (by count), for the record. */
  readonly scanned: {
    readonly repos: number
    readonly truncatedTrees: number
    readonly errors: number
  }
  readonly repos: readonly ManifestRepo[]
}

/** A GitHub client over `gh api`, with an answer cache and backoff on rate limits. */
class GitHub {
  readonly #cacheDir: string
  calls = 0

  constructor(cacheDir: string) {
    this.#cacheDir = cacheDir
    mkdirSync(cacheDir, { recursive: true })
  }

  async #gh(args: readonly string[]): Promise<{ status: number; body: unknown }> {
    const key = createHash('sha1').update(JSON.stringify(args)).digest('hex')
    const cached = join(this.#cacheDir, `${key}.json`)
    if (existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf8'))
    for (let attempt = 0; ; attempt++) {
      this.calls++
      let answer: { status: number; body: unknown }
      try {
        const { stdout } = await run('gh', ['api', ...args], { maxBuffer: 256 * 1024 * 1024 })
        const text = stdout.trim()
        answer = {
          status: 200,
          body: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text,
        }
      } catch (error) {
        const stderr = String(Reflect.get(error as object, 'stderr') ?? '')
        if (/rate limit|HTTP 429|HTTP 403/i.test(stderr) && attempt < 6) {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(5000 * 2 ** attempt, 120_000)),
          )
          continue
        }
        const status = /HTTP (404|409|422)/.exec(stderr)?.[1]
        if (status === undefined)
          throw new Error(`gh api ${args.join(' ')}: ${stderr.slice(0, 300)}`)
        answer = { status: Number(status), body: null }
      }
      writeFileSync(cached, JSON.stringify(answer))
      return answer
    }
  }

  get(path: string, accept?: string): Promise<{ status: number; body: unknown }> {
    return this.#gh(accept === undefined ? [path] : ['-H', `Accept: ${accept}`, path])
  }

  async graphql(query: string): Promise<unknown> {
    const answer = await this.#gh(['graphql', '-f', `query=${query}`])
    const body = answer.body as { data?: unknown; errors?: unknown } | null
    if (body === null || (body.errors !== undefined && body.data === undefined)) {
      throw new Error(`GitHub GraphQL: ${JSON.stringify(body?.errors ?? body).slice(0, 300)}`)
    }
    return body.data
  }
}

interface SearchItem {
  readonly full_name: string
  readonly stargazers_count: number
  readonly default_branch: string
  readonly fork: boolean
}

async function popularRepos(github: GitHub): Promise<SearchItem[]> {
  const byName = new Map<string, SearchItem>()
  for (const language of ['TypeScript', 'JavaScript']) {
    for (let page = 1; page <= 10; page++) {
      const answer = await github.get(
        `search/repositories?q=${encodeURIComponent(`language:${language} stars:>1000`)}&sort=stars&order=desc&per_page=100&page=${page}`,
      )
      const items = (answer.body as { items?: SearchItem[] }).items ?? []
      for (const item of items) if (!item.fork) byName.set(item.full_name, item)
      if (items.length < 100) break
    }
  }
  return [...byName.values()].sort(
    (a, b) => b.stargazers_count - a.stargazers_count || (a.full_name < b.full_name ? -1 : 1),
  )
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
    .filter((entry) => entry.type === 'blob' && candidateFormat(entry.path) !== undefined)
    .map((entry) => entry.path)
  return { sha, candidates, truncated: body.truncated === true }
}

/** The `package.json` texts of a repository at a commit, at most `limit`, shallowest first. */
async function packageJsonTexts(
  github: GitHub,
  repo: string,
  sha: string,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const [owner, name] = repo.split('/')
  const out = new Map<string, string>()
  for (let start = 0; start < paths.length; start += 40) {
    const batch = paths.slice(start, start + 40)
    const fields = batch
      .map(
        (path, index) =>
          `f${index}: object(expression: ${JSON.stringify(`${sha}:${path}`)}) { ... on Blob { text } }`,
      )
      .join('\n')
    const data = (await github.graphql(
      `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields} } }`,
    )) as { repository?: Record<string, { text?: string | null } | null> } | null
    batch.forEach((path, index) => {
      const text = data?.repository?.[`f${index}`]?.text
      if (typeof text === 'string') out.set(path, text)
    })
  }
  return out
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
          const packageJsons = found.candidates
            .filter((path) => candidateFormat(path) === 'package.json')
            .sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1))
            .slice(0, 120)
          const texts =
            packageJsons.length === 0
              ? new Map<string, string>()
              : await packageJsonTexts(github, item.full_name, found.sha, packageJsons)
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
          return text !== undefined && hasJestObject(text)
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
      "T11.6's sample, rebuilt (D28; bundles/B14.md question 2). Written by `pnpm bench:jest-config sample --build-manifest`; never hand-edited.",
      "Track 11 F4 rules: the most-starred TypeScript and JavaScript repositories on GitHub (search by stars, forks left out), configs in fixtures, templates, e2e and node_modules left out, at most 6 per repository, until each format has F4's count.",
      'A config is jest.config.<ext> or a variant named like one, or a package.json whose `jest` key is an object; shallowest first within a repository. A format whose quota is full takes no more configs.',
      'Only repository, commit and path are committed; the tarballs go to .refs/jest-config-sample/ (`sample --fetch`).',
    ],
    generated: new Date().toISOString().slice(0, 10),
    quotas: SAMPLE_QUOTAS,
    perRepoCap: PER_REPO_CAP,
    scanned: { repos: scanned, truncatedTrees, errors },
    repos: picked,
  }
}
