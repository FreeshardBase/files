import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
export default defineConfig({
  plugins: [vue()],
  server: { proxy: { '/api': 'http://localhost:3005', '/auth': 'http://localhost:3005' } },
  test: { environment: 'happy-dom' },
});
