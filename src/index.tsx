import React from 'react';
import { render } from '@nemesis-oss/termina-core';
import App from './App.js';
import { initLogger } from './logger.js';

initLogger();

// Fullscreen (alternate screen) is the default — the app owns the whole
// viewport, vim/htop style, so streaming output never spills into the
// native scrollback and the frame never crawls line by line. Opt out with
// `--inline` (or AGENT_TUI_INLINE=1) to render inline in the normal buffer.
const inline =
  process.argv.includes('--inline') ||
  process.env.AGENT_TUI_INLINE === '1';

// Termina manages alternate screen buffer and mouse tracking cleanly on mount and exit.
const instance = render(<App />, {
  alternateScreen: !inline,
  incrementalRendering: true,
  maxFps: 30,
  mouse: true,
});

await instance.waitUntilExit();
