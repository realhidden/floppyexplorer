'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const edsk = require('./lib/edsk-parser');
const gw = require('./lib/greaseweazle');

const PORT = process.env.PORT || 3141;
const DISKS_DIR = path.join(__dirname, 'disks');
const UI_DIR = path.join(__dirname, 'ui');

// Ensure disks directory exists
if (!fs.existsSync(DISKS_DIR)) fs.mkdirSync(DISKS_DIR);

// MIME types
const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// Disk cache (parsed disks kept in memory)
const diskCache = new Map();

function loadDisk(name) {
  const filePath = path.join(DISKS_DIR, name);
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  if (stat.size === 0) return null;

  const cached = diskCache.get(name);
  if (cached && cached.mtime === stat.mtimeMs) return cached;

  try {
    const { buf, disk } = edsk.parseFile(filePath);
    const entry = { buf, disk, mtime: stat.mtimeMs, name, size: stat.size };
    diskCache.set(name, entry);
    return entry;
  } catch (e) {
    return { error: e.message, name, size: stat.size };
  }
}

// API handlers
const api = {
  // List all disk images
  'GET /api/disks': () => {
    const files = fs.readdirSync(DISKS_DIR).filter(f => /\.(e?dsk|img|ima)$/i.test(f)).sort();
    return files.map(name => {
      const stat = fs.statSync(path.join(DISKS_DIR, name));
      const loaded = loadDisk(name);
      return {
        name,
        size: stat.size,
        modified: stat.mtime,
        valid: loaded && !loaded.error,
        error: loaded?.error || null,
        format: loaded?.disk?.format || null,
        tracks: loaded?.disk?.tracks || null,
        sides: loaded?.disk?.sides || null,
        filesystem: loaded?.disk?.filesystem || null,
      };
    });
  },

  // Get full disk info
  'GET /api/disk/:name': (params) => {
    const loaded = loadDisk(params.name);
    if (!loaded) return { status: 404, body: { error: 'Disk not found or empty' } };
    if (loaded.error) return { status: 400, body: { error: loaded.error } };

    const { disk } = loaded;
    return {
      name: params.name,
      format: disk.format,
      creator: disk.creator,
      tracks: disk.tracks,
      sides: disk.sides,
      filesystem: disk.filesystem,
      trackIndex: disk.trackIndex.map(t => ({
        track: t.track,
        side: t.side,
        missing: t.missing,
        sectorCount: t.sectorCount || 0,
        size: t.size,
        sectors: (t.sectors || []).map(s => ({
          index: s.index,
          C: s.C, H: s.H, R: s.R, N: s.N,
          ST1: s.ST1, ST2: s.ST2,
          size: s.size,
          hasError: s.hasError,
          errorFlags: s.errorFlags,
          truncated: s.truncated || false,
        })),
      })),
    };
  },

  // Get sector hex data
  'GET /api/disk/:name/sector': (params, query) => {
    const loaded = loadDisk(params.name);
    if (!loaded || loaded.error) return { status: 404, body: { error: 'Disk not found' } };

    const track = parseInt(query.track);
    const side = parseInt(query.side);
    const sectorR = parseInt(query.r);
    if (isNaN(track) || isNaN(side) || isNaN(sectorR)) {
      return { status: 400, body: { error: 'Missing track/side/r params' } };
    }

    const data = edsk.readSectorData(loaded.buf, loaded.disk, track, side, sectorR);
    if (!data) return { status: 404, body: { error: 'Sector not found' } };

    // Return hex + ascii dump
    const lines = [];
    for (let i = 0; i < data.length; i += 16) {
      const slice = data.slice(i, i + 16);
      const hexPart = Array.from(slice).map(b => b.toString(16).padStart(2, '0')).join(' ');
      const asciiPart = Array.from(slice).map(b => (b >= 0x20 && b <= 0x7E) ? String.fromCharCode(b) : '.').join('');
      lines.push({
        offset: i,
        hex: hexPart,
        ascii: asciiPart,
      });
    }

    return { size: data.length, lines, raw: data.toString('base64') };
  },

  // Get directory listing (FAT disks)
  'GET /api/disk/:name/files': (params) => {
    const loaded = loadDisk(params.name);
    if (!loaded || loaded.error) return { status: 404, body: { error: 'Disk not found' } };
    if (loaded.disk.filesystem?.type !== 'FAT') {
      return { status: 400, body: { error: 'Not a FAT filesystem' } };
    }
    return edsk.readFATDirectory(loaded.buf, loaded.disk, loaded.disk.filesystem);
  },

  // Greaseweazle device info
  'GET /api/gw/info': async () => {
    if (gw.isBusy()) return { connected: true, busy: true, note: 'Device busy — read in progress' };
    try {
      const deviceInfo = await gw.info();
      return { connected: true, busy: false, ...deviceInfo };
    } catch (e) {
      return { connected: false, busy: false, error: e.message };
    }
  },

  // Greaseweazle RPM
  'GET /api/gw/rpm': async () => {
    if (gw.isBusy()) return { error: 'Device busy' };
    try {
      const rpm = await gw.rpm();
      return { rpm };
    } catch (e) {
      return { error: e.message };
    }
  },

  // Delete a disk image
  'DELETE /api/disk/:name': (params) => {
    const filePath = path.join(DISKS_DIR, params.name);
    if (!fs.existsSync(filePath)) return { status: 404, body: { error: 'Not found' } };
    fs.unlinkSync(filePath);
    diskCache.delete(params.name);
    return { deleted: true };
  },
};

