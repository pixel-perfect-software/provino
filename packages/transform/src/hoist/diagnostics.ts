// Hoisting violations as diagnostics (not throws): the text comes from the policy, the position
// and code frame from the code the hoister was given.
import type { HoistErrorCode, HoistPolicy, TransformDiagnostic } from '@provino/types'

export interface Position {
  readonly line: number
  readonly column: number
}

/** 1-based line and column of a UTF-16 offset, as the pipeline reports positions. */
export function positionOf(code: string, offset: number): Position {
  let line = 1
  let lineStart = 0
  for (let i = code.indexOf('\n'); i !== -1 && i < offset; i = code.indexOf('\n', i + 1)) {
    line++
    lineStart = i + 1
  }
  return { line, column: offset - lineStart + 1 }
}

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

/** An error diagnostic worded by the policy. */
export function hoistDiagnostic(
  policy: HoistPolicy,
  code: string,
  offset: number,
  errorCode: HoistErrorCode,
  vars: DiagnosticVars,
): TransformDiagnostic {
  const message = policy.messages[errorCode]
    .replaceAll('{call}', vars.call)
    .replaceAll('{name}', vars.name ?? '')
  return {
    severity: 'error',
    code: errorCode,
    message,
    loc: positionOf(code, offset),
    codeFrame: codeFrame(code, offset),
  }
}
