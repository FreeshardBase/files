const https = require('https');
const { Readable, PassThrough } = require('stream');
const path = require('path');
const BaseProvider = require('./base');

/**
 * DropboxProvider — Dropbox Storage Integration (Issue #56)
 * Implements full BaseProvider interface using Dropbox REST API v2.
 * Supports OAuth 2.0 Refresh Tokens & encrypted credential storage.
 */
class DropboxProvider extends BaseProvider {
  /**
   * @param {object} config
   * @param {string} [config.clientId]
   * @param {string} [config.clientSecret]
   * @param {string} [config.refreshToken]
   * @param {string} [config.accessToken]
   */
  constructor(config = {}) {
    super(config);
    this.clientId = config.clientId || process.env.DROPBOX_CLIENT_ID;
    this.clientSecret = config.clientSecret || process.env.DROPBOX_CLIENT_SECRET;
    this.refreshToken = config.refreshToken;
    this.accessToken = config.accessToken;
  }

  /**
   * Refreshes OAuth 2.0 Access Token if expired
   */
  async getValidAccessToken(forceRefresh = false) {
    if (this.accessToken && !forceRefresh) return this.accessToken;
    if (!this.refreshToken || !this.clientId || !this.clientSecret) {
      throw new Error('Dropbox credentials incomplete: refreshToken, clientId, and clientSecret required.');
    }

    const payload = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
      grant_type: 'refresh_token'
    }).toString();

    const response = await this._httpRequest({
      hostname: 'api.dropboxapi.com',
      path: '/oauth2/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, payload);

    const data = JSON.parse(response.body);
    if (!data.access_token) {
      throw new Error(`Dropbox OAuth Token Refresh Failed: ${data.error_description || JSON.stringify(data)}`);
    }

    this.accessToken = data.access_token;
    return this.accessToken;
  }

  /**
   * Helper to make HTTPS requests
   */
  _httpRequest(options, bodyData = null) {
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: buffer.toString('utf8'),
            buffer
          });
        });
      });

      req.on('error', reject);

      if (bodyData) {
        if (Buffer.isBuffer(bodyData) || typeof bodyData === 'string') {
          req.write(bodyData);
          req.end();
        } else if (typeof bodyData.pipe === 'function') {
          bodyData.pipe(req);
        }
      } else {
        req.end();
      }
    });
  }

  /**
   * Helper for Dropbox RPC API calls (api.dropboxapi.com) with 401 auto-retry
   */
  async _dropboxRpcApi(apiPath, bodyObj = {}, retryOn401 = true) {
    const token = await this.getValidAccessToken();
    const bodyData = JSON.stringify(bodyObj);

    const res = await this._httpRequest({
      hostname: 'api.dropboxapi.com',
      path: `/2${apiPath}`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyData)
      }
    }, bodyData);

    if (res.statusCode === 401 && retryOn401 && this.refreshToken) {
      this.accessToken = null;
      await this.getValidAccessToken(true);
      return this._dropboxRpcApi(apiPath, bodyObj, false);
    }

    if (res.statusCode >= 400) {
      throw new Error(`Dropbox API ${apiPath} failed (${res.statusCode}): ${res.body}`);
    }

    return res;
  }

  // ── BaseProvider Implementation ─────────────────────────────────────────────

  async list(dirPath) {
    const cleanPath = dirPath === '/' || !dirPath ? '' : dirPath.replace(/\/+$/, '');
    const res = await this._dropboxRpcApi('/files/list_folder', {
      path: cleanPath,
      recursive: false,
      include_media_info: false
    });

    const data = JSON.parse(res.body);
    const entries = data.entries || [];

    return entries.map(item => {
      const isDir = item['.tag'] === 'folder';
      return {
        name: item.name,
        path: item.path_display,
        isDirectory: isDir,
        size: isDir ? 0 : (item.size || 0),
        modified: item.server_modified || null,
        mimeType: isDir ? 'cloud/folder' : 'application/octet-stream'
      };
    });
  }

  /**
   * Helper to format Dropbox-API-Arg header safely for UTF-8 / non-ASCII paths (RFC 5987 compliance)
   */
  _formatApiArg(obj) {
    return JSON.stringify(obj).replace(/[\u007f-\uffff]/g, (c) => '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4));
  }

  async read(filePath, retryOn401 = true) {
    const token = await this.getValidAccessToken();
    const argHeader = this._formatApiArg({ path: filePath });

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'content.dropboxapi.com',
        path: '/2/files/download',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Dropbox-API-Arg': argHeader
        }
      }, async (res) => {
        if (res.statusCode === 401 && retryOn401 && this.refreshToken) {
          this.accessToken = null;
          try {
            await this.getValidAccessToken(true);
            const retryResult = await this.read(filePath, false);
            return resolve(retryResult);
          } catch (e) {
            return reject(e);
          }
        }

        if (res.statusCode >= 400) {
          let errBody = '';
          res.on('data', chunk => errBody += chunk);
          res.on('end', () => reject(new Error(`Dropbox Download Failed (${res.statusCode}): ${errBody}`)));
          return;
        }

        const resultHeader = res.headers['dropbox-api-result'];
        let meta = {};
        if (resultHeader) {
          try { meta = JSON.parse(resultHeader); } catch (e) {}
        }

        resolve({
          stream: res,
          size: meta.size || 0,
          mimeType: 'application/octet-stream'
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  async write(filePath, dataStream, options = {}, retryOn401 = true) {
    const bufferData = await BaseProvider.streamToBuffer(dataStream);
    const token = await this.getValidAccessToken();
    const argHeader = this._formatApiArg({
      path: filePath,
      mode: 'overwrite',
      autorename: false,
      mute: false
    });

    const uploadRes = await this._httpRequest({
      hostname: 'content.dropboxapi.com',
      path: '/2/files/upload',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Dropbox-API-Arg': argHeader,
        'Content-Type': 'application/octet-stream',
        'Content-Length': bufferData.length
      }
    }, bufferData);

    if (uploadRes.statusCode === 401 && retryOn401 && this.refreshToken) {
      this.accessToken = null;
      await this.getValidAccessToken(true);
      return this.write(filePath, bufferData, options, false);
    }

    if (uploadRes.statusCode >= 400) {
      throw new Error(`Dropbox Upload Stream Failed (${uploadRes.statusCode}): ${uploadRes.body}`);
    }

    const fileMeta = JSON.parse(uploadRes.body);
    return { path: fileMeta.path_display, size: fileMeta.size || bufferData.length };
  }

  async mkdir(dirPath) {
    await this._dropboxRpcApi('/files/create_folder_v2', {
      path: dirPath,
      autorename: false
    });
    return true;
  }

  async delete(targetPath) {
    await this._dropboxRpcApi('/files/delete_v2', {
      path: targetPath
    });
    return true;
  }

  async move(srcPath, dstPath) {
    await this._dropboxRpcApi('/files/move_v2', {
      from_path: srcPath,
      to_path: dstPath
    });
    return true;
  }

  async copy(srcPath, dstPath) {
    await this._dropboxRpcApi('/files/copy_v2', {
      from_path: srcPath,
      to_path: dstPath
    });
    return true;
  }

  async metadata(targetPath) {
    const res = await this._dropboxRpcApi('/files/get_metadata', {
      path: targetPath
    });
    const meta = JSON.parse(res.body);
    const isDir = meta['.tag'] === 'folder';

    return {
      name: meta.name,
      path: meta.path_display,
      isDirectory: isDir,
      size: isDir ? 0 : (meta.size || 0),
      modified: meta.server_modified || null,
      mimeType: isDir ? 'cloud/folder' : 'application/octet-stream'
    };
  }

  async search(query, basePath = '/') {
    const cleanPath = basePath === '/' || !basePath ? '' : basePath.replace(/\/+$/, '');
    const res = await this._dropboxRpcApi('/files/search_v2', {
      query,
      options: {
        path: cleanPath
      }
    });

    const data = JSON.parse(res.body);
    const matches = data.matches || [];

    return matches.map(m => {
      const metadata = m.metadata && m.metadata.metadata ? m.metadata.metadata : {};
      const isDir = metadata['.tag'] === 'folder';
      return {
        name: metadata.name || '',
        path: metadata.path_display || '',
        isDirectory: isDir,
        size: isDir ? 0 : (metadata.size || 0),
        modified: metadata.server_modified || null,
        mimeType: isDir ? 'cloud/folder' : 'application/octet-stream'
      };
    });
  }
}

module.exports = DropboxProvider;
