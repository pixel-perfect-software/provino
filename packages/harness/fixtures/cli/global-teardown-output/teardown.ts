module.exports = async function globalTeardown(): Promise<void> {
  process.stderr.write('teardown ran\n')
}
