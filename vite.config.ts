import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

/**
 * Development only: serve the serverless handlers in api/ from the Vite dev
 * server, including streamed responses, so `npm run dev` runs the complete
 * product locally. Values already in the environment win over .env.
 */
function devApi(): Plugin {
  return {
    name: 'levelproof-dev-api',
    apply: 'serve',
    configureServer(server) {
      const env = loadEnv(server.config.mode, process.cwd(), '');
      for (const [key, value] of Object.entries(env)) {
        if (process.env[key] === undefined) process.env[key] = value;
      }
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? '';
        const route = url.split('?')[0];
        if (route !== '/api/compile' && route !== '/api/explain') {
          next();
          return;
        }
        try {
          const handler = (await server.ssrLoadModule(`/api/${route.slice('/api/'.length)}.ts`)) as {
            POST: (request: Request) => Promise<Response>;
          };
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const controller = new AbortController();
          res.on('close', () => {
            if (!res.writableEnded) controller.abort();
          });
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (typeof value === 'string') headers.set(key, value);
            else if (Array.isArray(value)) headers.set(key, value.join(', '));
          }
          const response = await handler.POST(
            new Request(`http://localhost${url}`, {
              method: req.method ?? 'POST',
              headers,
              ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
              signal: controller.signal,
            }),
          );
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          if (response.body !== null) {
            const reader = response.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(value);
            }
          }
          res.end();
        } catch (error) {
          server.config.logger.error(`[dev-api] ${error instanceof Error ? error.message : String(error)}`);
          if (!res.headersSent) res.statusCode = 500;
          res.end(JSON.stringify({ error: 'dev_api_failed' }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devApi()],
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
