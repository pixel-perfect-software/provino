// Rolldown-style hook filters (`{ filter: { id, code } }`): a string is a glob, a RegExp is tested
// as is. A filter keeps a plugin's hook from running at all, which is what makes a plugin like
// vite-tsconfig-paths or vue cheap on the files they ignore.

/** A pattern or a list of them. */
export type FilterPattern = string | RegExp | readonly (string | RegExp)[]

/** `include` and `exclude`, or the include list alone. */
export type FilterValue =
  | FilterPattern
  | { readonly include?: FilterPattern; readonly exclude?: FilterPattern }

/**
 * A hook's `filter`.
 * @public
 */
export interface HookFilter {
  readonly id?: FilterValue
  readonly code?: FilterValue
}

function globToRegExp(glob: string): RegExp {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const char = glob.charAt(i)
    if (char === '*') {
      if (glob.charAt(i + 1) === '*') {
        source += '.*'
        i++
        if (glob.charAt(i + 1) === '/') i++
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

function toList(pattern: FilterPattern): readonly (string | RegExp)[] {
  return typeof pattern === 'string' || pattern instanceof RegExp ? [pattern] : pattern
}

function matchesAny(pattern: FilterPattern, text: string): boolean {
  return toList(pattern).some((entry) => {
    if (entry instanceof RegExp) {
      entry.lastIndex = 0
      return entry.test(text)
    }
    // A string without a glob character is a path suffix-free exact id, as Rolldown reads it.
    return /[*?]/.test(entry) ? globToRegExp(entry).test(text) : entry === text
  })
}

/** Whether `text` passes `value`: excluded text never does; with an include list it must match. */
export function passesFilter(value: FilterValue | undefined, text: string): boolean {
  if (value === undefined) return true
  if (typeof value === 'string' || value instanceof RegExp || Array.isArray(value)) {
    return matchesAny(value as FilterPattern, text)
  }
  const { include, exclude } = value as {
    readonly include?: FilterPattern
    readonly exclude?: FilterPattern
  }
  if (exclude !== undefined && matchesAny(exclude, text)) return false
  return include === undefined || matchesAny(include, text)
}
