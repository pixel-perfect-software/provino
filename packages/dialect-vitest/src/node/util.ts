// Small helpers the reader's files share.
import { statSync } from 'node:fs'
import { resolve } from 'node:path'

/** A plain object's shape. */
export type Rec = Record<string, unknown>

/** Whether `value` is a plain object (not an array, a RegExp, a Date, `null`). */
export function isRec(value: unknown): value is Rec {
  return Object.prototype.toString.call(value) === '[object Object]'
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The first of `candidates` (names under `root`) that is a file, as a path. */
export function firstExisting(root: string, candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    const path = resolve(root, candidate)
    if (isFile(path)) return path
  }
  return undefined
}
