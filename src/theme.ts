import { darkTheme } from './components/ui/_core.js';

// Custom theme for the TUI harness
export const myTheme = {
  ...darkTheme,
  colors: {
    ...darkTheme.colors,
    primary: '#00ff88',
    secondary: '#ff00aa',
    accent: '#00aaff',
    background: '#1a1a2e',
    foreground: '#ffffff',
    border: '#666666',
    focus: '#00ff88',
    selection: '#00aaff',
    success: '#00ff88',
    warning: '#ffaa00',
    error: '#ff0044',
    info: '#00aaff',
    muted: '#888888',
    text: '#ffffff',
    textInverse: '#000000'
  },
  border: 'rounded' as const,
  spacing: {
    small: 1,
    medium: 2,
    large: 3
  }
};

// Light theme alternative
export const lightTheme = {
  ...darkTheme,
  colors: {
    ...darkTheme.colors,
    primary: '#0088ff',
    secondary: '#ff00aa',
    accent: '#00ff88',
    background: '#ffffff',
    foreground: '#000000',
    border: '#888888',
    focus: '#0088ff',
    selection: '#00ff88',
    success: '#00ff88',
    warning: '#ffaa00',
    error: '#ff0044',
    info: '#0088ff',
    muted: '#888888',
    text: '#000000',
    textInverse: '#ffffff'
  },
  border: 'single' as const
};