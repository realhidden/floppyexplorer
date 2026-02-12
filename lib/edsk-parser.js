'use strict';

const fs = require('fs');

function readAscii(buf, off, len) {
  return buf.slice(off, off + len).toString('ascii');
}
function readU8(buf, off) {
  return buf.readUInt8(off);
}
function readU16LE(buf, off) {
  return buf.readUInt16LE(off);
}
function hex(n, w = 2) {
  return '0x' + n.toString(16).toUpperCase().padStart(w, '0');
}

// Sector size code N -> actual bytes
function sectorSize(N) {
  return 128 << N;
}

// Detect filesystem type from boot sector
function detectFilesystem(buf, disk) {
  const trk0 = disk.trackIndex.find(t => t.track === 0 && t.side === 0 && !t.missing);
  if (!trk0 || trk0.sectors.length === 0) return { type: 'unknown' };

  const sec = trk0.sectors[0];
  if (sec.dataOffset == null) return { type: 'unknown' };

  const boot = buf.slice(sec.dataOffset, sec.dataOffset + Math.min(sec.size, 512));
  if (boot.length < 64) return { type: 'unknown' };

  // Check for FAT BPB
  if (boot[0] === 0xEB || boot[0] === 0xE9) {
    const oem = boot.slice(3, 11).toString('ascii').trim();
    const bytesPerSector = boot.readUInt16LE(11);
    const sectorsPerCluster = boot[13];
    const reservedSectors = boot.readUInt16LE(14);
    const fatCount = boot[16];
    const rootEntries = boot.readUInt16LE(17);
    const totalSectors = boot.readUInt16LE(19) || boot.readUInt32LE(32);
    const mediaDescriptor = boot[21];
    const sectorsPerFAT = boot.readUInt16LE(22);
    const sectorsPerTrack = boot.readUInt16LE(24);
    const heads = boot.readUInt16LE(26);
    const volumeLabel = boot.slice(43, 54).toString('ascii').trim();
    const fsType = boot.slice(54, 62).toString('ascii').trim();

    return {
      type: 'FAT',
      oem,
      bytesPerSector,
      sectorsPerCluster,
      reservedSectors,
      fatCount,
      rootEntries,
      totalSectors,
      mediaDescriptor: hex(mediaDescriptor),
      sectorsPerFAT,
      sectorsPerTrack,
      heads,
      volumeLabel: volumeLabel.replace(/\0/g, ''),
      fsType: fsType.replace(/\0/g, ''),
    };
  }

  // Check for Amstrad CPC / CP/M
  if (trk0.sectors.some(s => s.R >= 0xC1 && s.R <= 0xC9)) {
    return { type: 'CPC/CP/M', note: 'Amstrad CPC sector IDs detected' };
  }

  return { type: 'unknown' };
}

// Read directory entries from a FAT12 disk
function readFATDirectory(buf, disk, fs_info) {
  if (fs_info.type !== 'FAT') return [];

  const bps = fs_info.bytesPerSector || 512;
  const rootStart = (fs_info.reservedSectors + fs_info.fatCount * fs_info.sectorsPerFAT) * bps;
  const rootSize = fs_info.rootEntries * 32;

  // Build a flat sector data buffer from the disk
  const flat = buildFlatImage(buf, disk);
  if (!flat || flat.length < rootStart + rootSize) return [];

  const entries = [];
  for (let i = 0; i < fs_info.rootEntries; i++) {
    const off = rootStart + i * 32;
    const first = flat[off];
    if (first === 0x00) break; // no more entries
    if (first === 0xE5) continue; // deleted
    if (flat[off + 11] === 0x0F) continue; // LFN entry

    const rawName = flat.slice(off, off + 8).toString('ascii').trim();
    const rawExt = flat.slice(off + 8, off + 11).toString('ascii').trim();
    const attr = flat[off + 11];
    const fileSize = flat.readUInt32LE(off + 28);
    const cluster = flat.readUInt16LE(off + 26);
    const time = flat.readUInt16LE(off + 22);
    const date = flat.readUInt16LE(off + 24);

    const name = rawExt ? `${rawName}.${rawExt}` : rawName;

    const year = ((date >> 9) & 0x7F) + 1980;
    const month = (date >> 5) & 0x0F;
    const day = date & 0x1F;
    const hour = (time >> 11) & 0x1F;
    const min = (time >> 5) & 0x3F;

    entries.push({
      name,
      attr,
      isDir: !!(attr & 0x10),
      isHidden: !!(attr & 0x02),
      isSystem: !!(attr & 0x04),
      isReadOnly: !!(attr & 0x01),
      isVolumeLabel: !!(attr & 0x08),
      size: fileSize,
      cluster,
      date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      time: `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`,
    });
  }

  return entries;
}

