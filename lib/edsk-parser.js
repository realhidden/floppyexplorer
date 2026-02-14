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

// Extract UTF-16LE characters from an LFN entry, filtering out 0xFFFF padding
function extractLFNChars(flat, off) {
  const chars = [];
  // LFN name chars are stored in 3 disjoint fields:
  // offset 1-10 (5 UTF-16LE chars), 14-25 (6 chars), 28-31 (2 chars)
  const ranges = [[1, 5], [14, 6], [28, 2]];
  for (const [start, count] of ranges) {
    for (let j = 0; j < count; j++) {
      const pos = off + start + j * 2;
      if (pos + 1 >= flat.length) break;
      const code = flat.readUInt16LE(pos);
      if (code === 0x0000 || code === 0xFFFF) return chars;
      chars.push(String.fromCharCode(code));
    }
  }
  return chars;
}

// Parse a 32-byte SFN directory entry's timestamp
function parseDirEntryTime(flat, off) {
  const time = flat.readUInt16LE(off + 22);
  const date = flat.readUInt16LE(off + 24);
  const year = ((date >> 9) & 0x7F) + 1980;
  const month = (date >> 5) & 0x0F;
  const day = date & 0x1F;
  const hour = (time >> 11) & 0x1F;
  const min = (time >> 5) & 0x3F;
  return {
    date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    time: `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`,
  };
}

// Parse 32-byte directory entries from a buffer region (with VFAT LFN support)
function parseDirEntries(flat, startOff, maxEntries) {
  const entries = [];
  let lfnParts = [];

  for (let i = 0; i < maxEntries; i++) {
    const off = startOff + i * 32;
    if (off + 32 > flat.length) break;
    const first = flat[off];
    if (first === 0x00) break; // end of directory
    if (first === 0xE5) { lfnParts = []; continue; } // deleted entry

    const attr = flat[off + 11];

    // LFN entry: attribute 0x0F (read-only | hidden | system | volume)
    if (attr === 0x0F) {
      const seq = flat[off] & 0x3F;
      const isLast = !!(flat[off] & 0x40);
      const chars = extractLFNChars(flat, off);
      if (isLast) lfnParts = [];
      lfnParts[seq - 1] = chars.join('');
      continue;
    }

    const rawName = flat.slice(off, off + 8).toString('ascii').trim();
    const rawExt = flat.slice(off + 8, off + 11).toString('ascii').trim();
    const sfn = rawExt ? `${rawName}.${rawExt}` : rawName;

    let longName = null;
    if (lfnParts.length > 0) {
      longName = lfnParts.join('');
      lfnParts = [];
    }

    const fileSize = flat.readUInt32LE(off + 28);
    const cluster = flat.readUInt16LE(off + 26);
    const ts = parseDirEntryTime(flat, off);

    entries.push({
      name: longName || sfn,
      shortName: sfn,
      longName,
      attr,
      isDir: !!(attr & 0x10),
      isHidden: !!(attr & 0x02),
      isSystem: !!(attr & 0x04),
      isReadOnly: !!(attr & 0x01),
      isVolumeLabel: !!(attr & 0x08),
      size: fileSize,
      cluster,
      ...ts,
    });

    lfnParts = [];
  }
  return entries;
}

