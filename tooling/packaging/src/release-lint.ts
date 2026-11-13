/**
 * What the release workflow must and must not do (T10.4, DECISIONS D75). The lint reads the
 * workflow as text: it has no YAML parser, so it works on the lines that aren't comments, and
 * the checks are written for the shape this repo's workflow has. A workflow it can't read the
 * way it expects fails a check rather than passing one.
 * @internal
 */
export interface ReleaseLintOptions {
  /** A draft never publishes: every publish command carries `--dry-run`. */
  readonly draft: boolean
}

/** The lines of a workflow that are not comments, with trailing comments removed. */
function activeLines(text: string): readonly string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, '').trimEnd())
    .filter((line) => line.trim() !== '')
}

/** A command that publishes: a package manager, then `publish` in the same command. */
const PUBLISH_ANY = /\b(?:npm|pnpm|yarn|bun)\b[^\n;&|]*\bpublish\b|\bchangeset\s+publish\b/
/** `pnpm stage publish`, with pnpm's own flags before `stage` (`-r`, `--recursive`). */
const PUBLISH_STAGED = /\bpnpm\b[^\n;&|]*\bstage\s+publish\b/
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
const TOKEN_NAMES = /\b(?:NPM_TOKEN|NODE_AUTH_TOKEN|NPM_CONFIG_TOKEN|_authToken)\b/i
const SECRET_REF = /\$\{\{\s*secrets\.(?!GITHUB_TOKEN\b)[A-Za-z0-9_]+/

/**
 * Lints a release workflow. Returns every property it lacks, in words; an empty list means it
 * has them all:
 * - `id-token: write`, so trusted publishing can exchange the run's OIDC token (pnpm does the
 *   exchange itself and attaches provenance under it);
 * - no npm token and no secret but `GITHUB_TOKEN`: there is no `NPM_TOKEN` to leak;
 * - every publish is `pnpm stage publish` (staged: the version goes live at `pnpm stage
 *   approve`, with a one-time password), and each carries `--provenance`; `-r` skips the versions
 *   already on the registry, so a rerun after a first release publishes only what changed;
 * - no `npm`, `npx`, `yarn` or `bun` command: D75 allows them only in install-matrix.yml;
 * - a GitHub-hosted runner, and no `pull_request` trigger (a PR must not reach `id-token`);
 * - in a draft, `--dry-run` on every publish.
 * @internal
 */
export function lintReleaseWorkflow(text: string, options: ReleaseLintOptions): readonly string[] {
  const lines = activeLines(text)
  const problems: string[] = []
  if (!lines.some((line) => /^\s*id-token:\s*write\s*$/.test(line))) {
    problems.push('no `id-token: write` permission: trusted publishing needs it')
  }
  const tokens = lines.filter((line) => TOKEN_NAMES.test(line) || SECRET_REF.test(line))
  for (const line of tokens) {
    problems.push(`names an npm token or a secret other than GITHUB_TOKEN: ${line.trim()}`)
  }
  for (const line of commandLines(lines).filter((line) => OTHER_MANAGER.test(line))) {
    problems.push(`runs npm, which D75 allows only in install-matrix.yml: ${line.trim()}`)
  }
  const publishes = lines.filter((line) => PUBLISH_ANY.test(line))
  if (!lines.some((line) => PUBLISH_STAGED.test(line))) {
    problems.push('no `pnpm stage publish` step')
  }
  for (const line of publishes) {
    if (!PUBLISH_STAGED.test(line)) {
      problems.push(`publishes other than with \`pnpm stage publish\`: ${line.trim()}`)
    } else {
      if (!/--provenance\b/.test(line))
        problems.push(`publish without --provenance: ${line.trim()}`)
      if (options.draft && !/--dry-run\b/.test(line)) {
        problems.push(`a draft must not publish, but this has no --dry-run: ${line.trim()}`)
      }
    }
  }
  for (const line of lines) {
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
  }
  return problems
}
