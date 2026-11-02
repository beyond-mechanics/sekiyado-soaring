import { build } from 'esbuild';
await build({ entryPoints: ['src/main.js'], bundle: true, outfile: 'app/renderer.js', format: 'iife', target: 'chrome120', minify: process.argv.includes('--minify'), sourcemap: !process.argv.includes('--minify'), legalComments: 'eof' });
console.log('built app/renderer.js');
