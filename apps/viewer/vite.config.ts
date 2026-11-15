import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // Fixed so the fixture apps and the docs can refer to one URL, and distinct
    // from the fixture ports so both can run at once.
    port: 5180,
    strictPort: true,
  },
});
