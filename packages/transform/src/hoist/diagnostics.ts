// Hoisting violations as diagnostics (not throws): the text comes from the policy, the position
// and code frame from the code the hoister was given.
import type { HoistErrorCode, HoistPolicy, TransformDiagnostic } from '@provino/types'
import { positionOf } from '../internal/position.ts'

/** A few lines around `offset`, numbered, with a caret under the column. */
export function codeFrame(code: string, offset: number): string {
  const { line, column } = positionOf(code, offset)
  const lines = code.split('\n')
  const first = Math.max(1, line - 2)
  const last = Math.min(lines.length, line + 2)
  const width = String(last).length
  const out: string[] = []
  for (let n = first; n <= last; n++) {
    out.push(`${n === line ? '>' : ' '} ${String(n).padStart(width)} | ${lines[n - 1] ?? ''}`)
    if (n === line) out.push(`  ${' '.repeat(width)} | ${' '.repeat(column - 1)}^`)
  }
  return out.join('\n')
}

export interface DiagnosticVars {
  /** The call as written, `jest.mock`. */
  readonly call: string
  /** The offending identifier, where one exists. */
  readonly name?: string
}

/**
 * An error diagnostic worded by the policy, in the text of `errorCode` unless `text` names another
 * of the policy's messages. One pass with a replacer: a name like `$$x` is not a replacement
 * pattern, and a filled-in value is not read again.
 */
export function hoistDiagnostic(
  policy: HoistPolicy,
  code: string,
  offset: number,
  errorCode: HoistErrorCode,
  vars: DiagnosticVars,
  text: keyof HoistPolicy['messages'] = errorCode,
): TransformDiagnostic {
  const message = policy.messages[text].replace(/\{(call|name)\}/g, (_, slot: string) =>
    slot === 'call' ? vars.call : (vars.name ?? ''),
  )
  return {
    severity: 'error',
    code: errorCode,
    message,
    loc: positionOf(code, offset),
    codeFrame: codeFrame(code, offset),
  }
}
