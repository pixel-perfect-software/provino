// Paths the extractor leaves out of a corpus tree, always, wherever it runs. Claude Code's agent
// sandbox refuses to create `.vscode/` and `.idea/` files, `.mcp.json`, git configuration files,
// `.ripgreprc` and shell start-up files, and to delete or change `.env` files, so an extraction that
// included them would give a different tree in an agent's shell and in a terminal. None is read by
// a test suite as a test input (editor settings, a demo app's `.env`, empty submodule pointers).
// `FetchResult.leftOut` lists what was left out so a reviewer can check.

/** `tar --exclude` patterns, matched against the whole member name (`*` crosses `/`). */
export const LEFT_OUT_PATTERNS: readonly string[] = [
  '*/.env',
  '*/.env.production',
  '*/.env.prod',
  '*/.env.staging',
  '*/.env.development',
  '*/.env.dev',
  '*/.env.local',
  '*/.env.*.local',
  '*/.vscode',
  '*/.vscode/*',
  '*/.idea',
  '*/.idea/*',
  '*/.mcp.json',
  '*/.gitmodules',
  '*/.gitconfig',
  '*/.ripgreprc',
  '*/.bashrc',
  '*/.zshrc',
  '*/.profile',
]

const ENV_FILE = /^\.env(?:\.(?:production|prod|staging|development|dev|local)|\..+\.local)?$/

const LEFT_OUT_FILES: ReadonlySet<string> = new Set([
  '.mcp.json',
  '.gitmodules',
  '.gitconfig',
  '.ripgreprc',
  '.bashrc',
  '.zshrc',
  '.profile',
])

/**
 * Whether a repository-relative tarball entry is one `LEFT_OUT_PATTERNS` excludes.
 * @public
 */
export function isLeftOut(entry: string): boolean {
  const segments = entry.split('/')
  const name = segments.at(-1) ?? ''
  return (
    ENV_FILE.test(name) ||
    LEFT_OUT_FILES.has(name) ||
    segments.includes('.vscode') ||
    segments.includes('.idea')
  )
}
