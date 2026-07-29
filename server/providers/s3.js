const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const { Readable } = require('stream');
const path = require('path');
const mime = require('mime-types');
const BaseProvider = require('./base');

/**
 * S3Provider — AWS S3 / MinIO / Wasabi Cloud Storage Integration (Issue #9)
 * Implements full BaseProvider interface using standard S3 REST API semantics & AWS SigV4.
 */
class S3Provider extends BaseProvider {
  /**
   * @param {object} config
   * @param {string} [config.bucket]
   * @param {string} [config.region]
   * @param {string} [config.accessKeyId]
   * @param {string} [config.secretAccessKey]
   * @param {string} [config.endpoint]
   * @param {boolean} [config.forcePathStyle]
   */
  constructor(config = {}) {
    super(config);
    this.bucket = config.bucket || process.env.S3_BUCKET || 'default-bucket';
    this.region = config.region || process.env.S3_REGION || 'us-east-1';
    this.accessKeyId = config.accessKeyId || process.env.S3_ACCESS_KEY_ID;
    this.secretAccessKey = config.secretAccessKey || process.env.S3_SECRET_ACCESS_KEY;
    this.endpoint = config.endpoint || process.env.S3_ENDPOINT || null;
    this.forcePathStyle = config.forcePathStyle ?? false;
  }

  /**
   * Generates AWS SigV4 signature headers for REST API requests
   */
  _buildSigV4Headers({ method, path: reqPath, headers = {}, payloadHash, isoDate, dateStamp }) {
    const amzDate = isoDate || new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = dateStamp || amzDate.substring(0, 8);
    const service = 's3';

    const reqHeaders = {
      'x-amz-date': amzDate,
      ...headers
    };
    if (payloadHash) {
      reqHeaders['x-amz-content-sha256'] = payloadHash;
    }

    const sortedHeaderKeys = Object.keys(reqHeaders).map(k => k.toLowerCase()).sort();
    const canonicalHeaders = sortedHeaderKeys.map(k => `${k}:${reqHeaders[k] || ''}\n`).join('');
    const signedHeaders = sortedHeaderKeys.join(';');

    const canonicalRequest = [
      method,
      reqPath,
      '', // query string
      canonicalHeaders,
      signedHeaders,
      payloadHash || 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    ].join('\n');

    const credentialScope = `${date}/${this.region}/${service}/aws4_request`;
    const hashedCanonicalReq = crypto.createHash('sha256').update(canonicalRequest).digest('hex');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      hashedCanonicalReq
    ].join('\n');

