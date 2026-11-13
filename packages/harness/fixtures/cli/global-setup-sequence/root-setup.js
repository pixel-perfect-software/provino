module.exports = async function rootSetup(_globalConfig, projectConfig) {
  require('node:fs').appendFileSync(
    'order.txt',
    `setup root (projectConfig ${projectConfig.displayName.name})\n`,
  )
}
