import React from 'react';
import { render } from '@nemesis-oss/termina-core';
import App from './App.js';
import { initLogger } from './logger.js';

initLogger();

// Termina manages alternate screen buffer and mouse tracking cleanly on mount and exit
const instance = render(<App />, {
  alternateScreen: true,
  incrementalRendering: true,
  maxFps: 30,
  mouse: true,
});

await instance.waitUntilExit();

