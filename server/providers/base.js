/**
 * Abstract Base Storage Provider Interface (Issue #4, #7, #24 Risk 3, #26, #56)
 * Every cloud and local storage provider MUST extend this class and fulfill its contract.
 *
 * Multi-Account Invariant:
 * Every storage provider MUST support arbitrary N active connection instances per user
 * in the SQLite `provider_connections` table, referenced by unique connection ID (`id`)
 * and labeled with unique account identifiers (e.g. `Google Drive (user@gmail.com)`,
 * `Dropbox (work@domain.com)`, `WebDAV (https://nc.example.com)`).
 */
class BaseProvider {
  constructor(config = {}) {
    this.config = config;
  }

  /**
   * List directory contents
   * @param {string} dirPath - Path relative to provider root
   * @returns {Promise<Array<{ name: string, path: string, isDirectory: boolean, size: number, modified: string|null, mimeType: string|null }>>}
   */
  async list(dirPath) {
    throw new Error('BaseProvider.list() must be implemented by subclass');
  }

  /**
   * Read file content as a ReadableStream
   * @param {string} filePath - Path relative to provider root
   * @returns {Promise<{ stream: import('stream').Readable, size: number, mimeType: string }>}
   */
  async read(filePath) {
    throw new Error('BaseProvider.read() must be implemented by subclass');
  }

  /**
   * Write data from a stream to a target path (Stream-through, atomic)
   * @param {string} filePath - Path relative to provider root
   * @param {import('stream').Readable} dataStream - Incoming stream
   * @param {object} [options] - Options ({ size?: number, mimeType?: string })
   * @returns {Promise<{ path: string, size: number }>}
   */
  async write(filePath, dataStream, options = {}) {
    throw new Error('BaseProvider.write() must be implemented by subclass');
  }

  /**
   * Delete a file or directory (recursive)
   * @param {string} targetPath - Path relative to provider root
   * @returns {Promise<boolean>}
   */
  async delete(targetPath) {
    throw new Error('BaseProvider.delete() must be implemented by subclass');
  }

  /**
   * Move or rename a file/directory
   * @param {string} srcPath - Source path relative to provider root
   * @param {string} dstPath - Destination path relative to provider root
   * @returns {Promise<boolean>}
   */
  async move(srcPath, dstPath) {
    throw new Error('BaseProvider.move() must be implemented by subclass');
  }

  /**
   * Copy a file or directory
   * @param {string} srcPath - Source path relative to provider root
   * @param {string} dstPath - Destination path relative to provider root
   * @returns {Promise<boolean>}
   */
  async copy(srcPath, dstPath) {
    throw new Error('BaseProvider.copy() must be implemented by subclass');
  }

  /**
   * Get metadata for a file or directory
   * @param {string} targetPath - Path relative to provider root
   * @returns {Promise<{ name: string, path: string, isDirectory: boolean, size: number, modified: string, mimeType: string|null }>}
   */
  async metadata(targetPath) {
    throw new Error('BaseProvider.metadata() must be implemented by subclass');
  }

  /**
   * Create a new directory
   * @param {string} dirPath - Path relative to provider root
   * @returns {Promise<boolean>}
   */
  async mkdir(dirPath) {
    throw new Error('BaseProvider.mkdir() must be implemented by subclass');
  }

  /**
   * Search files by name pattern
   * @param {string} query - Search string
   * @param {string} [basePath='/'] - Search start path
   * @returns {Promise<Array<{ name: string, path: string, isDirectory: boolean, size: number, modified: string }>>}
   */
  async search(query, basePath = '/') {
    throw new Error('BaseProvider.search() must be implemented by subclass');
  }

  /**
   * Get a temporary direct-download URL (for cloud providers)
   * @param {string} filePath - Path relative to provider root
   * @returns {Promise<string|null>} Direct URL or null if proxied
   */
  async getDirectUrl(filePath) {
    return null;
  }
}

module.exports = BaseProvider;
