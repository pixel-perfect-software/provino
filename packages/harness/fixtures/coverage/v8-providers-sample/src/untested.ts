export function neverCalled(flag: boolean): string {
  if (flag) {
    return 'yes'
  }
  return flag ? 'impossible' : 'no'
}

export const alsoNever = (items: readonly number[]): number =>
  items.length > 0 ? items.reduce((sum, item) => sum + item, 0) : -1
