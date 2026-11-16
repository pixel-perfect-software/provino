// The module the test mocks. Its factory replaces it whole, so this file is never loaded.
export function pathname(): string {
  return 'real'
}

export function label(): string {
  return 'real'
}
