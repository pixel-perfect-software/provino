// jest-changed-files 30.5.1's three adapters (`src/git.ts`, `src/hg.ts`, `src/sl.ts`), their
// commands and arguments exactly, over `runCommand` (execa's behaviour, no execa). Compat: these
// are Jest's own git, hg and sl calls (D115; one `git status --porcelain -z` is the faster option a
// neutral provider can take later).
import * as path from 'node:path'
import { CANCELLED, runCommand } from './exec.ts'

/** What an adapter is asked (jest-changed-files `Options` plus `includePaths`). */
export interface AdapterOptions {
  readonly includePaths?: readonly string[]
  readonly changedSince?: string | undefined
  readonly lastCommit?: boolean | undefined
  readonly withAncestor?: boolean | undefined
}

/** jest-changed-files' `SCMAdapter`. */
export interface ScmAdapter {
  findChangedFiles(cwd: string, options: AdapterOptions): Promise<readonly string[]>
  getRoot(cwd: string): Promise<string | null>
}

/** The lines of a command's output as absolute paths (`findChangedFilesUsingCommand`). */
function toPaths(stdout: string, cwd: string): string[] {
  return stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((changedPath) => path.resolve(cwd, changedPath))
}

async function stdoutOf(
  file: string,
  args: readonly string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const out = await runCommand(file, args, { cwd, ...(env === undefined ? {} : { env }) })
  return out === CANCELLED ? '' : out
}

/** `git.ts` L12-L23. */
async function gitFiles(args: readonly string[], cwd: string): Promise<string[]> {
  return toPaths(await stdoutOf('git', args, cwd), cwd)
}

/** jest-changed-files `src/git.ts` L25-L107. */
export const gitAdapter: ScmAdapter = {
  async findChangedFiles(cwd, options) {
    const changedSince = options.withAncestor === true ? 'HEAD^' : options.changedSince
    const includePaths = (options.includePaths ?? []).map((absoluteRoot) =>
      path.normalize(path.relative(cwd, absoluteRoot)),
    )
    if (options.lastCommit === true) {
      return gitFiles(
        ['show', '--name-only', '--pretty=format:', 'HEAD', '--', ...includePaths],
        cwd,
      )
    }
    const staged = ['diff', '--cached', '--name-only', '--', ...includePaths]
    const unstaged = [
      'ls-files',
      '--other',
      '--modified',
      '--exclude-standard',
      '--',
      ...includePaths,
    ]
    if (changedSince != null && changedSince.length > 0) {
      const [committed, cached, rest] = await Promise.all([
        gitFiles(['diff', '--name-only', `${changedSince}...HEAD`, '--', ...includePaths], cwd),
        gitFiles(staged, cwd),
        gitFiles(unstaged, cwd),
      ])
      return [...committed, ...cached, ...rest]
    }
    const [cached, rest] = await Promise.all([gitFiles(staged, cwd), gitFiles(unstaged, cwd)])
    return [...cached, ...rest]
  },
  async getRoot(cwd) {
    try {
      return path.resolve(cwd, await stdoutOf('git', ['rev-parse', '--show-cdup'], cwd))
    } catch {
      return null
    }
  },
}

/** `hg.ts` L13 and `sl.ts` L18: `HGPLAIN` turns off the settings that change the output. */
function plainEnv(): NodeJS.ProcessEnv {
  return { ...process.env, HGPLAIN: '1' }
}

/** The `status` arguments hg and sl share (`hg.ts` L17-L30, `sl.ts` L24-L37). */
function statusArgs(options: AdapterOptions): string[] {
  const args = ['status', '-amnu']
  if (options.withAncestor === true) {
    args.push('--rev', 'first(min(!public() & ::.)^+.^)')
  } else if (options.changedSince != null && options.changedSince.length > 0) {
    args.push('--rev', `ancestor(., ${options.changedSince})`)
  } else if (options.lastCommit === true) {
    args.push('--change', '.')
  }
  args.push(...(options.includePaths ?? []))
  return args
}

/** jest-changed-files `src/hg.ts` L15-L48. */
export const hgAdapter: ScmAdapter = {
  async findChangedFiles(cwd, options) {
    return toPaths(await stdoutOf('hg', statusArgs(options), cwd, plainEnv()), cwd)
  },
  async getRoot(cwd) {
    try {
      return await stdoutOf('hg', ['root'], cwd, plainEnv())
    } catch {
      return null
    }
  },
}

/**
 * jest-changed-files `src/sl.ts` L22-L76. `sl` may be the steam locomotive, which draws with escape
 * codes: a first chunk that starts with ESC kills it and no Sapling root is looked for again. Jest
 * keeps that in a module variable; here it lives for one provider call (no module state).
 */
export function slAdapter(): ScmAdapter {
  let isSteamLocomotive = false
  return {
    async findChangedFiles(cwd, options) {
      return toPaths(await stdoutOf('sl', statusArgs(options), cwd, plainEnv()), cwd)
    },
    async getRoot(cwd) {
      if (isSteamLocomotive) return null
      try {
        const out = await runCommand('sl', ['root'], {
          cwd,
          env: plainEnv(),
          firstChunk: (chunk) => {
            if (chunk.codePointAt(0) === 27) isSteamLocomotive = true
            return isSteamLocomotive
          },
        })
        return out === CANCELLED ? null : out
      } catch {
        return null
      }
    },
  }
}