// Build a flat byte image from EDSK sectors (sequential, by sector R id)
// Missing tracks are filled with zeroes to preserve correct LBA offsets
function buildFlatImage(buf, disk) {
  // Determine sector size from first available track
  const firstTrack = disk.trackIndex.find(t => !t.missing && t.sectors.length > 0);
  if (!firstTrack) return Buffer.alloc(0);
  const sectorBytes = firstTrack.sectors[0].size;
  const sectorsPerTrack = firstTrack.sectorCount;
  const trackBytes = sectorsPerTrack * sectorBytes;

  const parts = [];
  for (const trk of disk.trackIndex) {
    if (trk.missing) {
      // Insert zeroed placeholder to maintain correct offsets
      parts.push(Buffer.alloc(trackBytes));
      continue;
    }
    const sorted = [...trk.sectors].sort((a, b) => a.R - b.R);
    for (const sec of sorted) {
      if (sec.dataOffset == null) {
        parts.push(Buffer.alloc(sec.size));
        continue;
      }
      parts.push(buf.slice(sec.dataOffset, sec.dataOffset + sec.size));
    }
  }
  return Buffer.concat(parts);
}

function parseDisk(buf) {
  if (buf.length < 256) throw new Error('File too small');

  const sig = readAscii(buf, 0, 34);
  const isEDSK = sig.startsWith('EXTENDED CPC DSK File');
  const isDSK = sig.startsWith('MV - CPC') || sig.startsWith('MV - CPCEMU');

  if (!isEDSK && !isDSK) {
    throw new Error(`Unknown signature: ${JSON.stringify(sig)}`);
  }

  const creator = readAscii(buf, 34, 14).replace(/\0/g, '').trim();
  const tracks = readU8(buf, 0x30);
  const sides = readU8(buf, 0x31);

  if (tracks === 0 || sides === 0) throw new Error(`Invalid geometry tracks=${tracks} sides=${sides}`);

  const count = tracks * sides;
  const trackSizeTable = new Array(count);

  if (isEDSK) {
    const tableOff = 0x34;
    for (let i = 0; i < count; i++) {
      trackSizeTable[i] = readU8(buf, tableOff + i) * 256;
    }
  } else {
    const size = readU16LE(buf, 0x32) * 256;
    for (let i = 0; i < count; i++) trackSizeTable[i] = size;
  }

  const disk = {
    format: isEDSK ? 'EDSK' : 'DSK',
    creator,
    tracks,
    sides,
    trackSizeTable,
    trackIndex: [],
  };

  let off = 256;

  for (let t = 0; t < tracks; t++) {
    for (let s = 0; s < sides; s++) {
      const idx = t * sides + s;
      const trkSize = trackSizeTable[idx] || 0;

      if (trkSize === 0) {
        disk.trackIndex.push({ track: t, side: s, offset: null, size: 0, missing: true, sectors: [] });
        continue;
      }

      if (off + trkSize > buf.length) {
        throw new Error(`Track data out of bounds at track=${t} side=${s}`);
      }

      const trk = parseTrack(buf, off, trkSize);
      disk.trackIndex.push({ track: t, side: s, offset: off, size: trkSize, ...trk });
      off += trkSize;
    }
  }

  // Detect filesystem
  disk.filesystem = detectFilesystem(buf, disk);

  return disk;
}

