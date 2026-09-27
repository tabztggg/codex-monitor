import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config';
const target = process.env.CODEX_MONITOR_PREVIEW_API || 'http://127.0.0.1:4201';
export default mergeConfig(base, defineConfig({
  server: { host: '127.0.0.1', port: 4202, strictPort: true,
    proxy: { '/api': { target, changeOrigin: true }, '/ws': { target, ws: true } }
  }
}));
