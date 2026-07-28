const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs/promises');
const bcrypt = require('bcryptjs');
const db = require('../db');
const LocalProvider = require('../providers/local');
const { ensureUserHome } = require('../middleware/isolation');

async function authenticateWebdav(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Freeshard WebDAV"');
    return res.status(401).send('Unauthorized');
  }

  const credentials = Buffer.from(authHeader.split(' ')[1], 'base64').toString('utf-8');
  const colonIndex = credentials.indexOf(':');
  if (colonIndex === -1) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Freeshard WebDAV"');
    return res.status(401).send('Unauthorized');
  }

  const username = credentials.substring(0, colonIndex);
  const password = credentials.substring(colonIndex + 1);

  try {
    const user = await db.get(
      'SELECT * FROM users WHERE username = ? OR email = ? OR id = ?',
      [username, username, username]
    );

    if (!user) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Freeshard WebDAV"');
      return res.status(401).send('Unauthorized');
    }

    let authenticated = false;

    if (user.password_hash) {
      authenticated = await bcrypt.compare(password, user.password_hash);
    }

    if (!authenticated) {
      const appPasses = await db.all(
        'SELECT * FROM app_passwords WHERE user_id = ?',
        [user.id]
      );

      for (const appPass of appPasses) {
        if (await bcrypt.compare(password, appPass.password_hash)) {
          authenticated = true;
          break;
        }
      }
    }

    if (!authenticated) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Freeshard WebDAV"');
      return res.status(401).send('Unauthorized');
    }

    const rootBase = process.env.FILES_ROOT || (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'users') : path.join(__dirname, '..', '..', 'data', 'users'));
    const userRoot = path.resolve(rootBase, user.id);

    await ensureUserHome(userRoot);

    req.user = user;
    req.userId = user.id;
    req.userRoot = userRoot;
    req.provider = new LocalProvider({ userRoot });
    next();
  } catch (err) {
    return res.status(500).send(`Server Error: ${err.message}`);
  }
}

function formatWebdavDate(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  return d.toUTCString();
}

function escapeXml(unsafe) {
  if (!unsafe) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function renderPropfindXml(items, prefix = '/webdav') {
  let xml = '<?xml version="1.0" encoding="utf-8"?>\n';
  xml += '<D:multistatus xmlns:D="DAV:">\n';

  for (const item of items) {
    const relPath = item.path.startsWith('/') ? item.path : '/' + item.path;
    const href = (prefix + relPath).replace(/\/+/g, '/');
    const lastMod = formatWebdavDate(item.modified);

    xml += '  <D:response>\n';
    xml += `    <D:href>${escapeXml(href)}</D:href>\n`;
    xml += '    <D:propstat>\n';
    xml += '      <D:prop>\n';
    if (item.isDirectory) {
      xml += '        <D:resourcetype><D:collection/></D:resourcetype>\n';
      xml += '        <D:getcontentlength>0</D:getcontentlength>\n';
    } else {
      xml += '        <D:resourcetype/>\n';
      xml += `        <D:getcontentlength>${item.size || 0}</D:getcontentlength>\n`;
    }
    xml += `        <D:getlastmodified>${lastMod}</D:getlastmodified>\n`;
    xml += `        <D:displayname>${escapeXml(item.name)}</D:displayname>\n`;
    xml += '      </D:prop>\n';
    xml += '      <D:status>HTTP/1.1 200 OK</D:status>\n';
    xml += '    </D:propstat>\n';
    xml += '  </D:response>\n';
  }

  xml += '</D:multistatus>';
  return xml;
}

router.use(authenticateWebdav);

router.all('*', async (req, res) => {
  const method = req.method.toUpperCase();
  const reqPath = decodeURIComponent(req.path || '/');

  try {
    if (method === 'OPTIONS') {
      res.setHeader('DAV', '1, 2');
      res.setHeader('Allow', 'OPTIONS, GET, HEAD, POST, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK');
      return res.status(200).send();
    }

    if (method === 'PROPFIND') {
      const depth = req.headers['depth'] || '1';
      let meta;
      try {
        meta = await req.provider.metadata(reqPath);
      } catch (err) {
        return res.status(404).send('Not Found');
      }

      const items = [];
      items.push({
        name: meta.name || path.basename(reqPath) || '/',
        path: reqPath,
        isDirectory: meta.isDirectory,
        size: meta.size,
        modified: meta.modified
      });

      if (meta.isDirectory && depth !== '0') {
        const children = await req.provider.list(reqPath);
        items.push(...children);
      }

      const baseUrl = req.baseUrl || '/webdav';
      const xml = renderPropfindXml(items, baseUrl);
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      return res.status(207).send(xml);
    }

    if (method === 'GET' || method === 'HEAD') {
      let meta;
      try {
        meta = await req.provider.metadata(reqPath);
      } catch (err) {
        return res.status(404).send('Not Found');
      }

      if (meta.isDirectory) {
        return res.status(400).send('Cannot GET a directory');
      }

      const fileData = await req.provider.read(reqPath);
      res.setHeader('Content-Type', fileData.mimeType || 'application/octet-stream');
      res.setHeader('Content-Length', fileData.size);

      if (method === 'HEAD') {
        return res.status(200).end();
      }

      fileData.stream.pipe(res);
      return;
    }

    if (method === 'PUT') {
      await req.provider.write(reqPath, req);
      return res.status(201).send('Created');
    }

    if (method === 'MKCOL') {
      let exists = false;
      try {
        await req.provider.metadata(reqPath);
        exists = true;
      } catch (err) {}

      if (exists) {
        return res.status(405).send('Method Not Allowed: item already exists');
      }

      const fullPath = req.provider._resolve(reqPath);
      await fs.mkdir(fullPath, { recursive: true });
      return res.status(201).send('Created');
    }

    if (method === 'DELETE') {
      try {
        await req.provider.metadata(reqPath);
      } catch (err) {
        return res.status(404).send('Not Found');
      }

      await req.provider.delete(reqPath);
      return res.status(204).send();
    }

    if (method === 'MOVE' || method === 'COPY') {
      const destination = req.headers['destination'];
      if (!destination) {
        return res.status(400).send('Missing Destination header');
      }

      let destPath = destination;
      if (destination.includes('://')) {
        const parsed = new URL(destination);
        destPath = parsed.pathname;
      }

      const baseUrl = req.baseUrl || '/webdav';
      if (destPath.startsWith(baseUrl)) {
        destPath = destPath.substring(baseUrl.length);
      }
      destPath = decodeURIComponent(destPath);

      if (method === 'MOVE') {
        await req.provider.move(reqPath, destPath);
      } else {
        await req.provider.copy(reqPath, destPath);
      }
      return res.status(201).send('Created');
    }

    return res.status(405).send('Method Not Allowed');
  } catch (err) {
    return res.status(500).send(`Server Error: ${err.message}`);
  }
});

module.exports = router;
