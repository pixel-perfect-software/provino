import { base } from './base.ts'

export const value = `${base}-target`
export default function describeTarget(): string {
  return `default of ${value}`
}
