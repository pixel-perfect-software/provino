// b's hook, and c's as well: it runs once, with the config of the first test that names it.
module.exports = async function globalSetup(globalConfig, projectConfig) {
  require('node:fs').appendFileSync(
    'order.txt',
    `setup shared (projectConfig ${projectConfig.displayName.name})\n`,
  )
}