// Route matching
function matchRoute(method, pathname) {
  for (const [pattern, handler] of Object.entries(api)) {
    const [pMethod, ...pParts] = pattern.split(' ');
    const pPath = pParts.join(' ');
    if (pMethod !== method) continue;

    const patternParts = pPath.split('/');
    const urlParts = pathname.split('/');

    if (patternParts.length !== urlParts.length) continue;

    const params = {};
    let match = true;
    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i].startsWith(':')) {
        params[patternParts[i].slice(1)] = decodeURIComponent(urlParts[i]);
      } else if (patternParts[i] !== urlParts[i]) {
        match = false;
        break;
      }
    }
    if (match) return { handler, params };
  }
  return null;
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsed.pathname;

  // API routes
  if (pathname.startsWith('/api/')) {
    const route = matchRoute(req.method, pathname);
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    try {
      const query = Object.fromEntries(parsed.searchParams);
      let result = route.handler(route.params, query);
      if (result instanceof Promise) result = await result;

      const status = result?.status || 200;
      const body = result?.body || result;

      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(body));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Handle file upload (multipart - simple)
  if (req.method === 'POST' && pathname === '/upload') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      // Extract filename and data from multipart
      const boundary = req.headers['content-type']?.match(/boundary=(.+)/)?.[1];
      if (!boundary) {
        res.writeHead(400);
        res.end('Missing boundary');
        return;
      }
      const parts = body.toString('binary').split('--' + boundary);
      for (const part of parts) {
        const fnMatch = part.match(/filename="([^"]+)"/);
        if (!fnMatch) continue;
        const filename = path.basename(fnMatch[1]);
        if (!/\.(e?dsk|img|ima)$/i.test(filename)) continue;

        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const fileData = Buffer.from(part.slice(headerEnd + 4).replace(/\r\n$/, ''), 'binary');

        fs.writeFileSync(path.join(DISKS_DIR, filename), fileData);
        diskCache.delete(filename);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // Serve static files
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(UI_DIR, filePath);

  // Security: prevent directory traversal
  if (!filePath.startsWith(UI_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

// WebSocket for live operations
const wss = new WebSocketServer({ server });
let activeRead = null;

wss.on('connection', (ws) => {
  ws.on('message', async (msg) => {
    let cmd;
    try {
      cmd = JSON.parse(msg);
    } catch {
      ws.send(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (cmd.action === 'read-disk') {
      if (activeRead) {
        ws.send(JSON.stringify({ type: 'error', message: 'A read is already in progress' }));
        return;
      }

      const filename = cmd.filename || `disk_${Date.now()}.edsk`;
      const outputPath = path.join(DISKS_DIR, filename);
      const ac = new AbortController();
      activeRead = ac;

      ws.send(JSON.stringify({ type: 'read-start', filename }));

      try {
        await gw.read(outputPath, {
          format: cmd.format,
          tracks: cmd.tracks,
          revs: cmd.revs || 3,
          retries: cmd.retries || 3,
          signal: ac.signal,
          onProgress: (line) => {
            ws.send(JSON.stringify({ type: 'read-progress', line }));
          },
        });

        diskCache.delete(filename);
        const loaded = loadDisk(filename);
        ws.send(JSON.stringify({
          type: 'read-complete',
          filename,
          valid: loaded && !loaded.error,
          format: loaded?.disk?.format,
          tracks: loaded?.disk?.tracks,
          sides: loaded?.disk?.sides,
        }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'read-error', message: e.message }));
      } finally {
        activeRead = null;
      }
    }

    if (cmd.action === 'cancel-read') {
      if (activeRead) {
        activeRead.abort();
        ws.send(JSON.stringify({ type: 'read-cancelled' }));
      }
    }

    if (cmd.action === 'gw-info') {
      try {
        const info = await gw.info();
        ws.send(JSON.stringify({ type: 'gw-info', ...info }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'gw-info', connected: false, error: e.message }));
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n  Floppy Explorer running at http://localhost:${PORT}\n`);
});
