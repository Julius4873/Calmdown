import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { target: ['safari15', 'chrome107', 'firefox104', 'edge107'] },
});
