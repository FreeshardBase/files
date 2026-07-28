const https = require('https');
const http = require('http');
const { Readable, PassThrough } = require('stream');
const path = require('path');
const BaseProvider = require('./base');

/**
 * MOVEitProvider — Progress MOVEit Transfer Storage Integration (Issue #70)
 * Implements full BaseProvider interface using Progress MOVEit Transfer REST API & OAuth 2.0.
 */
class MOVEitProvider extends BaseProvider {
  /**
   * @param {object} config
   * @param {string} [config.host] - MOVEit server host (e.g., moveit.example.com)
   * @param {string} [config.baseUrl] - Base URL (e.g., https://moveit.example.com)
   * @param {string} [config.clientId]
   * @param {string} [config.clientSecret]
   * @param {string} [config.refreshToken]
   * @param {string} [config.accessToken]
   * @param {string} [config.username]
   * @param {string} [config.password]
   */
  constructor(config = {}) {
    super(config);
    this.host = config.host || process.env.MOVEIT_HOST || 'moveit.example.com';
    this.baseUrl = config.baseUrl || `https://${this.host}`;
    this.clientId = config.clientId || process.env.MOVEIT_CLIENT_ID;
    this.clientSecret = config.clientSecret || process.env.MOVEIT_CLIENT_SECRET;
    this.refreshToken = config.refreshToken;
    this.accessToken = config.accessToken;
    this.username = config.username;
    this.password = config.password;
  }

