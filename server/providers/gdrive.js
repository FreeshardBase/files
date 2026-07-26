const https = require('https');
const { URL } = require('url');
const { Readable, PassThrough } = require('stream');
const path = require('path');
const BaseProvider = require('./base');

/**
 * GoogleDriveProvider — Google Drive Storage Integration (Issue #7)
 * Implements full BaseProvider interface using Google Drive REST API v3.
 * Supports OAuth 2.0 Refresh Tokens & encrypted credential storage.
 */
class GoogleDriveProvider extends BaseProvider {
  /**
   * @param {object} config
   * @param {string} [config.clientId]
   * @param {string} [config.clientSecret]
   * @param {string} [config.refreshToken]
   * @param {string} [config.accessToken]
   * @param {string} [config.rootFolderId='root']
   */
  constructor(config = {}) {
    super(config);
    this.clientId = config.clientId || process.env.GDRIVE_CLIENT_ID;
    this.clientSecret = config.clientSecret || process.env.GDRIVE_CLIENT_SECRET;
    this.refreshToken = config.refreshToken;
    this.accessToken = config.accessToken;
    this.rootFolderId = config.rootFolderId || 'root';
    this.pathCache = new Map(); // Maps path -> { id, isDirectory, mimeType }
    this.pathCache.set('/', { id: this.rootFolderId, isDirectory: true, mimeType: 'application/vnd.google-apps.folder' });
  }

