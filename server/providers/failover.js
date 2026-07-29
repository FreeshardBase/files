const BaseProvider = require('./base');

class FailoverProvider extends BaseProvider {
  /**
   * @param {{ primaryProvider: BaseProvider, secondaryProvider: BaseProvider }} config 
   */
  constructor(config = {}) {
    super(config);
    if (!config.primaryProvider || !config.secondaryProvider) {
      throw new Error('FailoverProvider requires primaryProvider and secondaryProvider');
    }
    this.primaryProvider = config.primaryProvider;
    this.secondaryProvider = config.secondaryProvider;
    this.activeNode = 'primary';
    this.primaryStatus = 'online';
    this.secondaryStatus = 'online';
    this.failoverCount = 0;
    this.lastFailoverTime = null;
  }

  async _execute(methodName, ...args) {
    if (this.activeNode === 'primary') {
      try {
        const result = await this.primaryProvider[methodName](...args);
        this.primaryStatus = 'online';
        return result;
      } catch (err) {
        console.warn(`[StorageFailover] Primary node failed on ${methodName}: ${err.message}. Failing over to secondary.`);
        this.activeNode = 'secondary';
        this.primaryStatus = 'offline';
        this.failoverCount++;
        this.lastFailoverTime = new Date().toISOString();
        
        try {
          const secResult = await this.secondaryProvider[methodName](...args);
          this.secondaryStatus = 'online';
          return secResult;
        } catch (secErr) {
          this.secondaryStatus = 'offline';
          throw secErr;
        }
      }
    } else {
      try {
        const result = await this.secondaryProvider[methodName](...args);
        this.secondaryStatus = 'online';
        return result;
      } catch (err) {
        this.secondaryStatus = 'offline';
        throw err;
      }
    }
  }

  async list(dirPath = '/') {
    return this._execute('list', dirPath);
  }

  async read(filePath) {
    return this._execute('read', filePath);
  }

  async write(filePath, dataStream, options = {}) {
    if (this.activeNode === 'primary') {
      try {
        const res = await this.primaryProvider.write(filePath, dataStream, options);
        this.primaryStatus = 'online';
        // Mirror write to secondary node asynchronously for redundancy if readable stream can be cloned or secondary write fails gracefully
        try {
          if (typeof this.secondaryProvider.read === 'function') {
            const readRes = await this.primaryProvider.read(filePath);
            await this.secondaryProvider.write(filePath, readRes.stream, options);
          }
        } catch {}
        return res;
      } catch (err) {
        this.activeNode = 'secondary';
        this.primaryStatus = 'offline';
        this.failoverCount++;
        this.lastFailoverTime = new Date().toISOString();
        return this.secondaryProvider.write(filePath, dataStream, options);
      }
    } else {
      return this.secondaryProvider.write(filePath, dataStream, options);
    }
  }

  async delete(targetPath) {
    return this._execute('delete', targetPath);
  }

  async move(srcPath, dstPath) {
    return this._execute('move', srcPath, dstPath);
  }

  async copy(srcPath, dstPath) {
    return this._execute('copy', srcPath, dstPath);
  }

  async metadata(targetPath) {
    return this._execute('metadata', targetPath);
  }

  async mkdir(dirPath) {
    return this._execute('mkdir', dirPath);
  }

  async search(query, basePath = '/') {
    return this._execute('search', query, basePath);
  }

  async getQuota(quotaBytes = null) {
    return this._execute('getQuota', quotaBytes);
  }

  async probeHealth() {
    try {
      if (typeof this.primaryProvider.list === 'function') {
        await this.primaryProvider.list('/');
      }
      this.primaryStatus = 'online';
      this.activeNode = 'primary';
    } catch {
      this.primaryStatus = 'offline';
      this.activeNode = 'secondary';
    }

    try {
      if (typeof this.secondaryProvider.list === 'function') {
        await this.secondaryProvider.list('/');
      }
      this.secondaryStatus = 'online';
    } catch {
      this.secondaryStatus = 'offline';
    }

    return this.checkHealth();
  }

  async checkHealth() {
    let overall = 'ok';
    if (this.primaryStatus === 'offline' && this.secondaryStatus === 'offline') {
      overall = 'error';
    } else if (this.primaryStatus === 'offline' || this.secondaryStatus === 'offline') {
      overall = 'degraded';
    }

    return {
      status: overall,
      activeNode: this.activeNode,
      primary: {
        status: this.primaryStatus,
        path: this.primaryProvider.userRoot || null
      },
      secondary: {
        status: this.secondaryStatus,
        path: this.secondaryProvider.userRoot || null
      },
      failoverCount: this.failoverCount,
      lastFailover: this.lastFailoverTime
    };
  }
}

module.exports = FailoverProvider;
