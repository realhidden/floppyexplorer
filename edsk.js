#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

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

/**
 * DSK / EDSK basics:
 * - Main header: 256 bytes
 * - Standard DSK: track size at 0x32 (2 bytes, size in 256-byte units), same for all tracks
 * - Extended DSK (EDSK): track size table at 0x34..0xFF (204 bytes),
 *   each entry is 1 byte: size in 256-byte units for each track/side (0 = missing)
 * - Track data blocks follow sequentially, each begins with a 256-byte track header.
 */

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
    // EDSK: 204 bytes, 1 byte per track/side, each value is size/256
    const tableOff = 0x34;
    const tableLen = 204;
    if (count > tableLen) {
      throw new Error(`EDSK track table too small for geometry: tracks*sides=${count} > 204`);
    }
    for (let i = 0; i < count; i++) {
      const units = readU8(buf, tableOff + i);
      trackSizeTable[i] = units * 256; // 0 means missing track
    }
  } else {
    // Standard DSK: single size for all tracks (2 bytes at 0x32, in 256-byte units)
    const units = readU16LE(buf, 0x32);
    const size = units * 256;
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
        throw new Error(
          `Track data out of bounds at track=${t} side=${s} off=${off} size=${trkSize} filelen=${buf.length}`
        );
      }

      const trk = parseTrack(buf, off, trkSize);
      disk.trackIndex.push({
        track: t,
        side: s,
        offset: off,
        size: trkSize,
        ...trk,
      });

      off += trkSize;
    }
  }

  return disk;
}

function parseTrack(buf, off, trkSize) {
  if (trkSize < 256) throw new Error(`Track size too small: ${trkSize}`);

  const sig = readAscii(buf, off, 16);
  const trackNo = readU8(buf, off + 0x10);
  const sideNo = readU8(buf, off + 0x11);
  const sectorSizeCode = readU8(buf, off + 0x14); // N
  const sectorCount = readU8(buf, off + 0x15);

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
    const actualSize = readU16LE(buf, eoff + 6); // EDSK may specify real size
    const expectedSize = 128 << N;
    const size = actualSize ? actualSize : expectedSize;

    sectors.push({
      index: i,
      C, H, R, N,
      ST1, ST2,
      size,
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
    trackHeaderSig: sig.replace(/\0/g, ''),
    trackNo,
    sideNo,
    sectorSizeCode,
    sectorCount,
    sectors,
  };
}

function printSummary(disk) {
  console.log(`${disk.format} image`);
  if (disk.creator) console.log(`Creator: ${disk.creator}`);
  console.log(`Tracks: ${disk.tracks}, Sides: ${disk.sides}`);
  console.log('');

  for (const trk of disk.trackIndex) {
    const tag = `T${trk.track} S${trk.side}`;
    if (trk.missing) {
      console.log(`${tag}: <missing>`);
      continue;
    }
    console.log(`${tag}: offset=${trk.offset} size=${trk.size} sectors=${trk.sectorCount}`);
    for (const sec of trk.sectors) {
      const flags = [];
      if (sec.ST1 || sec.ST2) flags.push(`ST1=${hex(sec.ST1)}`, `ST2=${hex(sec.ST2)}`);
      if (sec.truncated) flags.push('TRUNC');
      console.log(
        `  #${sec.index} CHRN=${sec.C}/${sec.H}/${hex(sec.R)}/${sec.N} size=${sec.size}` +
        (flags.length ? ` [${flags.join(' ')}]` : '')
      );
    }
  }
}

function dumpSector(buf, disk, track, side, sectorId, outPath) {
  const trk = disk.trackIndex.find(x => x.track === track && x.side === side);
  if (!trk || trk.missing) throw new Error(`Track not found or missing: T${track} S${side}`);

  const sec = trk.sectors.find(x => x.R === sectorId);
  if (!sec) throw new Error(`Sector R=${sectorId} not found on T${track} S${side}`);

  if (sec.dataOffset == null) throw new Error('Sector has no dataOffset (corrupt track?)');

  const start = sec.dataOffset;
  const end = start + sec.size;
  const slice = buf.slice(start, Math.min(end, buf.length));

  fs.writeFileSync(outPath, slice);
  console.log(`Wrote ${slice.length} bytes to ${outPath}`);
}

function usage() {
  console.log(`Usage:
  node edsk-view.js <image.dsk>

  node edsk-view.js <image.dsk> --dump --track <n> --side <n> --sector <id> --out <file>

Notes:
  - --sector is the sector "R" id (decimal or hex like 0xC1)
`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) return usage();

  const file = args[0];
  const buf = fs.readFileSync(file);
  const disk = parseDisk(buf);

  const hasDump = args.includes('--dump');
  if (!hasDump) {
    printSummary(disk);
    return;
  }

  const getArg = (name) => {
    const i = args.indexOf(name);
    if (i === -1 || i + 1 >= args.length) return null;
    return args[i + 1];
  };

  const track = Number(getArg('--track'));
  const side = Number(getArg('--side'));
  const sectorStr = getArg('--sector');
  const out = getArg('--out') || path.basename(file) + `.T${track}S${side}.R${sectorStr}.bin`;

  if (!Number.isFinite(track) || !Number.isFinite(side) || sectorStr == null) {
    throw new Error('Missing --track/--side/--sector');
  }

  const sectorId = sectorStr.startsWith('0x') ? parseInt(sectorStr, 16) : Number(sectorStr);
  if (!Number.isFinite(sectorId)) throw new Error(`Invalid --sector: ${sectorStr}`);

  dumpSector(buf, disk, track, side, sectorId, out);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
}