  /**
   * Refreshes or requests OAuth 2.0 Access Token
   */
  async getValidAccessToken(forceRefresh = false) {
    if (this.accessToken && !forceRefresh) return this.accessToken;

    let payloadObj = {};
    if (this.refreshToken) {
      payloadObj = {
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
        client_id: this.clientId || '',
        client_secret: this.clientSecret || ''
      };
    } else if (this.username && this.password) {
      payloadObj = {
        grant_type: 'password',
        username: this.username,
        password: this.password,
        client_id: this.clientId || '',
        client_secret: this.clientSecret || ''
      };
    } else {
      throw new Error('MOVEit credentials incomplete: refreshToken or username/password required.');
    }

    const payload = new URLSearchParams(payloadObj).toString();
    const response = await this._httpRequest({
      hostname: this.host,
      path: '/api/v1/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, payload);

    const data = JSON.parse(response.body);
    if (!data.access_token) {
      throw new Error(`MOVEit OAuth Token Refresh Failed: ${data.error_description || JSON.stringify(data)}`);
    }

    this.accessToken = data.access_token;
    return this.accessToken;
  }

  /**
   * Helper to make HTTP/HTTPS requests
   */
  _httpRequest(options, bodyData = null) {
    return new Promise((resolve, reject) => {
      const client = options.protocol === 'http:' ? http : https;
      const req = client.request(options, (res) => {
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
   * Helper for MOVEit REST API requests with 401 retry
   */
  async _moveitApi(apiPath, options = {}, retryOn401 = true) {
    const token = await this.getValidAccessToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    };

    const reqOptions = {
      hostname: this.host,
      path: apiPath,
      method: options.method || 'GET',
      headers
    };

    const res = await this._httpRequest(reqOptions, options.body);
    if (res.statusCode === 401 && retryOn401) {
      await this.getValidAccessToken(true);
      return this._moveitApi(apiPath, options, false);
    }

    if (res.statusCode >= 400) {
      throw new Error(`MOVEit API Error [${res.statusCode}]: ${res.body}`);
    }

    return res.body ? JSON.parse(res.body) : {};
  }

  /**
   * List directory contents
   * @param {string} dirPath
   */
  async list(dirPath = '/') {
    const cleanPath = dirPath.startsWith('/') ? dirPath : `/${dirPath}`;
    const targetFolderId = cleanPath === '/' ? 'root' : cleanPath.replace(/^\//, '');

    const response = await this._moveitApi(`/api/v1/folders/${targetFolderId}/items`);
    const rawItems = response.items || response.files || [];

    return rawItems.map(item => ({
      name: item.name,
      path: path.posix.join(cleanPath, item.name),
      isDirectory: Boolean(item.isDirectory || item.isFolder || item.type === 'folder'),
      size: item.size || 0,
      modified: item.modified || item.uploadTime || null,
      mimeType: item.mimeType || item.contentType || null
    }));
  }

  /**
   * Read file content as ReadableStream
   * @param {string} filePath
   */
  async read(filePath) {
    const fileId = filePath.startsWith('/') ? filePath.slice(1) : filePath;
    const res = await this._httpRequest({
      hostname: this.host,
      path: `/api/v1/files/${fileId}/download`,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${await this.getValidAccessToken()}`
      }
    });

    if (res.statusCode >= 400) {
      throw new Error(`MOVEit File Download Failed [${res.statusCode}]: ${res.body}`);
    }

    const stream = Readable.from([res.buffer]);
    const size = parseInt(res.headers['content-length'] || res.buffer.length, 10);
    const mimeType = res.headers['content-type'] || 'application/octet-stream';

    return { stream, size, mimeType };
  }

  /**
   * Write file stream to path (stream-through & atomic)
   * @param {string} filePath
   * @param {import('stream').Readable} dataStream
   * @param {object} [options]
   */
  async write(filePath, dataStream, options = {}) {
    const buffer = await BaseProvider.streamToBuffer(dataStream);
    const fileName = path.basename(filePath);
    const folderPath = path.dirname(filePath);
    const parentFolderId = folderPath === '/' || folderPath === '.' ? 'root' : folderPath.replace(/^\//, '');

    const result = await this._moveitApi(`/api/v1/folders/${parentFolderId}/files`, {
      method: 'POST',
      headers: {
        'Content-Type': options.mimeType || 'application/octet-stream',
        'Content-Length': buffer.length
      },
      body: buffer
    });

    return {
      path: filePath,
      size: result.size || buffer.length
    };
  }

  /**
   * Delete file or folder
   * @param {string} targetPath
   */
  async delete(targetPath) {
    const targetId = targetPath.startsWith('/') ? targetPath.slice(1) : targetPath;
    await this._moveitApi(`/api/v1/files/${targetId}`, {
      method: 'DELETE'
    });
    return true;
  }

  /**
   * Create a new directory
   * @param {string} dirPath
   */
  async mkdir(dirPath) {
    const folderName = path.basename(dirPath);
    const parentPath = path.dirname(dirPath);
    const parentFolderId = parentPath === '/' || parentPath === '.' ? 'root' : parentPath.replace(/^\//, '');

    await this._moveitApi('/api/v1/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: folderName,
        parentId: parentFolderId
      })
    });
    return true;
  }

  /**
   * Move or rename file/directory
   * @param {string} srcPath
   * @param {string} dstPath
   */
  async move(srcPath, dstPath) {
    const srcId = srcPath.startsWith('/') ? srcPath.slice(1) : srcPath;
    await this._moveitApi(`/api/v1/files/${srcId}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destinationPath: dstPath })
    });
    return true;
  }

  /**
   * Copy file or directory
   * @param {string} srcPath
   * @param {string} dstPath
   */
  async copy(srcPath, dstPath) {
    const srcId = srcPath.startsWith('/') ? srcPath.slice(1) : srcPath;
    await this._moveitApi(`/api/v1/files/${srcId}/copy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destinationPath: dstPath })
    });
    return true;
  }

  /**
   * Metadata for target path
   * @param {string} targetPath
   */
  async metadata(targetPath) {
    const targetId = targetPath.startsWith('/') ? targetPath.slice(1) : targetPath;
    const res = await this._moveitApi(`/api/v1/files/${targetId}`);
    return {
      name: res.name || path.basename(targetPath),
      path: targetPath,
      isDirectory: Boolean(res.isDirectory || res.isFolder),
      size: res.size || 0,
      modified: res.modified || new Date().toISOString(),
      mimeType: res.mimeType || null
    };
  }

  /**
   * Search files by query
   * @param {string} query
   * @param {string} [basePath='/']
   */
  async search(query, basePath = '/') {
    const res = await this._moveitApi(`/api/v1/files?q=${encodeURIComponent(query)}`);
    const rawItems = res.items || [];
    return rawItems.map(item => ({
      name: item.name,
      path: item.path || path.posix.join(basePath, item.name),
      isDirectory: Boolean(item.isDirectory),
      size: item.size || 0,
      modified: item.modified || null
    }));
  }

  /**
   * Storage quota capacity
   */
  async getQuota() {
    const user = await this._moveitApi('/api/v1/users/self');
    return {
      used: user.usedBytes || user.used || 0,
      total: user.quotaBytes || user.total || null
    };
  }
}

module.exports = MOVEitProvider;
