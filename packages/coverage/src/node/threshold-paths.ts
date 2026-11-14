// How a coverage threshold group's name becomes the absolute path or glob it is matched as
// (jest-reporters CoverageReporter.ts L286-L345). Apart from `checkThresholds` so the Windows rules
// can be run through `path.win32` on any host: both functions take the path flavour they work in.
import nodePath, { type PlatformPath } from 'node:path'

/**
 * A group's name as an absolute path, keeping a trailing separator the user wrote (`path.resolve`
 * drops it, and `./src/` must not match `./src-other/`; jest#12703). On Windows a trailing `/`
 * counts as a separator too, since the group is written in the config as a POSIX path.
 */
export function absoluteGroup(name: string, cwd: string, flavour: PlatformPath = nodePath): string {
  const resolved = flavour.resolve(cwd, name)
  const windows = flavour.sep === '\\'
  const trailing = name.endsWith(flavour.sep) || (windows && name.endsWith('/'))
  const suffix = trailing && !resolved.endsWith(flavour.sep) ? flavour.sep : ''
  return `${resolved}${suffix}`
}

/**
 * The pattern a group is globbed with. Jest calls `glob.sync(pattern, { windowsPathsNoEscape: true
 * })`, and glob (13.0.6) then rewrites every `\` in the pattern to `/` on every platform, so a
 * Windows path's separators are separators and a backslash escape is not one anywhere.
 */
export function globPatternOf(absolute: string): string {
  return absolute.replaceAll('\\', '/')
}
