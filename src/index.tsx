import React from 'react';
import { render } from 'ink';
import App from './App.js';

// Switch to alternate screen buffer to prevent shell scrollback flicker
if (process.stdout.isTTY) {
  process.stdout.write('\x1b[?1049h\x1b[H');
}

render(<App />);

const cleanup = () => {
  if (process.stdout.isTTY) {
    process.stdout.write('\x1b[?1049l');
  }
};

process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(0);
});
