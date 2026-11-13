module.exports = async function globalTeardown() {
  require('node:fs').appendFileSync('order.txt', 'teardown p1\n')
}
