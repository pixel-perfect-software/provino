/**
 * The lines of a workflow that are not comments, with trailing comments removed.
 * @internal
 */
export function activeLines(text: string): readonly string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, '').trimEnd())
    .filter((line) => line.trim() !== '')
}

/** A command that publishes: a package manager, then `publish` in the same command. */
const PUBLISH_ANY = /\b(?:npm|pnpm|yarn|bun)\b[^\n;&|]*\bpublish\b|\bchangeset\s+publish\b/
/**
 * A direct `pnpm publish`, with pnpm's own flags before `publish` (`-r`, `--recursive`). It can't
 * match `pnpm stage publish`, B21e's staged form that D163 replaced: that is a publish `PUBLISH_ANY`
 * finds and this doesn't, so it is reported as one that isn't a direct `pnpm -r publish`.
 */
const PUBLISH_PNPM = /\bpnpm\b(?:(?!\bstage\s+publish\b)[^\n;&|])*\bpublish\b/
/** `-r` or `--recursive`: every workspace package, not the (private) root. */
const RECURSIVE = /(?:^|\s)(?:-r|--recursive)(?=\s|$)/
/**
 * npm, npx, yarn or bun where a command starts (D75: only install-matrix.yml may): at the start of
 * a line (a `run: npm ci`, a `- run:` step, or a line of a `run: |` block) or after `&&`, `||`,
 * `;`, `|`, `(`, a backtick or `$(`. A key's value (`cache: npm`) is not at that position.
 */
