'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { WebSocketServer } = require('ws');
const edsk = require('./lib/edsk-parser');
const gw = require('./lib/greaseweazle');

const PORT = process.env.PORT || 3141;
const UI_DIR = path.join(__dirname, 'ui');

// Config storage
const CONFIG_DIR = path.join(require('os').homedir(), '.config', 'floppy-explorer');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const PKG_VERSION = require('./package.json').version;

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}

function saveConfigFile(cfg) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function addRecentDir(cfg, dir) {
  if (!cfg.recentDirs) cfg.recentDirs = [];
  cfg.recentDirs = [dir, ...cfg.recentDirs.filter(d => d !== dir)].slice(0, 8);
}

// Use ~/Documents/Floppy Explorer/ when running inside a .app bundle,
// otherwise use local disks/ for development
const insideApp = __dirname.includes('.app/');
const DEFAULT_DISKS_DIR = insideApp
  ? path.join(require('os').homedir(), 'Documents', 'Floppy Explorer')
  : path.join(__dirname, 'disks');

function getDisksDir() {
  return loadConfig().disksDir || DEFAULT_DISKS_DIR;
}

// Native macOS file dialogs via osascript (Standard Additions — no tell block needed)
function pickSaveFile(defaultName, defaultLocation) {
  return new Promise((resolve, reject) => {
    const escaped = defaultName.replace(/["\\\n]/g, c => '\\' + c);
    const locPart = defaultLocation
      ? `POSIX file "${defaultLocation.replace(/["\\\n]/g, c => '\\' + c)}"`
      : '(path to downloads folder)';
    const script = `set f to POSIX path of (choose file name with prompt "Save as" default name "${escaped}" default location ${locPart})`;
    console.log('[save] Showing save dialog for:', defaultName);
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) { console.log('[save] Dialog cancelled or error:', stderr || err.message); return reject(new Error('cancelled')); }
      console.log('[save] User chose:', stdout.trim());
      resolve(stdout.trim());
    });
  });
}

function pickFolder(prompt, defaultLocation) {
  return new Promise((resolve, reject) => {
    const escaped = (prompt || 'Choose folder').replace(/["\\\n]/g, c => '\\' + c);
    const locPart = defaultLocation
      ? `POSIX file "${defaultLocation.replace(/["\\\n]/g, c => '\\' + c)}"`
      : '(path to downloads folder)';
    const script = `set f to POSIX path of (choose folder with prompt "${escaped}" default location ${locPart})`;
    console.log('[save] Showing folder dialog...');
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) { console.log('[save] Dialog cancelled or error:', stderr || err.message); return reject(new Error('cancelled')); }
      console.log('[save] User chose folder:', stdout.trim());
      resolve(stdout.trim());
    });
  });
}

