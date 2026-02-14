'use strict';

const { spawn } = require('child_process');
const path = require('path');

// Neutralino sends connection info via CLI args
// We only need to launch the Node server as a child process
// The Neutralino webview will connect to it directly

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SERVER_PATH = path.join(PROJECT_ROOT, 'server.js');
const NODE_BIN = process.execPath; // absolute path to the node binary running us

console.log('[ext] Node binary:', NODE_BIN);
console.log('[ext] Project root:', PROJECT_ROOT);
console.log('[ext] Server path:', SERVER_PATH);
console.log('[ext] Starting Node server...');

const child = spawn(NODE_BIN, [SERVER_PATH], {
  cwd: PROJECT_ROOT,
  stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...process.env, PORT: '3141' },
});

child.on('error', (err) => {
  console.error('[ext] Failed to start server:', err.message);
  process.exit(1);
});

child.on('exit', (code) => {
  console.log(`[ext] Server exited with code ${code}`);
  process.exit(code || 0);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  child.kill('SIGTERM');
});

process.on('SIGINT', () => {
  child.kill('SIGTERM');
});

// If parent process dies, clean up
process.on('disconnect', () => {
  child.kill('SIGTERM');
  process.exit(0);
});
