module.exports = async function globalTeardown(): Promise<void> {
  throw new Error('teardown failed')
}
