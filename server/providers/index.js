const BaseProvider = require('./base');
const LocalProvider = require('./local');
const GoogleDriveProvider = require('./gdrive');
const DropboxProvider = require('./dropbox');
const MOVEitProvider = require('./MOVEitProvider');
const FailoverProvider = require('./failover');
const S3Provider = require('./s3');
const OneDriveProvider = require('./onedrive');
const SharePointProvider = require('./sharepoint');

const providers = {
  local: LocalProvider,
  gdrive: GoogleDriveProvider,
  dropbox: DropboxProvider,
  moveit: MOVEitProvider,
  failover: FailoverProvider,
  s3: S3Provider,
  onedrive: OneDriveProvider,
  sharepoint: SharePointProvider
};

/**
 * Factory function to instantiate provider by type
 * @param {string} type - Provider type identifier (e.g. 'local', 'gdrive', 'dropbox', 'moveit', 's3', 'onedrive', 'sharepoint')
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
  FailoverProvider,
  S3Provider,
  OneDriveProvider,
  SharePointProvider,
  providers,
  getProvider
};


