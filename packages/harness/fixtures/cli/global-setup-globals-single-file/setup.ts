module.exports = async function globalSetup(): Promise<void> {
  ;(globalThis as Record<string, unknown>).fromGlobalSetup = 'set by the setup'
}
