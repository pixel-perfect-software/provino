// A mock error keeps upstream's class and name, because goldens observe them, and carries a stable
// `code` so tests and tools needn't read the text.

/**
 * An `Error` from the mock engine; its `name` stays `Error`.
 * @public
 */
export class MockError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/**
 * A `TypeError` from the mock engine; its `name` stays `TypeError`.
 * @public
 */
export class MockTypeError extends TypeError {
  readonly code: string

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}