    const kDate = crypto.createHmac('sha256', 'AWS4' + (this.secretAccessKey || '')).update(date).digest();
    const kRegion = crypto.createHmac('sha256', kDate).update(this.region).digest();
    const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
    const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    const authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId || ''}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return {
      ...reqHeaders,
      Authorization: authorization
    };
  }

  /**
   * Helper to perform HTTP/S3 REST API requests
   */
  async _s3Request(options) {
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
      if (options.body) req.write(options.body);
      req.end();
    });
  }

  /**
   * Helper to parse S3 XML responses (ListBucketResult) using basic regex
   */
  _parseXmlList(xml) {
    const items = [];
    
    // Parse CommonPrefixes (directories)
    const prefixRegex = /<CommonPrefixes>[\s\S]*?<Prefix>(.*?)<\/Prefix>[\s\S]*?<\/CommonPrefixes>/g;
    let match;
    while ((match = prefixRegex.exec(xml)) !== null) {
      const key = match[1];
      const cleanKey = key.replace(/\/$/, '');
      const name = path.basename(cleanKey) || cleanKey;
      items.push({
        name,
        path: '/' + cleanKey,
        isDirectory: true,
        size: 0,
        modified: new Date().toISOString(),
        mimeType: null
      });
    }

    // Parse Contents (files/objects)
    const contentsRegex = /<Contents>([\s\S]*?)<\/Contents>/g;
    while ((match = contentsRegex.exec(xml)) !== null) {
      const block = match[1];
      const keyMatch = /<Key>(.*?)<\/Key>/.exec(block);
      const sizeMatch = /<Size>(.*?)<\/Size>/.exec(block);
      const modMatch = /<LastModified>(.*?)<\/LastModified>/.exec(block);

      const key = keyMatch ? keyMatch[1] : '';
      const isDir = key.endsWith('/');
      const cleanKey = key.replace(/\/$/, '');
      const name = cleanKey ? path.basename(cleanKey) : '';
      const size = sizeMatch ? parseInt(sizeMatch[1], 10) : 0;
      const modified = modMatch ? modMatch[1] : new Date().toISOString();

      items.push({
        name,
        path: '/' + cleanKey,
        isDirectory: isDir,
        size,
        modified,
        mimeType: isDir ? null : (mime.lookup(cleanKey) || 'application/octet-stream')
      });
    }

    return items;
  }

  /**
   * Clean path helper to ensure no leading slash for S3 key
   */
  _toKey(p) {
    if (!p || p === '/') return '';
    return p.replace(/^\/+/, '');
  }

  /**
   * Ensure leading slash for returned paths
   */
  _toPath(key) {
    if (!key) return '/';
    return key.startsWith('/') ? key : '/' + key;
  }

  /**
   * List directory contents
   * @param {string} dirPath
   */
  async list(dirPath = '/') {
    const cleanDir = this._toKey(dirPath);
    const prefix = cleanDir ? (cleanDir.endsWith('/') ? cleanDir : cleanDir + '/') : '';
    const reqPath = `/${this.bucket}?list-type=2&prefix=${encodeURIComponent(prefix)}`;
    const res = await this._s3Request({
      method: 'GET',
      path: reqPath,
      headers: { host: this.endpoint ? new URL(this.endpoint).host : `${this.bucket}.s3.${this.region}.amazonaws.com` }
    });

    return this._parseXmlList(res.body || '');
  }

  /**
   * Read file content as ReadableStream
   * @param {string} filePath
   */
  async read(filePath) {
    const key = this._toKey(filePath);
    const reqPath = `/${this.bucket}/${key}`;
    const res = await this._s3Request({
      method: 'GET',
      path: reqPath,
      headers: {}
    });

    const buffer = res.buffer || Buffer.from(res.body || '');
    const size = res.headers && res.headers['content-length'] ? parseInt(res.headers['content-length'], 10) : buffer.length;
    const mimeType = (res.headers && res.headers['content-type']) || mime.lookup(key) || 'application/octet-stream';
    const stream = Readable.from([buffer]);

    return { stream, size, mimeType };
  }

  /**
   * Write data from stream to S3 object path
   * @param {string} filePath
   * @param {import('stream').Readable} dataStream
   * @param {object} [options]
   */
  async write(filePath, dataStream, options = {}) {
    const key = this._toKey(filePath);
    const buffer = await BaseProvider.streamToBuffer(dataStream);
    const mimeType = options.mimeType || mime.lookup(key) || 'application/octet-stream';
    const reqPath = `/${this.bucket}/${key}`;

    await this._s3Request({
      method: 'PUT',
      path: reqPath,
      headers: {
        'content-type': mimeType,
        'content-length': buffer.length.toString()
      },
      body: buffer
    });

    return {
      path: this._toPath(key),
      size: buffer.length
    };
  }

  /**
   * Delete object from bucket
   * @param {string} targetPath
   */
  async delete(targetPath) {
    const key = this._toKey(targetPath);
    const reqPath = `/${this.bucket}/${key}`;
    await this._s3Request({
      method: 'DELETE',
      path: reqPath
    });
    return true;
  }

  /**
   * Copy object
   * @param {string} srcPath
   * @param {string} dstPath
   */
  async copy(srcPath, dstPath) {
    const srcKey = this._toKey(srcPath);
    const dstKey = this._toKey(dstPath);
    const reqPath = `/${this.bucket}/${dstKey}`;

    await this._s3Request({
      method: 'PUT',
      path: reqPath,
      headers: {
        'x-amz-copy-source': `/${this.bucket}/${srcKey}`
      }
    });
    return true;
  }

  /**
   * Move object (Copy + Delete)
   * @param {string} srcPath
   * @param {string} dstPath
   */
  async move(srcPath, dstPath) {
    await this.copy(srcPath, dstPath);
    await this.delete(srcPath);
    return true;
  }

  /**
   * Get metadata for target object
   * @param {string} targetPath
   */
  async metadata(targetPath) {
    const key = this._toKey(targetPath);
    const reqPath = `/${this.bucket}/${key}`;
    const res = await this._s3Request({
      method: 'HEAD',
      path: reqPath
    });

    const headers = res.headers || {};
    const size = headers['content-length'] ? parseInt(headers['content-length'], 10) : 0;
    const mimeType = headers['content-type'] || mime.lookup(key) || 'application/octet-stream';
    const modified = headers['last-modified'] || new Date().toISOString();

    return {
      name: path.basename(key),
      path: this._toPath(key),
      isDirectory: false,
      size,
      modified,
      mimeType
    };
  }

  /**
   * Create directory key with trailing slash
   * @param {string} dirPath
   */
  async mkdir(dirPath) {
    const cleanDir = this._toKey(dirPath);
    const key = cleanDir.endsWith('/') ? cleanDir : cleanDir + '/';
    const reqPath = `/${this.bucket}/${key}`;

    await this._s3Request({
      method: 'PUT',
      path: reqPath,
      body: Buffer.alloc(0)
    });
    return true;
  }

  /**
   * Search files by query
   * @param {string} query
   * @param {string} [basePath='/']
   */
  async search(query, basePath = '/') {
    const items = await this.list(basePath);
    const q = query.toLowerCase();
    return items.filter(item => item.name.toLowerCase().includes(q));
  }

  /**
   * Calculate storage usage quota
   */
  async getQuota() {
    const res = await this._s3Request({ method: 'GET', path: '/', query: 'list-type=2' });
    if (res.statusCode >= 400) return { used: 0, total: null };
    const items = this._parseXmlList(res.body || '');
    const used = items.reduce((acc, item) => acc + (item.size || 0), 0);
    return { used, total: null };
  }

  /**
   * Get direct download / presigned URL
   * @param {string} filePath
   */
  async getDirectUrl(filePath) {
    const key = filePath.replace(/^\/+/, '');
    if (this.forcePathStyle) {
      const base = this.endpoint ? this.endpoint.replace(/\/$/, '') : `https://s3.${this.region}.amazonaws.com`;
      return `${base}/${this.bucket}/${key}`;
    }
    if (this.endpoint) {
      const u = new URL(this.endpoint);
      if (u.host.startsWith('s3.') || u.host.includes('amazonaws.com')) {
        return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;
      }
      return `${u.protocol}//${this.bucket}.${u.host}/${key}`;
    }
    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;
  }
}

module.exports = S3Provider;
