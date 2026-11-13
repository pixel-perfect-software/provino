export function labelledWithBrackets(name: string): string {
  return `[${name}]`
}

export function withoutTheBrackets(text: string): string {
  return text.slice(1, -1)
}
