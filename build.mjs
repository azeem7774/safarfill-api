import { build } from 'esbuild';
await build({
  entryPoints: ['src/index.js'], bundle: true, format: 'esm', platform: 'neutral',
  outfile: 'dist/worker.js', loader: { '.html': 'text', '.txt': 'text' }, minify: false,
  legalComments: 'none', banner: { js: '// SafarFill licence server v1.0.0 (single file for the Cloudflare dashboard editor)' },
});
