// Paths the extractor leaves out of a corpus tree, always, wherever it runs. Claude Code's agent
// sandbox refuses to create `.vscode/` and `.idea/` files, `.mcp.json`, git configuration files,
// `.ripgreprc` and shell start-up files, and to delete or change `.env` files, so an extraction that
// included them would give a different tree in an agent's shell and in a terminal. None is read by
// a test suite as a test input (editor settings, a demo app's `.env`, empty submodule pointers).
// `FetchResult.leftOut` lists what was left out so a reviewer can check.

/** The environment-file suffixes: `.env`, `.env.production`, ... and `.env.<anything>.local`. */
const ENV_SUFFIXES: readonly string[] = [
  'production',
  'prod',
  'staging',
  'development',
  'dev',
  'local',
]

/** Directories left out whole. */
const LEFT_OUT_DIRS: readonly string[] = ['.vscode', '.idea']

/** Files left out by name, wherever they are. */
const LEFT_OUT_FILES: readonly string[] = [
  '.mcp.json',
  '.gitmodules',
  '.gitconfig',
  '.ripgreprc',
  '.bashrc',
  '.zshrc',
  '.profile',
]

/** `tar --exclude` patterns, matched against the whole member name (`*` crosses `/`). */
export const LEFT_OUT_PATTERNS: readonly string[] = [
  '*/.env',
  ...ENV_SUFFIXES.map((suffix) => `*/.env.${suffix}`),
  '*/.env.*.local',
  ...LEFT_OUT_DIRS.flatMap((dir) => [`*/${dir}`, `*/${dir}/*`]),
  ...LEFT_OUT_FILES.map((file) => `*/${file}`),
]

const ENV_FILE = new RegExp(`^\\.env(?:\\.(?:${ENV_SUFFIXES.join('|')})|\\..+\\.local)?$`)

/**
 * Whether a repository-relative tarball entry is one `LEFT_OUT_PATTERNS` excludes.
 * @public
 */
export function isLeftOut(entry: string): boolean {
  const segments = entry.split('/')
  const name = segments.at(-1) ?? ''
  return (
    ENV_FILE.test(name) ||
    LEFT_OUT_FILES.includes(name) ||
    LEFT_OUT_DIRS.some((dir) => segments.includes(dir))
  )
}
