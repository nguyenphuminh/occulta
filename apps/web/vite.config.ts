import { createReadStream, existsSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/** The circuits' proving files, produced by `npm run setup` (BRD 2.2.1: proofs are built in the browser). */
const ARTIFACTS = resolve(import.meta.dirname, '../../packages/framework/artifacts');

/** Serves the proving files at /artifacts in development and copies them into the build. */
function provingArtifacts(): Plugin {
  let outDir = '';
  return {
    name: 'occulta-proving-artifacts',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use('/artifacts', (req, res, next) => {
        const file = join(ARTIFACTS, (req.url ?? '').split('?')[0]?.replace(/^\/+/, '') ?? '');
        if (!file.startsWith(ARTIFACTS) || !existsSync(file)) return next();
        res.setHeader('content-type', 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
    async closeBundle() {
      await cp(ARTIFACTS, join(outDir, 'artifacts'), { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [react(), provingArtifacts()],
  build: { target: 'es2023', chunkSizeWarningLimit: 8000 },
});
