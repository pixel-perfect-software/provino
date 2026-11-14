#!/usr/bin/env node
export function main(args: readonly string[]): number {
  if (args.length === 0) {
    return 1
  }
  return 0
}

export interface Options {
  readonly verbose: boolean
}
