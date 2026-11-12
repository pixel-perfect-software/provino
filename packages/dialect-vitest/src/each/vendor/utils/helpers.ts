// provino: an extract of @vitest/utils 5.0.5 `src/helpers.ts` (`toArray` L129-L137, `isObject`
// L139-L141, `objectAttr` L235-L246, `isNegativeNaN` L313-L323), bodies unchanged, with the two
// types they use from `src/types.ts` (L2-L3). `formatTitle` needs only these four.

export type Nullable<T> = T | null | undefined
export type Arrayable<T> = T | Array<T>

export function toArray<T>(array?: Nullable<Arrayable<T>>): Array<T> {
  array ??= []

  if (Array.isArray(array)) {
    return array
  }

  return [array]
}

export function isObject(item: unknown): boolean {
  return item != null && typeof item === 'object' && !Array.isArray(item)
}

export function objectAttr(source: any, path: string, defaultValue = undefined): any {
  // a[3].b -> a.3.b
  const paths = path.replace(/\[(\d+)\]/g, '.$1').split('.')
  let result = source
  for (const p of paths) {
    result = (new Object(result) as any)[p]
    if (result === undefined) {
      return defaultValue
    }
  }
  return result
}

export function isNegativeNaN(val: number): boolean {
  if (!Number.isNaN(val)) {
    return false
  }
  const f64 = new Float64Array(1)
  f64[0] = val
  const u32 = new Uint32Array(f64.buffer)
  const isNegative = u32[1] >>> 31 === 1

  return isNegative
}
