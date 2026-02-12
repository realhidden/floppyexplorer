'use strict';

const { spawn, execFile } = require('child_process');

const GW_BIN = 'gw';

// Internal lock for processes we spawned
let gwOurProc = null;

// Check if ANY gw process is running system-wide (ours or external)
function isGwRunning() {
  try {
    const { execSync } = require('child_process');
    const out = execSync('pgrep -f "gw (read|write|convert|erase|info|rpm|seek|clean)"', {
      timeout: 2000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().length > 0;
  } catch {
    // pgrep returns exit code 1 when no match — that means no gw running
    return false;
  }
}

function isBusy() {
  return !!gwOurProc || isGwRunning();
}

function guardBusy() {
  if (gwOurProc) throw new Error('Greaseweazle is busy — our read is in progress');
  if (isGwRunning()) throw new Error('Greaseweazle is busy — an external gw process is running');
}

function run(args, opts = {}) {
  guardBusy();
  return new Promise((resolve, reject) => {
    execFile(GW_BIN, args, { timeout: opts.timeout || 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

// Get device info
async function info() {
  const { stdout } = await run(['info']);
  const lines = stdout.split('\n');
  const result = {};
  for (const line of lines) {
    const m = line.match(/^\s*(\w[\w\s]*?):\s+(.+)$/);
    if (m) result[m[1].trim().toLowerCase().replace(/\s+/g, '_')] = m[2].trim();
  }
  return result;
}

// Measure drive RPM
async function rpm() {
  const { stdout } = await run(['rpm'], { timeout: 15000 });
  const m = stdout.match(/([\d.]+)\s*RPM/i);
  return m ? parseFloat(m[1]) : null;
}

// Read a disk to a file with progress streaming
function read(outputPath, opts = {}) {
  guardBusy();

  const args = ['read'];

  if (opts.format) args.push('--format', opts.format);
  if (opts.tracks) args.push('--tracks', opts.tracks);
  if (opts.revs) args.push('--revs', String(opts.revs));
  if (opts.retries) args.push('--retries', String(opts.retries));

  args.push(outputPath);

  return new Promise((resolve, reject) => {
    const proc = spawn(GW_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    gwOurProc = proc;
    let stderr = '';
    let lastProgress = '';

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;

      const lines = text.split(/\r?\n|\r/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          lastProgress = trimmed;
          if (opts.onProgress) opts.onProgress(trimmed);
        }
      }
    });

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      const lines = text.split(/\r?\n|\r/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && opts.onProgress) opts.onProgress(trimmed);
      }
    });

    proc.on('close', (code) => {
      gwOurProc = null;
      if (code === 0) {
        resolve({ outputPath, lastProgress });
      } else {
        reject(new Error(`gw read failed (code ${code}): ${stderr}`));
      }
    });

    proc.on('error', (err) => {
      gwOurProc = null;
      reject(err);
    });

    // Allow cancellation
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => {
        proc.kill('SIGTERM');
      });
    }
  });
}

// List supported formats
async function formats() {
  const { stdout } = await run(['read', '--help'], { timeout: 5000 }).catch(() => ({ stdout: '' }));
  const m = stdout.match(/FORMAT options:\n([\s\S]+?)(?:\n\n|Supported)/);
  if (!m) return [];
  return m[1].trim().split(/\s+/).filter(Boolean);
}

module.exports = { info, rpm, read, formats, run, isBusy };
