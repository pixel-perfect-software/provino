export const TOOL: unique symbol = Symbol.for('mod-automock-symbol-keys.tool')

export const tools = {
  plain(): string {
    return 'real-plain'
  },
  [TOOL](): string {
    return 'real-symbol'
  },
}
