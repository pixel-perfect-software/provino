// Checks `define` values the way the pipeline reads them: one probe through Oxc's own define
// handling, so a value is accepted exactly when the pipeline accepts it.
import { transformSync } from 'oxc-transform'

/**
 * The keys of `define` whose replacement Oxc refuses (a value that is not one expression, such as
 * `'1 +'` or `'a; b'`), each with Oxc's reason. A refused value fails every transformed file, so
 * the coordinator asks once before any worker starts. Empty when every value is accepted.
 * @public
 */
export function refusedDefines(define: Readonly<Record<string, string>>): Record<string, string> {
  const refused: Record<string, string> = Object.create(null)
  for (const [key, replacement] of Object.entries(define)) {
    const { errors } = transformSync('define-probe.ts', `void (${key})\n`, {
      define: { [key]: replacement },
    })
    const [first] = errors
    if (first !== undefined) refused[key] = first.message
  }
  return refused
}
