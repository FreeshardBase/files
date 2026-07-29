const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');
const BaseProvider = require('../providers/base');
const S3Provider = require('../providers/s3');
const { getProvider, providers } = require('../providers');

describe('S3Provider — Storage Abstraction Layer S3 Provider Integration (#9)', () => {
  const credentials = {
    bucket: 'test-freeshard-bucket',
    region: 'us-west-2',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    endpoint: 'https://s3.us-west-2.amazonaws.com',
    forcePathStyle: false
  };

  test('inherits from BaseProvider contract and registers in provider factory', () => {
    const provider = new S3Provider(credentials);
    assert.ok(provider instanceof BaseProvider);
    assert.equal(provider.bucket, credentials.bucket);
    assert.equal(provider.region, credentials.region);
    assert.equal(provider.accessKeyId, credentials.accessKeyId);
    assert.equal(provider.secretAccessKey, credentials.secretAccessKey);

    assert.equal(providers.s3, S3Provider);
    const factoryInstance = getProvider('s3', credentials);
    assert.ok(factoryInstance instanceof S3Provider);
  });

  test('supports MinIO and Wasabi endpoint configuration & path style URLs', () => {
    const minioConfig = {
      bucket: 'minio-bucket',
      region: 'us-east-1',
      accessKeyId: 'minioadmin',
      secretAccessKey: 'minioadmin',
      endpoint: 'http://localhost:9000',
      forcePathStyle: true
    };
    const minioProvider = new S3Provider(minioConfig);
    assert.equal(minioProvider.endpoint, 'http://localhost:9000');
    assert.equal(minioProvider.forcePathStyle, true);

    const wasabiConfig = {
      bucket: 'wasabi-bucket',
      region: 'us-east-1',
      accessKeyId: 'wasabi-key',
      secretAccessKey: 'wasabi-secret',
      endpoint: 'https://s3.wasabisys.com'
    };
    const wasabiProvider = new S3Provider(wasabiConfig);
    assert.equal(wasabiProvider.endpoint, 'https://s3.wasabisys.com');
  });

  test('generates valid SigV4 signature headers for REST API requests', () => {
    const provider = new S3Provider(credentials);
    const headers = provider._buildSigV4Headers({
      method: 'GET',
      path: '/test-freeshard-bucket/file.txt',
      headers: { host: 's3.us-west-2.amazonaws.com' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      isoDate: '20260729T000000Z',
      dateStamp: '20260729'
    });

    assert.ok(headers.Authorization);
    assert.ok(headers.Authorization.includes('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260729/us-west-2/s3/aws4_request'));
    assert.ok(headers.Authorization.includes('Signature='));
    assert.ok(headers['x-amz-date']);
  });

  test('list() parses XML bucket contents and formats item list', async () => {
    const provider = new S3Provider(credentials);
    provider._s3Request = async () => ({
      statusCode: 200,
      body: `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
    <Name>test-freeshard-bucket</Name>
    <Prefix>docs/</Prefix>
    <CommonPrefixes>
        <Prefix>docs/subfolder/</Prefix>
    </CommonPrefixes>
    <Contents>
        <Key>docs/report.pdf</Key>
        <LastModified>2026-07-29T08:00:00.000Z</LastModified>
        <Size>1048576</Size>
    </Contents>
</ListBucketResult>`
    });

    const items = await provider.list('/docs');
    assert.equal(items.length, 2);

    const folder = items.find(i => i.isDirectory);
    assert.ok(folder);
    assert.equal(folder.name, 'subfolder');
    assert.equal(folder.path, '/docs/subfolder');

    const file = items.find(i => !i.isDirectory);
    assert.ok(file);
    assert.equal(file.name, 'report.pdf');
    assert.equal(file.path, '/docs/report.pdf');
    assert.equal(file.size, 1048576);
  });

  test('read() downloads object as Readable stream', async () => {
    const provider = new S3Provider(credentials);
    const content = Buffer.from('hello s3 storage');
    provider._s3Request = async () => ({
      statusCode: 200,
      headers: {
        'content-length': content.length.toString(),
        'content-type': 'text/plain'
      },
      buffer: content
    });

    const result = await provider.read('/docs/hello.txt');
    assert.equal(result.size, content.length);
    assert.equal(result.mimeType, 'text/plain');
    const readBuffer = await BaseProvider.streamToBuffer(result.stream);
    assert.equal(readBuffer.toString('utf8'), 'hello s3 storage');
  });

  test('write() uploads stream content to S3 object key', async () => {
    const provider = new S3Provider(credentials);
    let capturedOptions = null;
    provider._s3Request = async (opts) => {
      capturedOptions = opts;
      return { statusCode: 200, body: '' };
    };

    const stream = Readable.from([Buffer.from('upload data')]);
    const result = await provider.write('/uploads/data.txt', stream, { mimeType: 'text/plain' });

    assert.equal(result.path, '/uploads/data.txt');
    assert.equal(result.size, 11);
    assert.equal(capturedOptions.method, 'PUT');
    assert.equal(capturedOptions.headers['content-type'], 'text/plain');
  });

  test('delete() removes object key from bucket', async () => {
    const provider = new S3Provider(credentials);
    let deletedKey = null;
    provider._s3Request = async (opts) => {
      deletedKey = opts.path;
      return { statusCode: 204, body: '' };
    };

    const success = await provider.delete('/uploads/data.txt');
    assert.equal(success, true);
    assert.ok(deletedKey.includes('data.txt'));
  });

  test('copy() and move() perform CopyObject operation', async () => {
    const provider = new S3Provider(credentials);
    const calls = [];
    provider._s3Request = async (opts) => {
      calls.push(opts);
      return { statusCode: 200, body: '<CopyObjectResult></CopyObjectResult>' };
    };

    const copyResult = await provider.copy('/src/file.txt', '/dst/file.txt');
    assert.equal(copyResult, true);
    assert.equal(calls[0].method, 'PUT');
    assert.equal(calls[0].headers['x-amz-copy-source'], '/test-freeshard-bucket/src/file.txt');

    const moveResult = await provider.move('/src/file2.txt', '/dst/file2.txt');
    assert.equal(moveResult, true);
    assert.equal(calls.length, 3); // Copy PUT + Delete DELETE
    assert.equal(calls[2].method, 'DELETE');
  });

  test('metadata() returns object attributes via HeadObject', async () => {
    const provider = new S3Provider(credentials);
    provider._s3Request = async () => ({
      statusCode: 200,
      headers: {
        'content-length': '2048',
        'content-type': 'image/png',
        'last-modified': 'Wed, 29 Jul 2026 08:00:00 GMT'
      }
    });

    const meta = await provider.metadata('/images/logo.png');
    assert.equal(meta.name, 'logo.png');
    assert.equal(meta.path, '/images/logo.png');
    assert.equal(meta.size, 2048);
    assert.equal(meta.mimeType, 'image/png');
    assert.equal(meta.isDirectory, false);
  });

  test('mkdir() creates trailing-slash directory key', async () => {
    const provider = new S3Provider(credentials);
    let putKey = null;
    provider._s3Request = async (opts) => {
      putKey = opts.path;
      return { statusCode: 200, body: '' };
    };

    const result = await provider.mkdir('/newfolder');
    assert.equal(result, true);
    assert.ok(putKey.endsWith('newfolder/'));
  });

  test('search() finds matching keys by query string', async () => {
    const provider = new S3Provider(credentials);
    provider._s3Request = async () => ({
      statusCode: 200,
      body: `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
    <Contents>
        <Key>invoices/2026-01-report.pdf</Key>
        <Size>500</Size>
    </Contents>
    <Contents>
        <Key>invoices/2026-02-report.pdf</Key>
        <Size>600</Size>
    </Contents>
    <Contents>
        <Key>photos/cat.jpg</Key>
        <Size>900</Size>
    </Contents>
</ListBucketResult>`
    });

    const results = await provider.search('report');
    assert.equal(results.length, 2);
    assert.equal(results[0].name, '2026-01-report.pdf');
    assert.equal(results[1].name, '2026-02-report.pdf');
  });

  test('getQuota() calculates total bucket usage', async () => {
    const provider = new S3Provider(credentials);
    provider._s3Request = async () => ({
      statusCode: 200,
      body: `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
    <Contents><Size>1000</Size></Contents>
    <Contents><Size>2000</Size></Contents>
</ListBucketResult>`
    });

    const quota = await provider.getQuota();
    assert.equal(quota.used, 3000);
    assert.equal(quota.total, null);
  });

  test('getDirectUrl() constructs correct object endpoint URL', async () => {
    const provider = new S3Provider(credentials);
    const url = await provider.getDirectUrl('/documents/spec.pdf');
    assert.equal(url, 'https://test-freeshard-bucket.s3.us-west-2.amazonaws.com/documents/spec.pdf');

    const pathStyleProvider = new S3Provider({
      ...credentials,
      endpoint: 'http://minio.local:9000',
      forcePathStyle: true
    });
    const minioUrl = await pathStyleProvider.getDirectUrl('/documents/spec.pdf');
    assert.equal(minioUrl, 'http://minio.local:9000/test-freeshard-bucket/documents/spec.pdf');
  });
});