// Ensure disks directory exists
// Ensure default disks directory exists
if (!fs.existsSync(DEFAULT_DISKS_DIR)) fs.mkdirSync(DEFAULT_DISKS_DIR, { recursive: true });

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
  const filePath = path.join(getDisksDir(), name);
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
    const disksDir = getDisksDir();
    if (!fs.existsSync(disksDir)) return [];
    const files = fs.readdirSync(disksDir).filter(f => /\.(e?dsk|img|ima)$/i.test(f)).sort();
    return files.map(name => {
      const stat = fs.statSync(path.join(disksDir, name));
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

  // Get deleted files (FAT disks)
  'GET /api/disk/:name/deleted': (params) => {
    const loaded = loadDisk(params.name);
    if (!loaded || loaded.error) return { status: 404, body: { error: 'Disk not found' } };
    if (loaded.disk.filesystem?.type !== 'FAT') {
      return { status: 400, body: { error: 'Not a FAT filesystem' } };
    }
    return edsk.readDeletedFiles(loaded.buf, loaded.disk, loaded.disk.filesystem);
  },

  // Recover a deleted file with native save dialog
  'GET /api/disk/:name/recover-file': async (params, query) => {
    const loaded = loadDisk(params.name);
    if (!loaded || loaded.error || loaded.disk.filesystem?.type !== 'FAT') {
      return { status: 404, body: { error: 'Disk not found or not FAT' } };
    }
    const cluster = parseInt(query.cluster);
    const size = parseInt(query.size);
    const filename = query.name || 'recovered.bin';
    if (isNaN(cluster) || isNaN(size) || cluster < 2) {
      return { status: 400, body: { error: 'Invalid cluster/size' } };
    }
    const data = edsk.readDeletedFileData(loaded.buf, loaded.disk, loaded.disk.filesystem, cluster, size);
    if (!data) return { status: 404, body: { error: 'Could not recover file data' } };

    let savePath;
    try {
      savePath = await pickSaveFile(path.basename(filename), loadConfig().disksDir);
    } catch {
      return { cancelled: true };
    }
    fs.writeFileSync(savePath, data);
    return { saved: true, path: savePath };
  },

  // Config
  'GET /api/config': () => {
    return { ...loadConfig(), version: PKG_VERSION };
  },

  'GET /api/config/check-updates': async () => {
    try {
      const https = require('https');
      const json = await new Promise((resolve, reject) => {
        https.get('https://api.github.com/repos/realhidden/floppyexplorer/releases/latest', {
          headers: { 'User-Agent': 'floppy-explorer/' + PKG_VERSION },
        }, (res) => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
            catch (e) { reject(e); }
          });
        }).on('error', reject);
      });
      const latest = (json.tag_name || '').replace(/^v/, '');
      return { latest, tag: json.tag_name, url: json.html_url, current: PKG_VERSION };
    } catch (e) {
      return { error: e.message };
    }
  },

  'GET /api/config/pick-disks-dir': async () => {
    let dir;
    try {
      dir = await pickFolder('Choose disk images directory');
    } catch {
      return { cancelled: true };
    }
    const cfg = loadConfig();
    cfg.disksDir = dir;
    addRecentDir(cfg, dir);
    saveConfigFile(cfg);
    diskCache.clear();
    watchDisksDir();
    return { dir };
  },

  // Save a single file with native save dialog
  'GET /api/disk/:name/save-file': async (params, query) => {
    const loaded = loadDisk(params.name);
    if (!loaded || loaded.error || loaded.disk.filesystem?.type !== 'FAT') {
      return { status: 404, body: { error: 'Disk not found or not FAT' } };
    }
    const cluster = parseInt(query.cluster);
    const size = parseInt(query.size);
    const filename = query.name || 'file.bin';
    if (isNaN(cluster) || isNaN(size) || cluster < 2) {
      return { status: 400, body: { error: 'Invalid cluster/size' } };
    }
    const data = edsk.readFileData(loaded.buf, loaded.disk, loaded.disk.filesystem, cluster, size);
    if (!data) return { status: 404, body: { error: 'Could not read file data' } };

    let savePath;
    try {
      savePath = await pickSaveFile(path.basename(filename), loadConfig().disksDir);
    } catch {
      return { cancelled: true };
    }
    fs.writeFileSync(savePath, data);
    return { saved: true, path: savePath };
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

  // Download all files from a FAT disk — show folder picker, save to chosen dir
  'GET /api/disk/:name/download-all': async (params) => {
    const loaded = loadDisk(params.name);
    if (!loaded || loaded.error) return { status: 404, body: { error: 'Disk not found' } };
    if (loaded.disk.filesystem?.type !== 'FAT') {
      return { status: 400, body: { error: 'Not a FAT filesystem' } };
    }

    let dlDir;
    try {
      dlDir = await pickFolder('Save all disk files to...', loadConfig().disksDir);
    } catch {
      return { cancelled: true };
    }

    const files = edsk.readFATDirectory(loaded.buf, loaded.disk, loaded.disk.filesystem);
    let savedCount = 0;
    for (const f of files) {
      if (f.isDir || f.isVolumeLabel || f.size === 0 || f.cluster < 2) continue;
      const data = edsk.readFileData(loaded.buf, loaded.disk, loaded.disk.filesystem, f.cluster, f.size);
      if (!data) continue;

      const filePath = f.path || f.name;
      const savePath = path.join(dlDir, filePath);
      const saveDir = path.dirname(savePath);
      if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
      fs.writeFileSync(savePath, data);
      savedCount++;
    }

    return { saved: true, count: savedCount, path: dlDir };
  },

  // Delete a disk image
  'DELETE /api/disk/:name': (params) => {
    const filePath = path.join(getDisksDir(), params.name);
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

  // File download (binary - outside JSON API)
  const dlMatch = pathname.match(/^\/api\/disk\/([^/]+)\/download$/);
  if (dlMatch && req.method === 'GET') {
    const diskName = decodeURIComponent(dlMatch[1]);
    const query = Object.fromEntries(parsed.searchParams);
    const cluster = parseInt(query.cluster);
    const size = parseInt(query.size);
    const filename = query.name || 'file.bin';

    const loaded = loadDisk(diskName);
    if (!loaded || loaded.error || loaded.disk.filesystem?.type !== 'FAT') {
      res.writeHead(404);
      res.end('Disk not found or not FAT');
      return;
    }
    if (isNaN(cluster) || isNaN(size) || cluster < 2) {
      res.writeHead(400);
      res.end('Invalid cluster/size');
      return;
    }

    const data = edsk.readFileData(loaded.buf, loaded.disk, loaded.disk.filesystem, cluster, size);
    if (!data) {
      res.writeHead(404);
      res.end('Could not read file data');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '_')}"`,
      'Content-Length': data.length,
      'Access-Control-Allow-Origin': '*',
    });
    res.end(data);
    return;
  }

  // POST /api/config — body parsing for JSON config updates
  if (req.method === 'POST' && pathname === '/api/config') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        saveConfigFile(body);
        diskCache.clear();
        watchDisksDir();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

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

        fs.writeFileSync(path.join(getDisksDir(), filename), fileData);
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
      const outputPath = path.join(getDisksDir(), filename);
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

// ── Directory watcher ──
let dirWatcher = null;
let debounceTimer = null;

function broadcastDirChange() {
  const msg = JSON.stringify({ type: 'disks-changed' });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

function watchDisksDir() {
  if (dirWatcher) { dirWatcher.close(); dirWatcher = null; }
  const dir = getDisksDir();
  if (!fs.existsSync(dir)) return;
  console.log('[watch] Watching', dir);
  try {
    dirWatcher = fs.watch(dir, (event, filename) => {
      if (!filename || !/\.(e?dsk|img|ima)$/i.test(filename)) return;
      // Debounce rapid changes (e.g. file being written)
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        console.log('[watch] Change detected:', filename);
        diskCache.delete(filename);
        broadcastDirChange();
      }, 500);
    });
    dirWatcher.on('error', () => { /* dir removed or inaccessible */ });
  } catch { /* ignore */ }
}

watchDisksDir();

server.listen(PORT, () => {
  console.log(`\n  Floppy Explorer running at http://localhost:${PORT}\n`);
});