function parseTrack(buf, off, trkSize) {
  if (trkSize < 256) throw new Error(`Track size too small: ${trkSize}`);

  const sig = readAscii(buf, off, 12).replace(/\0/g, '').trim();
  const trackNo = readU8(buf, off + 0x10);
  const sideNo = readU8(buf, off + 0x11);
  const dataRate = readU8(buf, off + 0x12);
  const recMode = readU8(buf, off + 0x13);
  const sectorSizeCode = readU8(buf, off + 0x14);
  const sectorCount = readU8(buf, off + 0x15);
  const gap3 = readU8(buf, off + 0x16);
  const filler = readU8(buf, off + 0x17);

  const sectors = [];
  const sectorInfoBase = off + 0x18;

  for (let i = 0; i < sectorCount; i++) {
    const eoff = sectorInfoBase + i * 8;
    const C = readU8(buf, eoff + 0);
    const H = readU8(buf, eoff + 1);
    const R = readU8(buf, eoff + 2);
    const N = readU8(buf, eoff + 3);
    const ST1 = readU8(buf, eoff + 4);
    const ST2 = readU8(buf, eoff + 5);
    const actualSize = readU16LE(buf, eoff + 6);
    const expectedSize = sectorSize(N);
    const size = actualSize ? actualSize : expectedSize;

    const hasError = !!(ST1 || ST2);
    const errorFlags = [];
    if (ST1 & 0x80) errorFlags.push('end-of-cylinder');
    if (ST1 & 0x20) errorFlags.push('data-error-in-id');
    if (ST1 & 0x04) errorFlags.push('no-data');
    if (ST1 & 0x02) errorFlags.push('not-writable');
    if (ST1 & 0x01) errorFlags.push('missing-address-mark');
    if (ST2 & 0x40) errorFlags.push('control-mark');
    if (ST2 & 0x20) errorFlags.push('data-error-in-data');
    if (ST2 & 0x04) errorFlags.push('wrong-cylinder');
    if (ST2 & 0x02) errorFlags.push('bad-cylinder');
    if (ST2 & 0x01) errorFlags.push('missing-data-mark');

    sectors.push({
      index: i,
      C, H, R, N,
      ST1, ST2,
      size,
      expectedSize,
      hasError,
      errorFlags,
      dataOffset: null,
    });
  }

  let dataOff = off + 256;
  const trackEnd = off + trkSize;

  for (const sec of sectors) {
    sec.dataOffset = dataOff;
    if (dataOff + sec.size > trackEnd) {
      sec.truncated = true;
      break;
    }
    dataOff += sec.size;
  }

  return {
    trackHeaderSig: sig,
    trackNo,
    sideNo,
    dataRate,
    recMode,
    sectorSizeCode,
    sectorCount,
    gap3,
    filler,
    sectors,
  };
}

// Read sector raw bytes
function readSectorData(buf, disk, track, side, sectorR) {
  const trk = disk.trackIndex.find(t => t.track === track && t.side === side);
  if (!trk || trk.missing) return null;

  const sec = trk.sectors.find(s => s.R === sectorR);
  if (!sec || sec.dataOffset == null) return null;

  return buf.slice(sec.dataOffset, sec.dataOffset + sec.size);
}

// Parse from file path
function parseFile(filePath) {
  const buf = fs.readFileSync(filePath);
  const disk = parseDisk(buf);
  return { buf, disk };
}

module.exports = {
  parseDisk,
  parseFile,
  readSectorData,
  readFATDirectory,
  buildFlatImage,
  detectFilesystem,
  hex,
};
