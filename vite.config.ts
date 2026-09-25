import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          // Keep stable dependencies cached across app/scene edits. Three's
          // existing core/renderer boundary avoids one oversized engine chunk.
          // Higher-priority groups claim shared dependencies first.
          groups: [
            { name: 'three-core', test: /node_modules[\\/]three[\\/]build[\\/]three\.core\.js$/, priority: 30 },
            { name: 'three-renderer', test: /node_modules[\\/]three[\\/]/, priority: 20 },
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 10 },
            { name: 'validation', test: /node_modules[\\/]zod[\\/]/, priority: 10 },
          ],
        },
      },
    },
  },
});
