const BaseProvider = require('./base');
const https = require('https');

/**
 * Microsoft SharePoint Document Library Storage Provider via MS Graph API (#82)
 */
class SharePointProvider extends BaseProvider {
  constructor(config = {}) {
    super(config);
    this.clientId = config.clientId || process.env.SHAREPOINT_CLIENT_ID || process.env.MSGRAPH_CLIENT_ID;
    this.clientSecret = config.clientSecret || process.env.SHAREPOINT_CLIENT_SECRET || process.env.MSGRAPH_CLIENT_SECRET;
    this.refreshToken = config.refreshToken;
    this.accessToken = config.accessToken;
    this.tenantId = config.tenantId || process.env.MSGRAPH_TENANT_ID || 'common';
    this.siteId = config.siteId;
    this.driveId = config.driveId;
    this.accountEmail = config.accountEmail || null;
  }

  async getValidAccessToken() {
    if (this.accessToken) return this.accessToken;
    if (!this.refreshToken) {
      throw new Error('SharePointProvider error: Missing refreshToken in connection credentials.');
    }

    const postData = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
      grant_type: 'refresh_token',
      scope: 'offline_access Sites.ReadWrite.All Files.ReadWrite.All User.Read'
    }).toString();

    const res = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'login.microsoftonline.com',
        path: `/${encodeURIComponent(this.tenantId)}/oauth2/v2.0/token`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (resStream) => {
        let body = '';
        resStream.on('data', chunk => body += chunk);
        resStream.on('end', () => resolve({ statusCode: resStream.statusCode, body }));
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });

    const parsed = JSON.parse(res.body);
    if (!parsed.access_token) {
      throw new Error(`Failed to refresh SharePoint access token: ${parsed.error_description || res.body}`);
    }

    this.accessToken = parsed.access_token;
    return this.accessToken;
  }

  _getDrivePrefix() {
    if (this.driveId) return `/drives/${this.driveId}`;
    if (this.siteId) return `/sites/${this.siteId}/drive`;
    return '/me/drive';
  }

  async _graphApi(apiPath, method = 'GET', body = null, extraHeaders = {}) {
    const token = await this.getValidAccessToken();
    return new Promise((resolve, reject) => {
      let payload = null;
      const headers = {
        'Authorization': `Bearer ${token}`,
        ...extraHeaders
      };

      if (body) {
        if (Buffer.isBuffer(body)) {
          payload = body;
        } else if (typeof body === 'object') {
          payload = JSON.stringify(body);
          headers['Content-Type'] = headers['Content-Type'] || 'application/json';
        } else {
          payload = String(body);
        }
        headers['Content-Length'] = Buffer.byteLength(payload);
      }

      const req = https.request({
        hostname: 'graph.microsoft.com',
        path: `/v1.0${apiPath}`,
        method,
        headers
      }, (resStream) => {
        if (extraHeaders.rawStream) {
          return resolve({ stream: resStream, statusCode: resStream.statusCode, headers: resStream.headers });
        }
        let resBody = '';
        resStream.on('data', chunk => resBody += chunk);
        resStream.on('end', () => {
          if (resStream.statusCode >= 400) {
            return reject(new Error(`MS Graph SharePoint API Error (${resStream.statusCode}): ${resBody}`));
          }
          try {
            resolve(resBody ? JSON.parse(resBody) : {});
          } catch (e) {
            resolve(resBody);
          }
        });
      });

      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  _normalizePath(p) {
    if (!p || p === '/') return '';
    return p.startsWith('/') ? p : '/' + p;
  }

  _formatItem(item, fullOrParentPath = '') {
    const isDir = Boolean(item.folder);
    let itemPath;
    if (!fullOrParentPath || fullOrParentPath === '/') {
      itemPath = '/' + item.name;
    } else if (fullOrParentPath.endsWith('/' + item.name) || fullOrParentPath === item.name) {
      itemPath = fullOrParentPath.startsWith('/') ? fullOrParentPath : '/' + fullOrParentPath;
    } else {
      const parent = fullOrParentPath.endsWith('/') ? fullOrParentPath.slice(0, -1) : fullOrParentPath;
      itemPath = `${parent}/${item.name}`;
    }
    return {
      name: item.name,
      path: itemPath,
      isDirectory: isDir,
      size: item.size || 0,
      modified: item.lastModifiedDateTime || item.createdDateTime || null,
      mimeType: isDir ? null : (item.file?.mimeType || 'application/octet-stream')
    };
  }

  async list(dirPath = '/') {
    const norm = this._normalizePath(dirPath);
    const prefix = this._getDrivePrefix();
    const apiPath = norm === '' ? `${prefix}/root/children` : `${prefix}/root:${encodeURI(norm)}:/children`;
    const res = await this._graphApi(apiPath);
    const children = res.value || [];
    return children.map(item => this._formatItem(item, dirPath));
  }

  async read(filePath) {
    const norm = this._normalizePath(filePath);
    const prefix = this._getDrivePrefix();
    const apiPath = `${prefix}/root:${encodeURI(norm)}:/content`;
    const { stream, statusCode, headers } = await this._graphApi(apiPath, 'GET', null, { rawStream: true });
    return {
      stream,
      size: parseInt(headers['content-length'] || '0', 10),
      mimeType: headers['content-type'] || 'application/octet-stream'
    };
  }

  async write(filePath, dataStream, options = {}) {
    const norm = this._normalizePath(filePath);
    const prefix = this._getDrivePrefix();
    const buf = await BaseProvider.streamToBuffer(dataStream);
    const apiPath = `${prefix}/root:${encodeURI(norm)}:/content`;
    const res = await this._graphApi(apiPath, 'PUT', buf, {
      'Content-Type': options.mimeType || 'application/octet-stream'
    });
    return {
      path: filePath,
      size: res.size || buf.length
    };
  }

  async delete(targetPath) {
    const norm = this._normalizePath(targetPath);
    const prefix = this._getDrivePrefix();
    const apiPath = `${prefix}/root:${encodeURI(norm)}:`;
    await this._graphApi(apiPath, 'DELETE');
    return true;
  }

  async move(srcPath, dstPath) {
    const normSrc = this._normalizePath(srcPath);
    const normDst = this._normalizePath(dstPath);
    const prefix = this._getDrivePrefix();
    const dstParts = normDst.split('/').filter(Boolean);
    const newName = dstParts.pop();
    const dstParent = dstParts.join('/');

    const body = { name: newName };
    if (dstParent !== '') {
      body.parentReference = { path: `${prefix}/root:/${dstParent}` };
    }
    const apiPath = `${prefix}/root:${encodeURI(normSrc)}:`;
    await this._graphApi(apiPath, 'PATCH', body);
    return true;
  }

  async copy(srcPath, dstPath) {
    const normSrc = this._normalizePath(srcPath);
    const normDst = this._normalizePath(dstPath);
    const prefix = this._getDrivePrefix();
    const dstParts = normDst.split('/').filter(Boolean);
    const newName = dstParts.pop();
    const body = { name: newName };

    const apiPath = `${prefix}/root:${encodeURI(normSrc)}:/copy`;
    await this._graphApi(apiPath, 'POST', body);
    return true;
  }

  async metadata(targetPath) {
    const norm = this._normalizePath(targetPath);
    const prefix = this._getDrivePrefix();
    const apiPath = norm === '' ? `${prefix}/root` : `${prefix}/root:${encodeURI(norm)}:`;
    const res = await this._graphApi(apiPath);
    return this._formatItem(res, targetPath);
  }

  async mkdir(dirPath) {
    const norm = this._normalizePath(dirPath);
    const prefix = this._getDrivePrefix();
    const parts = norm.split('/').filter(Boolean);
    const folderName = parts.pop();
    const parentPath = parts.join('/');
    const parentApiPath = parentPath === '' ? `${prefix}/root/children` : `${prefix}/root:${encodeURI(parentPath)}:/children`;

    await this._graphApi(parentApiPath, 'POST', {
      name: folderName,
      folder: {},
      '@microsoft.graph.conflictBehavior': 'rename'
    });
    return true;
  }

  async search(query, basePath = '/') {
    const prefix = this._getDrivePrefix();
    const apiPath = `${prefix}/root/search(q='${encodeURIComponent(query)}')`;
    const res = await this._graphApi(apiPath);
    const children = res.value || [];
    return children.map(item => this._formatItem(item));
  }

  async getQuota() {
    const prefix = this._getDrivePrefix();
    const res = await this._graphApi(prefix);
    const q = res.quota || {};
    return {
      used: q.used || 0,
      total: q.total || null
    };
  }
}

module.exports = SharePointProvider;
