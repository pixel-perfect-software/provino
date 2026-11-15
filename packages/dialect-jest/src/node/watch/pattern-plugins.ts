// jest-core `plugins/TestPathPattern.ts` L19-L67 and `plugins/TestNamePattern.ts` L19-L64: `p`
// and `t`, a pattern prompt each, whose Enter runs with the pattern in `watch` mode.
import type { JestWatchTerminal } from './context.ts'
import { JestPatternPrompt } from './pattern-prompt.ts'
import { type JestWatchPlugin, nameJestWatchPlugin } from './plugin.ts'
import { JestPrompt } from './prompt.ts'
import { jestActiveFilters } from './usage.ts'

function patternPlugin(
  terminal: JestWatchTerminal,
  key: 'p' | 't',
  prompt: string,
  entity: 'filenames' | 'tests',
  name: string,
): JestWatchPlugin {
  const keys = new JestPrompt(terminal.keys, terminal.resizes)
  return nameJestWatchPlugin(name, {
    isInternal: true,
    getUsageInfo: () => ({ key, prompt }),
    onKey: (pressed) => keys.put(pressed),
    run: (globalConfig, updateConfigAndRun) =>
      new Promise<void>((resolve, reject) => {
        new JestPatternPrompt(terminal, keys, entity).run(
          (value) => {
            updateConfigAndRun(
              key === 'p'
                ? { mode: 'watch', testPathPatterns: [value] }
                : { mode: 'watch', testNamePattern: value },
            )
            resolve()
          },
          reject,
          { header: jestActiveFilters(globalConfig, terminal.style) },
        )
      }),
  })
}

/**
 * `TestPathPatternPlugin`: `p`, `filter by a filename regex pattern`.
 * @beta
 */
export function jestTestPathPatternPlugin(terminal: JestWatchTerminal): JestWatchPlugin {
  return patternPlugin(
    terminal,
    'p',
    'filter by a filename regex pattern',
    'filenames',
    'TestPathPatternPlugin',
  )
}

/**
 * `TestNamePatternPlugin`: `t`, `filter by a test name regex pattern`.
 * @beta
 */
export function jestTestNamePatternPlugin(terminal: JestWatchTerminal): JestWatchPlugin {
  return patternPlugin(
    terminal,
    't',
    'filter by a test name regex pattern',
    'tests',
    'TestNamePatternPlugin',
  )
}
