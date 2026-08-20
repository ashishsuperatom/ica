// Complete 16-color ANSI palette for the agent xterm panels. Without this, xterm falls back to its built-in
// defaults where "black" (~#2e3436) sits almost on top of our dark background, so any glyph the TUI prints in
// ANSI-black/dim vanishes ("dark text getting lost"). Here black + bright-black are LIFTED to legible greys, so
// NO colour can collide with a dark background. Spread into each terminal's theme AFTER its own background/
// foreground: `theme: { background, foreground, ...ANSI }`.
export const ANSI = {
  black: '#6b6b6b', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
  blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#e6e2da',
  brightBlack: '#8a8a8a', brightRed: '#e88b93', brightGreen: '#b5daa0', brightYellow: '#f0d5a0',
  brightBlue: '#82c0f5', brightMagenta: '#d79fe6', brightCyan: '#7fcbd4', brightWhite: '#ffffff',
}
