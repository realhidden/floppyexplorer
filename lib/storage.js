'use strict';

const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const DISK_EXTENSIONS = /\.(e?dsk|img|ima)$/i;

class LocalBackend {
  constructor(disksDir) {
    this.disksDir = disksDir;
  }

  async ensureDir() {
    if (!fs.existsSync(this.disksDir)) {
      fs.mkdirSync(this.disksDir, { recursive: true });
    }
  }

  list() {
    if (!fs.existsSync(this.disksDir)) return [];
    return fs.readdirSync(this.disksDir)
      .filter(f => DISK_EXTENSIONS.test(f))
      .sort()
      .map(name => {
        const filePath = path.join(this.disksDir, name);
        const stat = fs.statSync(filePath);
        return {
          name,
          size: stat.size,
          modified: stat.mtime,
          local: true,
        };
      });
  }

  exists(name) {
    return fs.existsSync(path.join(this.disksDir, name));
  }

  stat(name) {
    const filePath = path.join(this.disksDir, name);
    if (!fs.existsSync(filePath)) return null;
    return fs.statSync(filePath);
  }

  read(name) {
    return fs.readFileSync(path.join(this.disksDir, name));
  }

  write(name, buffer) {
    fs.writeFileSync(path.join(this.disksDir, name), buffer);
  }

  delete(name) {
    const filePath = path.join(this.disksDir, name);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}

class S3Backend {
  constructor(config) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region || 'us-east-1',
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: !!config.pathStyle,
    });
    this.bucket = config.bucket;
    this.prefix = config.prefix ? (config.prefix.endsWith('/') ? config.prefix : config.prefix + '/') : 'floppy-explorer/';
  }

  async list() {
    const result = await this.client.send(new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: this.prefix,
    }));

    const disks = [];
    if (result.Contents) {
      for (const obj of result.Contents) {
        const key = obj.Key;
        const name = key.replace(this.prefix, '');
        if (!DISK_EXTENSIONS.test(name) || !name) continue;
        disks.push({
          name,
          size: obj.Size,
          modified: obj.LastModified,
          remote: true,
        });
      }
    }
    return disks.sort((a, b) => a.name.localeCompare(b.name));
  }

  async exists(name) {
    try {
      await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: this.prefix + name,
      }));
      return true;
    } catch {
      return false;
    }
  }

  async read(name) {
    const result = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: this.prefix + name,
    }));
    return Buffer.from(await result.Body.transformToByteArray());
  }

  async write(name, buffer, onProgress) {
    let uploaded = 0;
    const chunkSize = 64 * 1024;
    const total = buffer.length;

    // For small files, upload directly
    if (total <= chunkSize) {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.prefix + name,
        Body: buffer,
      }));
      return;
    }

    // For large files, use multipart-like approach with single PutObject
    // (S3 SDK handles multipart internally for large bodies)
    const stream = buffer;
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.prefix + name,
      Body: stream,
    }), {
      onHttpRequestsMade: (progress) => {
        uploaded = progress.bytesWritten || 0;
        if (onProgress) onProgress({ loaded: uploaded, total });
      },
    });
  }

  async delete(name) {
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: this.prefix + name,
    }));
  }

  async head(name) {
    try {
      const result = await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: this.prefix + name,
      }));
      return { size: result.ContentLength, modified: result.LastModified };
    } catch {
      return null;
    }
  }
}

class Storage {
  constructor() {
    this.local = null;
    this.s3 = null;
    this.syncing = new Map(); // name -> "upload" | "download"
  }

  init(config) {
    if (config.disksDir) {
      this.local = new LocalBackend(config.disksDir);
    }
    // Always clear s3, then conditionally reinitialize
    this.s3 = null;
    if (config.s3 && config.s3.endpoint && config.s3.bucket && config.s3.accessKeyId && config.s3.secretAccessKey) {
      this.s3 = new S3Backend(config.s3);
    }
  }

  // ── List ──

  async list() {
    const localDisks = this.local ? this.local.list() : [];
    let remoteDisks = [];
    let s3Error = null;
    if (this.s3) {
      try {
        remoteDisks = await this.s3.list();
      } catch (e) {
        s3Error = e.message;
        console.warn('[storage] S3 list failed, showing local only:', e.message);
      }
    }

    const allNames = new Set([
      ...localDisks.map(d => d.name),
      ...remoteDisks.map(d => d.name),
    ]);

    const entries = [];
    for (const name of allNames) {
      const localInfo = localDisks.find(d => d.name === name);
      const remoteInfo = remoteDisks.find(d => d.name === name);
      const syncing = this.syncing.get(name) || null;

      const entry = {
        name,
        local: !!localInfo,
        remote: !!remoteInfo,
        syncing,
      };

      if (localInfo) {
        entry.size = localInfo.size;
        entry.modified = localInfo.modified;
      } else if (remoteInfo) {
        entry.size = remoteInfo.size;
        entry.modified = remoteInfo.modified;
      }

      // Synced if both exist and have the same size
      entry.synced = !!(localInfo && remoteInfo && localInfo.size === remoteInfo.size);

      entries.push(entry);
    }

    return { disks: entries.sort((a, b) => a.name.localeCompare(b.name)), s3Error };
  }

  // ── Read ──

  async read(name) {
    if (this.local && this.local.exists(name)) {
      return this.local.read(name);
    }
    if (this.s3) {
      return this.s3.read(name);
    }
    throw new Error(`Disk not found: ${name}`);
  }

  // ── Write local ──

  async writeLocal(name, buffer) {
    if (this.local) {
      await this.local.ensureDir();
      this.local.write(name, buffer);
    }
  }

  // ── Upload (local -> remote) ──

  async upload(name, buffer, onProgress) {
    if (!this.s3) throw new Error('S3 not configured');
    this.syncing.set(name, 'upload');
    try {
      await this.s3.write(name, buffer, onProgress);
      this.syncing.delete(name);
    } catch (e) {
      this.syncing.delete(name);
      throw e;
    }
  }

  // ── Download (remote -> local) ──

  async download(name) {
    if (!this.s3) throw new Error('S3 not configured');
    if (!this.local) throw new Error('Local storage not configured');

    this.syncing.set(name, 'download');
    try {
      const buffer = await this.s3.read(name);
      await this.local.ensureDir();
      this.local.write(name, buffer);
      this.syncing.delete(name);
      return buffer;
    } catch (e) {
      this.syncing.delete(name);
      throw e;
    }
  }

  // ── Delete ──

  async deleteLocal(name) {
    if (this.local) {
      this.local.delete(name);
      this.syncing.delete(name);
    }
  }

  async deleteRemote(name) {
    if (this.s3) {
      await this.s3.delete(name);
      this.syncing.delete(name);
    }
  }

  async deleteBoth(name) {
    await Promise.all([
      this.deleteLocal(name),
      this.deleteRemote(name),
    ]);
  }

  // ── Status ──

  async status(name) {
    const localExists = this.local && this.local.exists(name);
    let remoteExists = false;
    let sizeLocal = null;
    let sizeRemote = null;

    if (localExists) {
      const stat = this.local.stat(name);
      sizeLocal = stat.size;
    }

    if (this.s3) {
      const head = await this.s3.head(name);
      if (head) {
        remoteExists = true;
        sizeRemote = head.size;
      }
    }

    return {
      local: localExists,
      remote: remoteExists,
      synced: localExists && remoteExists && sizeLocal === sizeRemote,
      sizeLocal,
      sizeRemote,
      syncing: this.syncing.get(name) || null,
    };
  }
}

module.exports = new Storage();
