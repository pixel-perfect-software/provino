// Kept apart from the formatter so the dialect's root entry, which the coordinator loads, reads one
// number and not the vendored formatter, which only the worker needs.

/**
 * How many characters of a value Vitest keeps in a `.each` title (`taskTitleValueFormatTruncate`,
 * 40 by default). A behaviour function takes no policy, so `formatEachTitle` holds this number
 * itself, and `vitestPolicy.core.eachTitleTruncate` is the same constant.
 * @public
 */
export const VITEST_EACH_TITLE_TRUNCATE: number = 40
