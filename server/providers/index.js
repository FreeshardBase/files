const BaseProvider = require('./base');
const LocalProvider = require('./local');
const GoogleDriveProvider = require('./gdrive');
const DropboxProvider = require('./dropbox');
const MOVEitProvider = require('./MOVEitProvider');

const providers = {
  local: LocalProvider,
  gdrive: GoogleDriveProvider,
  dropbox: DropboxProvider,
  moveit: MOVEitProvider
};

/**
 * Factory function to instantiate provider by type
 * @param {string} type - Provider type identifier (e.g. 'local', 'gdrive', 'dropbox', 'moveit')
 * @param {object} config - Configuration object
 * @returns {BaseProvider}
 */
function getProvider(type, config = {}) {
  const ProviderClass = providers[type.toLowerCase()];
  if (!ProviderClass) {
    throw new Error(`Unsupported provider type: "${type}"`);
  }
  return new ProviderClass(config);
}

module.exports = {
  BaseProvider,
  LocalProvider,
  GoogleDriveProvider,
  DropboxProvider,
  MOVEitProvider,
  providers,
  getProvider
};
