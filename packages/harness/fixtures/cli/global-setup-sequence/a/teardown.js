module.exports = async function globalTeardown() {
  require('node:fs').appendFileSync('order.txt', 'teardown a\n')
}
