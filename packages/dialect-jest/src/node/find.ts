// T11.3: Jest 30.5's config finder, `jest-config` `resolveConfigPath.ts` rebuilt. A path to a
// file is used as it is; a directory is searched for `jest.config` with the seven extensions in
// Jest's order, then `package.json`'s `jest` key (an object, or a string naming a file), and the
// search walks up to the root. The first directory with a `package.json` ends the walk even
// without a `jest` key (Jest then reads `{}`). The messages are Jest's.
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { ConfigSource } from '@provino/types'
import { JestConfigError } from './errors.ts'
import { CONFIG_BULLET, DOCUMENTATION_NOTE, validationText } from './text.ts'

/**
 * `jest-config` `constants.ts` L21-L29: the extensions tried after `jest.config`, in order.
 * @public
 */
export const JEST_CONFIG_EXT_ORDER: readonly string[] = Object.freeze([
  '.js',
  '.ts',
  '.mjs',
  '.mts',
  '.cjs',
  '.cts',
  '.json',
])

const JEST_CONFIG_BASE_NAME = 'jest.config'
const PACKAGE_JSON = 'package.json'

/**
 * The config file names a directory is searched for, in order (`package.json` last).
 * @public
 */
export const JEST_CONFIG_CANDIDATES: readonly string[] = Object.freeze([
  ...JEST_CONFIG_EXT_ORDER.map((ext) => `${JEST_CONFIG_BASE_NAME}${ext}`),
  PACKAGE_JSON,
])

/** `resolveConfigPath.ts` L20-L21: a link to a directory counts as a file (`lstat`). */
function isFile(path: string): boolean {
  return existsSync(path) && !lstatSync(path).isDirectory()
}

/** `slash` 3: backslashes to slashes, unless the path is extended-length or not ASCII. */
export function slash(path: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: slash 3's own test for non-ASCII.
  if (/^\\\\\?\\/.test(path) || /[^\u0000-\u0080]+/.test(path)) return path
  return path.replaceAll('\\', '/')
}

/**
 * Whether `--config` was given JSON rather than a path (`jest-config` `utils.ts` L114-L118).
 * @public
 */
export function isJSONString(text: string | undefined): text is string {
  return text?.startsWith('{') === true && text.endsWith('}')
}

function packageJsonJestKey(path: string): unknown {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && 'jest' in parsed) {
      return Reflect.get(parsed, 'jest')
    }
  } catch {
    // `resolveConfigPath.ts` L141-L153 swallows a package.json it can't read or parse.
  }
  return undefined
}

function resolutionErrorMessage(initialPath: string, cwd: string): string {
  // resolveConfigPath.ts L155-L164
  return (
    'Could not find a config file based on provided values:\n' +
    `path: "${initialPath}"\n` +
    `cwd: "${cwd}"\n` +
    'Config paths must be specified by either a direct path to a config\n' +
    'file, or a path to a directory. If directory is given, Jest will try to\n' +
    `traverse directory tree up, until it finds one of those files in exact order: ${JEST_CONFIG_EXT_ORDER.map(
      (ext) => `"${JEST_CONFIG_BASE_NAME}${ext}"`,
    ).join(' or ')}.`
  )
}

function multipleConfigsMessage(configPaths: readonly string[]): string {
  // resolveConfigPath.ts L174-L185
  const lines = [
    ...configPaths.map(
      (configPath) =>
        `    * ${configPath.endsWith(PACKAGE_JSON) ? '`jest` key in ' : ''}${slash(configPath)}`,
    ),
    '',
    '  Implicit config resolution does not allow multiple configuration files.',
    '  Either remove unused config files or select one explicitly with `--config`.',
  ]
  return validationText(
    `${CONFIG_BULLET}Multiple configurations found`,
    lines.join('\n'),
    DOCUMENTATION_NOTE,
  )
}