// Read directory entries from a FAT12 disk, recursing into subdirectories
function readFATDirectory(buf, disk, fs_info) {
  if (fs_info.type !== 'FAT') return [];

  const bps = fs_info.bytesPerSector || 512;
  const spc = fs_info.sectorsPerCluster || 1;
  const clusterBytes = bps * spc;
  const rootStart = (fs_info.reservedSectors + fs_info.fatCount * fs_info.sectorsPerFAT) * bps;
  const rootSize = fs_info.rootEntries * 32;
  const dataStart = (fs_info.reservedSectors +
    fs_info.fatCount * fs_info.sectorsPerFAT +
    Math.ceil((fs_info.rootEntries * 32) / bps)) * bps;

  const flat = buildFlatImage(buf, disk);
  if (!flat || flat.length < rootStart + rootSize) return [];

  const fat = readFAT12Table(flat, fs_info);

  // Read a subdirectory's entries by following its cluster chain
  function readSubdir(startCluster) {
    const chunks = [];
    let cluster = startCluster;
    while (cluster >= 2 && cluster < 0xFF8) {
      const offset = dataStart + (cluster - 2) * clusterBytes;
      if (offset + clusterBytes > flat.length) break;
      chunks.push(flat.slice(offset, offset + clusterBytes));
      cluster = fat[cluster];
    }
    if (chunks.length === 0) return [];
    const dirBuf = Buffer.concat(chunks);
    return parseDirEntries(dirBuf, 0, Math.floor(dirBuf.length / 32));
  }

  // Recursively collect all entries with path prefixes
  function walk(entries, prefix) {
    const result = [];
    for (const entry of entries) {
      // Skip . and .. directory entries
      if (entry.shortName === '.' || entry.shortName === '..') continue;

      const fullPath = prefix ? prefix + '/' + entry.name : entry.name;
      result.push({ ...entry, name: fullPath, path: fullPath });

      if (entry.isDir && entry.cluster >= 2) {
        const subEntries = readSubdir(entry.cluster);
        result.push(...walk(subEntries, fullPath));
      }
    }
    return result;
  }

  // Parse root directory
  const rootEntries = parseDirEntries(flat, rootStart, fs_info.rootEntries);
  return walk(rootEntries, '');
}

// Scan directory entries for deleted files (0xE5 marker)
function parseDeletedEntries(flat, startOff, maxEntries) {
  const entries = [];
  let lfnParts = [];

  for (let i = 0; i < maxEntries; i++) {
    const off = startOff + i * 32;
    if (off + 32 > flat.length) break;
    const first = flat[off];
    if (first === 0x00) break;

    const attr = flat[off + 11];

    // Collect LFN parts (deleted LFN entries also start with 0xE5)
    if (first === 0xE5 && attr === 0x0F) {
      const seq = flat[off] & 0x3F; // masked — but first byte is 0xE5 for deleted LFN
      // Can't reliably reconstruct deleted LFN sequences, skip
      continue;
    }

    if (attr === 0x0F) { lfnParts = []; continue; } // live LFN entry
    if (first !== 0xE5) { lfnParts = []; continue; } // live entry, skip

    // This is a deleted 8.3 entry
    // First character is lost (replaced with 0xE5), show as '?'
    const rawNameBytes = flat.slice(off, off + 8);
    const rawName = '?' + rawNameBytes.slice(1).toString('ascii').trim();
    const rawExt = flat.slice(off + 8, off + 11).toString('ascii').trim();
    const sfn = rawExt ? `${rawName}.${rawExt}` : rawName;

    const fileSize = flat.readUInt32LE(off + 28);
    const cluster = flat.readUInt16LE(off + 26);
    const ts = parseDirEntryTime(flat, off);

    // Skip directory entries, volume labels, and entries with no cluster/size
    if (attr & 0x10 || attr & 0x08) continue;
    if (cluster < 2 || fileSize === 0) continue;

    entries.push({
      name: sfn,
      shortName: sfn,
      attr,
      isDeleted: true,
      size: fileSize,
      cluster,
      ...ts,
    });
  }
  return entries;
}

// Find deleted files across root directory and any recoverable subdirectories
function readDeletedFiles(buf, disk, fs_info) {
  if (fs_info.type !== 'FAT') return [];

  const bps = fs_info.bytesPerSector || 512;
  const spc = fs_info.sectorsPerCluster || 1;
  const clusterBytes = bps * spc;
  const rootStart = (fs_info.reservedSectors + fs_info.fatCount * fs_info.sectorsPerFAT) * bps;
  const rootSize = fs_info.rootEntries * 32;
  const dataStart = (fs_info.reservedSectors +
    fs_info.fatCount * fs_info.sectorsPerFAT +
    Math.ceil((fs_info.rootEntries * 32) / bps)) * bps;

  const flat = buildFlatImage(buf, disk);
  if (!flat || flat.length < rootStart + rootSize) return [];

  const fat = readFAT12Table(flat, fs_info);
  const totalClusters = fat.length;

  const deleted = parseDeletedEntries(flat, rootStart, fs_info.rootEntries);

  // Assess recoverability for each deleted file
  for (const entry of deleted) {
    const clustersNeeded = Math.ceil(entry.size / clusterBytes);

    // Check if starting cluster's FAT entry is free
    if (entry.cluster >= totalClusters || fat[entry.cluster] !== 0) {
      entry.recoverable = false;
      entry.reason = 'Start cluster reallocated';
      continue;
    }

    // Check if enough contiguous clusters from start are free
    let freeCount = 0;
    for (let c = entry.cluster; c < entry.cluster + clustersNeeded && c < totalClusters; c++) {
      if (fat[c] !== 0) break;
      freeCount++;
    }

    if (freeCount >= clustersNeeded) {
      entry.recoverable = true;
      entry.reason = `${clustersNeeded} cluster${clustersNeeded > 1 ? 's' : ''} free`;
    } else {
      entry.recoverable = false;
      entry.reason = `Only ${freeCount}/${clustersNeeded} clusters free`;
    }
  }

  return deleted;
}