const OTHER_MANAGER =
  /(?:^\s*(?:-\s+)?(?:run:\s*)?|[;&|(`]\s*|\$\(\s*)(?:npm|npx|yarn|bunx?)(?=\s|$)/

/**
 * The lines that can hold a command: not an action reference (`uses:`) and not the inputs of one
 * (the lines under `with:`, which are values and not commands).
 */
function commandLines(lines: readonly string[]): readonly string[] {
  const out: string[] = []
  let withIndent: number | undefined
  for (const line of lines) {
    const indent = line.length - line.trimStart().length
    if (withIndent !== undefined && indent > withIndent) continue
    withIndent = /^\s*(?:-\s+)?with:\s*$/.test(line) ? indent : undefined
    if (withIndent === undefined && !/^\s*(?:-\s+)?uses:/.test(line)) out.push(line)
  }
  return out
}

const indentOf = (line: string): number => line.length - line.trimStart().length

/**
 * The lines of the step that a `uses:` line starts, from the line itself to the line before the
 * next step: every following line indented at least as deep as the `uses` key.
 */
function stepOf(lines: readonly string[], start: number): readonly string[] {
  const first = lines[start] ?? ''
  const keyIndent = first.indexOf('uses:')
  const step = [first]
  for (const line of lines.slice(start + 1)) {
    if (indentOf(line) < keyIndent) break
    step.push(line)
  }
  return step
}

/**
 * Whether the top-level `on:` block is exactly a push of the tag `v*` and nothing else: `push:`
 * with a `tags:` that holds only `v*`, as a flow list (`tags: ["v*"]`) or a block list (`tags:`
 * then `- "v*"`). A `branches:` beside the tags, a second tag pattern, a `workflow_dispatch` or any
 * other event would start a release some way other than Tyler's tag.
 */
function startsFromTagOnly(lines: readonly string[]): boolean {
  const start = lines.findIndex((line) => /^on:/.test(line))
  const first = lines[start]
  if (first === undefined || first.slice(3).trim() !== '') return false
  const block: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (indentOf(line) === 0) break
    block.push(line)
  }
  const [push, tags, item, ...more] = block
  if (push === undefined || tags === undefined || more.length > 0) return false
  if (push.trim() !== 'push:' || indentOf(tags) <= indentOf(push)) return false
  if (item === undefined) return /^tags:\s*\[\s*["']?v\*["']?\s*\]$/.test(tags.trim())
  return (
    tags.trim() === 'tags:' &&
    indentOf(item) >= indentOf(tags) &&
    /^-\s*["']?v\*["']?$/.test(item.trim())
  )
}

const TOKEN_NAMES = /\b(?:NPM_TOKEN|NODE_AUTH_TOKEN|NPM_CONFIG_TOKEN|_authToken)\b/i
const SECRET_REF = /\$\{\{\s*secrets\.(?!GITHUB_TOKEN\b)[A-Za-z0-9_]+/
/** An action reference: `uses: owner/name@ref` (a local `./` action has no `@`). */
const USES = /^\s*(?:-\s+)?uses:\s*([^\s@]+)@(\S+)/
const COMMIT_SHA = /^[0-9a-f]{40}$/

/**
 * Lints the release workflow (T10.4, DECISIONS D75, D162, D163). It reads the workflow as text:
 * there is no YAML parser, so it works on the lines that aren't comments, and the checks are
 * written for the shape this repo's workflow has. A workflow it can't read the way it expects
 * fails a check rather than passing one. Returns every property the workflow lacks, in words; an
 * empty list means it has them all:
 * - it starts from a pushed `v*` tag and nothing else (D162: Tyler's tag is the approval; a PR
 *   must not reach `id-token`);
 * - `id-token: write`, so trusted publishing can exchange the run's OIDC token (pnpm does the
 *   exchange itself and attaches provenance under it);
 * - no npm token and no secret but `GITHUB_TOKEN`: there is no `NPM_TOKEN` to leak;
 * - every publish is a direct `pnpm -r publish` (D163; not the staged `pnpm stage publish`, and
 *   `-r` skips the versions already on the registry, so a rerun publishes only what is missing),
 *   and each carries `--access public` (the scoped packages), `--no-git-checks` (a tag is a
 *   detached HEAD), `--provenance` and an explicit `--tag`, and never `--force`, which would
 *   publish a version a second time;
 * - no `npm`, `npx`, `yarn` or `bun` command: D75 allows them only in install-matrix.yml;
 * - a GitHub-hosted runner;
 * - every action pinned to a commit SHA, no cache restored (`actions/cache`, a `cache:` input,
 *   and `setup-node`'s own package-manager cache switched off) and no checkout that leaves the
 *   token in `.git` (`persist-credentials: false`): a release builds only from its tagged source.
 * @internal
 */
export function lintReleaseWorkflow(text: string): readonly string[] {
  const lines = activeLines(text)
  const problems: string[] = []
  if (!lines.some((line) => /^\s*id-token:\s*write\s*$/.test(line))) {
    problems.push('no `id-token: write` permission: trusted publishing needs it')
  }
  if (!startsFromTagOnly(lines)) {
    problems.push(
      'does not start from a pushed `v*` tag alone (`on:` must be `push:` with `tags:` holding only `v*`): the tag push is the approval (D162)',
    )
  }
  const tokens = lines.filter((line) => TOKEN_NAMES.test(line) || SECRET_REF.test(line))
  for (const line of tokens) {
    problems.push(`names an npm token or a secret other than GITHUB_TOKEN: ${line.trim()}`)
  }
  for (const line of commandLines(lines).filter((line) => OTHER_MANAGER.test(line))) {
    problems.push(`runs npm, which D75 allows only in install-matrix.yml: ${line.trim()}`)
  }
  if (!lines.some((line) => PUBLISH_PNPM.test(line))) problems.push('no `pnpm -r publish` step')
  for (const line of lines.filter((line) => PUBLISH_ANY.test(line))) {
    if (!PUBLISH_PNPM.test(line)) {
      problems.push(`publishes other than with \`pnpm -r publish\`: ${line.trim()}`)
      continue
    }
    const required: readonly (readonly [RegExp, string])[] = [
      [RECURSIVE, 'is not recursive (-r), so it would publish only the private root'],
      [/--access[= ]public\b/, 'has no --access public'],
      [/--no-git-checks\b/, 'has no --no-git-checks (a tag is a detached HEAD)'],
      [/--provenance\b/, 'has no --provenance'],
      [/--tag\b/, 'has no --tag (a prerelease needs its own dist-tag)'],
    ]
    for (const [pattern, problem] of required) {
      if (!pattern.test(line)) problems.push(`publish ${problem}: ${line.trim()}`)
    }
    if (/--force\b/.test(line)) {
      problems.push(`publish with --force republishes versions already on npm: ${line.trim()}`)
    }
  }
  for (const [index, line] of lines.entries()) {
    const runner = /^\s*runs-on:\s*(.+)$/
      .exec(line)?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, '')
    if (runner !== undefined && !/^(?:ubuntu|macos|windows)-/.test(runner)) {
      problems.push(
        `runs on "${runner}", not a GitHub-hosted runner (trusted publishing needs one)`,
      )
    }
    if (
      /^\s*(?:pull_request|pull_request_target):/.test(line) ||
      /^\s*on:\s*\[?.*pull_request/.test(line)
    ) {
      problems.push('triggers on a pull request: a release must be started on purpose')
    }
    if (/^\s*(?:-\s+)?cache:\s*(?!false\b)\S/.test(line)) {
      problems.push(
        `a cache input, so a release isn't built from its tagged source alone: ${line.trim()}`,
      )
    }
    const [, action, ref] = USES.exec(line) ?? []
    if (action === undefined) continue
    if (!COMMIT_SHA.test(ref ?? '')) {
      problems.push(`action not pinned to a commit SHA: ${line.trim()}`)
    }
    if (action === 'actions/cache' || action.startsWith('actions/cache/')) {
      problems.push(
        `restores a cache, so a release isn't built from its tagged source alone: ${line.trim()}`,
      )
    } else if (action === 'actions/checkout') {
      const step = stepOf(lines, index)
      if (!step.some((part) => /^\s*persist-credentials:\s*false\s*$/.test(part))) {
        problems.push('a checkout without `persist-credentials: false` leaves the token in .git')
      }
    } else if (action === 'actions/setup-node') {
      const step = stepOf(lines, index)
      if (!step.some((part) => /^\s*package-manager-cache:\s*false\s*$/.test(part))) {
        problems.push(
          'setup-node without `package-manager-cache: false`: it restores a pnpm cache by itself when package.json has a packageManager',
        )
      }
    }
  }
  return problems
}