function traverse(
  directory: string,
  initialPath: string,
  cwd: string,
  skipMultipleConfigError: boolean,
): string {
  const configFiles = JEST_CONFIG_EXT_ORDER.map((ext) =>
    resolve(directory, `${JEST_CONFIG_BASE_NAME}${ext}`),
  ).filter(isFile)
  const packagePath = resolve(directory, PACKAGE_JSON)
  const packageJson = isFile(packagePath) ? packagePath : undefined
  if (packageJson !== undefined) {
    const jestKey = packageJsonJestKey(packageJson)
    if (jestKey) {
      if (typeof jestKey === 'string') {
        const target = isAbsolute(jestKey) ? jestKey : resolve(directory, jestKey)
        if (!isFile(target)) {
          // resolveConfigPath.ts L87-L97
          throw new JestConfigError(
            'JEST_CONFIG_INVALID',
            validationText(
              `${CONFIG_BULLET}Validation Error`,
              `  Configuration in ${packageJson} is not valid. ` +
                `Jest expects the string configuration to point to a file, but ${target} is not. ` +
                `Please check your Jest configuration in ${packageJson}.`,
              DOCUMENTATION_NOTE,
            ),
          )
        }
        configFiles.push(target)
      } else {
        configFiles.push(packageJson)
      }
    }
  }
  if (!skipMultipleConfigError && configFiles.length > 1) {
    throw new JestConfigError('JEST_CONFIG_MULTIPLE', multipleConfigsMessage(configFiles))
  }
  const found = configFiles[0] ?? packageJson
  if (found !== undefined) return found
  if (directory === dirname(directory)) {
    throw new JestConfigError('JEST_CONFIG_NOT_FOUND', resolutionErrorMessage(initialPath, cwd))
  }
  return traverse(dirname(directory), initialPath, cwd, skipMultipleConfigError)
}

/**
 * Jest's `resolveConfigPath(pathToResolve, cwd)`: the config file for a path (a file is itself; a
 * directory is searched, then its parents). Throws `JestConfigError` with Jest's text:
 * `JEST_CONFIG_NO_ROOT` for a path that doesn't exist, `JEST_CONFIG_MULTIPLE`, `JEST_CONFIG_INVALID`
 * for a `package.json` string key that isn't a file, `JEST_CONFIG_NOT_FOUND` at the root.
 * @public
 */
export function resolveJestConfigPath(
  pathToResolve: string,
  cwd: string,
  options: { readonly skipMultipleConfigError?: boolean } = {},
): string {
  if (!isAbsolute(cwd)) {
    throw new JestConfigError('JEST_CONFIG_NO_ROOT', `"cwd" must be an absolute path. cwd: ${cwd}`)
  }
  const absolutePath = isAbsolute(pathToResolve) ? pathToResolve : resolve(cwd, pathToResolve)
  if (isFile(absolutePath)) return absolutePath
  if (!existsSync(absolutePath)) {
    throw new JestConfigError(
      'JEST_CONFIG_NO_ROOT',
      // resolveConfigPath.ts L52-L57
      "Can't find a root directory while resolving a config file path.\n" +
        `Provided path to resolve: ${pathToResolve}\n` +
        `cwd: ${cwd}`,
    )
  }
  return traverse(absolutePath, pathToResolve, cwd, options.skipMultipleConfigError ?? false)
}

/** The source a resolved config path is. */
export function sourceOf(path: string): ConfigSource {
  return { kind: path.endsWith(PACKAGE_JSON) ? 'package-json' : 'file', path }
}

/**
 * Finds the Jest config for `cwd`, as `jest` run there would (`readInitialOptions`, without
 * reading the file). `explicit` is `--config`: JSON text (`{…}`) is an `inline` source, anything
 * else a path resolved like the search. Throws `JestConfigError` (see `resolveJestConfigPath`).
 * @public
 */
export function findJestConfig(cwd: string, explicit?: string): ConfigSource {
  if (isJSONString(explicit)) return { kind: 'inline', path: cwd, text: explicit }
  return sourceOf(resolveJestConfigPath(explicit ?? cwd, cwd))
}