// Recover a deleted file by reading contiguous clusters (FAT chain is zeroed)
function readDeletedFileData(buf, disk, fs_info, startCluster, fileSize) {
  if (fs_info.type !== 'FAT' || startCluster < 2) return null;

  const flat = buildFlatImage(buf, disk);
  if (!flat) return null;

  const bps = fs_info.bytesPerSector || 512;
  const spc = fs_info.sectorsPerCluster || 1;
  const clusterBytes = bps * spc;
  const dataStart = (fs_info.reservedSectors +
    fs_info.fatCount * fs_info.sectorsPerFAT +
    Math.ceil((fs_info.rootEntries * 32) / bps)) * bps;

  // Read contiguous clusters starting from startCluster
  const clustersNeeded = Math.ceil(fileSize / clusterBytes);
  const chunks = [];
  let remaining = fileSize;

  for (let i = 0; i < clustersNeeded && remaining > 0; i++) {
    const cluster = startCluster + i;
    const offset = dataStart + (cluster - 2) * clusterBytes;
    const toRead = Math.min(clusterBytes, remaining);
    if (offset + toRead > flat.length) break;
    chunks.push(flat.slice(offset, offset + toRead));
    remaining -= toRead;
  }

  return chunks.length > 0 ? Buffer.concat(chunks) : null;
}

// Read FAT12 table from flat image
function readFAT12Table(flat, fs_info) {
  const bps = fs_info.bytesPerSector || 512;
  const fatStart = fs_info.reservedSectors * bps;
  const totalClusters = Math.floor(fs_info.totalSectors / fs_info.sectorsPerCluster) + 2;
  const fat = new Uint16Array(totalClusters);

  for (let i = 0; i < totalClusters; i++) {
    const byteIndex = fatStart + Math.floor(i * 3 / 2);
    if (byteIndex + 1 >= flat.length) break;
    const pair = flat.readUInt16LE(byteIndex);
    fat[i] = (i & 1) ? (pair >> 4) & 0xFFF : pair & 0xFFF;
  }
  return fat;
}

// Follow a FAT12 cluster chain and return the file data
function readFileData(buf, disk, fs_info, startCluster, fileSize) {
  if (fs_info.type !== 'FAT' || startCluster < 2) return null;

  const flat = buildFlatImage(buf, disk);
  if (!flat) return null;

  const bps = fs_info.bytesPerSector || 512;
  const spc = fs_info.sectorsPerCluster || 1;
  const clusterBytes = bps * spc;
  const dataStart = (fs_info.reservedSectors +
    fs_info.fatCount * fs_info.sectorsPerFAT +
    Math.ceil((fs_info.rootEntries * 32) / bps)) * bps;

  const fat = readFAT12Table(flat, fs_info);
  const chunks = [];
  let cluster = startCluster;
  let remaining = fileSize;

  while (cluster >= 2 && cluster < 0xFF8 && remaining > 0) {
    const offset = dataStart + (cluster - 2) * clusterBytes;
    const toRead = Math.min(clusterBytes, remaining);
    if (offset + toRead > flat.length) break;
    chunks.push(flat.slice(offset, offset + toRead));
    remaining -= toRead;
    cluster = fat[cluster];
  }

  return Buffer.concat(chunks);
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
  readDeletedFiles,
  readFileData,
  readDeletedFileData,
  buildFlatImage,
  detectFilesystem,
  hex,
};