  /**
   * Refreshes OAuth 2.0 Access Token if expired
   */
  async getValidAccessToken(forceRefresh = false) {
    if (this.accessToken && !forceRefresh) return this.accessToken;
    if (!this.refreshToken || !this.clientId || !this.clientSecret) {
      throw new Error('Google Drive credentials incomplete: refreshToken, clientId, and clientSecret required.');
    }

    const payload = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
      grant_type: 'refresh_token'
    }).toString();

    const response = await this._httpRequest({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, payload);

    const data = JSON.parse(response.body);
    if (!data.access_token) {
      throw new Error(`Google OAuth Token Refresh Failed: ${data.error_description || JSON.stringify(data)}`);
    }

    this.accessToken = data.access_token;
    return this.accessToken;
  }

  /**
   * Helper to make HTTPS requests to Google APIs
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
   * Helper for authenticated Google Drive REST API GET/POST/PATCH/DELETE with 401 auto-retry
   */
  async _driveApi(apiPath, method = 'GET', bodyObj = null, extraHeaders = {}, retryOn401 = true) {
    const token = await this.getValidAccessToken();
    const headers = {
      'Authorization': `Bearer ${token}`,
      ...extraHeaders
    };

    let bodyData = null;
    if (bodyObj && typeof bodyObj === 'object' && !Buffer.isBuffer(bodyObj) && typeof bodyObj.pipe !== 'function') {
      bodyData = JSON.stringify(bodyObj);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyData);
    } else if (bodyObj) {
      bodyData = bodyObj;
    }

    const res = await this._httpRequest({
      hostname: 'www.googleapis.com',
      path: `/drive/v3${apiPath}`,
      method,
      headers
    }, bodyData);

    if (res.statusCode === 401 && retryOn401 && this.refreshToken) {
      this.accessToken = null;
      await this.getValidAccessToken(true);
      return this._driveApi(apiPath, method, bodyObj, extraHeaders, false);
    }

    if (res.statusCode >= 400) {
      throw new Error(`Google Drive API ${method} ${apiPath} failed (${res.statusCode}): ${res.body}`);
    }

    return res;
  }

  /**
   * Resolve a relative file path (e.g. "/Documents/file.txt") to a Google Drive File ID
   */
  async resolvePathToId(targetPath) {
    const cleanPath = targetPath === '/' || !targetPath ? '/' : targetPath.replace(/\/+$/, '');
    if (this.pathCache.has(cleanPath)) {
      return this.pathCache.get(cleanPath);
    }

    const segments = cleanPath.split('/').filter(Boolean);
    let currentId = this.rootFolderId;
    let currentPath = '';

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      currentPath += '/' + segment;

      if (this.pathCache.has(currentPath)) {
        currentId = this.pathCache.get(currentPath).id;
        continue;
      }

      const q = `'${currentId}' in parents and name = '${segment.replace(/'/g, "\\'")}' and trashed = false`;
      const queryUrl = `/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,size,modifiedTime)&pageSize=1`;

      const res = await this._driveApi(queryUrl);
      const data = JSON.parse(res.body);

      if (!data.files || data.files.length === 0) {
        throw new Error(`File or directory not found on Google Drive: "${currentPath}"`);
      }

      const file = data.files[0];
      const isDir = file.mimeType === 'application/vnd.google-apps.folder';
      const itemInfo = { id: file.id, isDirectory: isDir, mimeType: file.mimeType, size: parseInt(file.size || '0', 10), modified: file.modifiedTime };

      this.pathCache.set(currentPath, itemInfo);
      currentId = file.id;
    }

    return this.pathCache.get(cleanPath);
  }

  // ── BaseProvider Implementation ─────────────────────────────────────────────

  async list(dirPath) {
    const dirInfo = await this.resolvePathToId(dirPath);
    if (!dirInfo.isDirectory) {
      throw new Error(`Path "${dirPath}" is a file, not a directory.`);
    }

    const q = `'${dirInfo.id}' in parents and trashed = false`;
    const fields = 'files(id,name,mimeType,size,modifiedTime)';
    const queryUrl = `/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(fields)}&pageSize=1000`;

    const res = await this._driveApi(queryUrl);
    const data = JSON.parse(res.body);
    const files = data.files || [];

    const basePrefix = dirPath === '/' ? '' : dirPath;

    return files.map(file => {
      const isDir = file.mimeType === 'application/vnd.google-apps.folder';
      const itemPath = `${basePrefix}/${file.name}`;
      this.pathCache.set(itemPath, { id: file.id, isDirectory: isDir, mimeType: file.mimeType, size: parseInt(file.size || '0', 10), modified: file.modifiedTime });

      return {
        name: file.name,
        path: itemPath,
        isDirectory: isDir,
        size: parseInt(file.size || '0', 10),
        modified: file.modifiedTime,
        mimeType: file.mimeType
      };
    });
  }

  async read(filePath, retryOn401 = true) {
    const fileInfo = await this.resolvePathToId(filePath);
    if (fileInfo.isDirectory) {
      throw new Error(`Cannot read directory "${filePath}" as a file stream.`);
    }

    const token = await this.getValidAccessToken();
    const downloadUrl = `https://www.googleapis.com/drive/v3/files/${fileInfo.id}?alt=media`;

    return new Promise((resolve, reject) => {
      const req = https.get(downloadUrl, {
        headers: { 'Authorization': `Bearer ${token}` }
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
          return reject(new Error(`Failed to download file from Google Drive (${res.statusCode})`));
        }
        resolve({
          stream: res,
          size: fileInfo.size,
          mimeType: fileInfo.mimeType || 'application/octet-stream'
        });
      });
      req.on('error', reject);
    });
  }

  async write(filePath, dataStream, options = {}, retryOn401 = true) {
    const dirPath = path.dirname(filePath);
    const fileName = path.basename(filePath);
    const parentDirInfo = await this.resolvePathToId(dirPath);

    const token = await this.getValidAccessToken();
    const metadata = {
      name: fileName,
      parents: [parentDirInfo.id],
      mimeType: options.mimeType || 'application/octet-stream'
    };

    // Use Google Drive Resumable Upload protocol for reliable streaming
    const initRes = await this._httpRequest({
      hostname: 'www.googleapis.com',
      path: '/upload/drive/v3/files?uploadType=resumable',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': metadata.mimeType
      }
    }, JSON.stringify(metadata));

    if (initRes.statusCode === 401 && retryOn401 && this.refreshToken) {
      this.accessToken = null;
      await this.getValidAccessToken(true);
      return this.write(filePath, dataStream, options, false);
    }

    if (initRes.statusCode !== 200) {
      throw new Error(`Google Drive Upload Initialization Failed (${initRes.statusCode}): ${initRes.body}`);
    }

    const sessionUrl = initRes.headers['location'];
    if (!sessionUrl) {
      throw new Error('Google Drive Resumable Upload Session URL missing.');
    }

    const urlObj = new URL(sessionUrl);

    // Stream incoming payload to Google Drive upload session
    const uploadRes = await this._httpRequest({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'PUT',
      headers: {
        'Content-Type': metadata.mimeType
      }
    }, dataStream);

    if (uploadRes.statusCode !== 200 && uploadRes.statusCode !== 201) {
      throw new Error(`Google Drive Upload Stream Failed (${uploadRes.statusCode}): ${uploadRes.body}`);
    }

    const fileObj = JSON.parse(uploadRes.body);
    this.pathCache.set(filePath, { id: fileObj.id, isDirectory: false, mimeType: fileObj.mimeType, size: parseInt(fileObj.size || '0', 10) });

    return { path: filePath, size: parseInt(fileObj.size || '0', 10) };
  }

  async mkdir(dirPath) {
    const parentPath = path.dirname(dirPath);
    const folderName = path.basename(dirPath);
    const parentInfo = await this.resolvePathToId(parentPath);

    const metadata = {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentInfo.id]
    };

    const res = await this._driveApi('/files', 'POST', metadata);
    const file = JSON.parse(res.body);

    this.pathCache.set(dirPath, { id: file.id, isDirectory: true, mimeType: file.mimeType });
    return true;
  }

  async delete(targetPath) {
    const itemInfo = await this.resolvePathToId(targetPath);
    await this._driveApi(`/files/${itemInfo.id}`, 'DELETE');
    this.pathCache.delete(targetPath);
    return true;
  }

  async move(srcPath, dstPath) {
    const itemInfo = await this.resolvePathToId(srcPath);
    const newDir = path.dirname(dstPath);
    const newName = path.basename(dstPath);
    const newParentInfo = await this.resolvePathToId(newDir);

    const queryUrl = `/files/${itemInfo.id}?addParents=${newParentInfo.id}&fields=id,parents,name`;
    const res = await this._driveApi(queryUrl, 'PATCH', { name: newName });

    this.pathCache.delete(srcPath);
    const updated = JSON.parse(res.body);
    this.pathCache.set(dstPath, { id: updated.id, isDirectory: itemInfo.isDirectory, mimeType: itemInfo.mimeType });

    return true;
  }

  async copy(srcPath, dstPath) {
    const itemInfo = await this.resolvePathToId(srcPath);
    const newDir = path.dirname(dstPath);
    const newName = path.basename(dstPath);
    const newParentInfo = await this.resolvePathToId(newDir);

    const res = await this._driveApi(`/files/${itemInfo.id}/copy`, 'POST', {
      name: newName,
      parents: [newParentInfo.id]
    });

    const copied = JSON.parse(res.body);
    this.pathCache.set(dstPath, { id: copied.id, isDirectory: itemInfo.isDirectory, mimeType: itemInfo.mimeType });
    return true;
  }

  async metadata(targetPath) {
    const info = await this.resolvePathToId(targetPath);
    return {
      name: path.basename(targetPath),
      path: targetPath,
      isDirectory: info.isDirectory,
      size: info.size || 0,
      modified: info.modified || null,
      mimeType: info.mimeType
    };
  }

  async search(query, basePath = '/') {
    const baseInfo = await this.resolvePathToId(basePath);
    const q = `'${baseInfo.id}' in parents and name contains '${query.replace(/'/g, "\\'")}' and trashed = false`;
    const queryUrl = `/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,size,modifiedTime)`;

    const res = await this._driveApi(queryUrl);
    const data = JSON.parse(res.body);
    const files = data.files || [];

    const basePrefix = basePath === '/' ? '' : basePath;

    return files.map(file => {
      const isDir = file.mimeType === 'application/vnd.google-apps.folder';
      const itemPath = `${basePrefix}/${file.name}`;
      return {
        name: file.name,
        path: itemPath,
        isDirectory: isDir,
        size: parseInt(file.size || '0', 10),
        modified: file.modifiedTime,
        mimeType: file.mimeType
      };
    });
  }
}

module.exports = GoogleDriveProvider;
