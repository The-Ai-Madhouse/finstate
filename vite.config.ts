import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Fast port for både dev og preview: localStorage er bundet til origin (protokol+host+port),
// så en anden port ville se ud som en tom app.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true, host: '127.0.0.1' },
  preview: { port: 5173, strictPort: true, host: '127.0.0.1' },
  test: { environment: 'node' },
});
