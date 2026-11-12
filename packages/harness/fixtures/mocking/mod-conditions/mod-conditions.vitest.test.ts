const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

/** The module's `who`, or `threw` (the error's text names a machine path). */
const settle = async (load: () => Promise<unknown>): Promise<string> => {
  try {
    return ((await load()) as { who: string }).who
  } catch {
    return 'threw'
  }
}

c('a package with only a require condition is not found', () =>
  settle(() => vi.importActual('require-only')),
)

c('a package with only an import condition is found', () =>
  settle(() => vi.importActual('import-only')),
)
