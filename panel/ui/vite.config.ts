import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:9090',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        // Stable vendor chunks so heavy libraries keep their content hash when
        // only app code changes — repeat visits hit the browser cache instead of
        // re-downloading recharts / xterm / React. vite 8 (rolldown) requires the
        // function form of manualChunks, not the object map.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return;
          if (id.includes('recharts') || id.includes('/d3-') || id.includes('victory')) return 'recharts';
          if (id.includes('@xterm')) return 'xterm';
          if (id.includes('react') || id.includes('scheduler')) return 'react';
        },
      },
    },
  },
});
