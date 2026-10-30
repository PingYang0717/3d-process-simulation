// 把整個 app 打成一個 .html（prototype 用）：esbuild 打包主程式與 Worker，Worker 原始碼放在
// globalThis.__WORKER_SRC__，client.ts 看到就用 Blob URL 建 Worker。用法：node scripts/build-proto.mjs [out.html]
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const out = resolve(process.argv[2] ?? 'dist/prototype.html');
const common = { bundle: true, minify: true, target: 'es2020', logLevel: 'warning', define: { 'process.env.NODE_ENV': '"production"' } };

const worker = await build({ ...common, entryPoints: ['src/volume/worker.ts'], format: 'iife', write: false });
const app = await build({
  ...common,
  entryPoints: ['src/main.tsx'],
  format: 'iife',
  write: false,
  jsx: 'automatic',
  loader: { '.css': 'css' },
  outdir: 'dist/_proto',
});
const js = app.outputFiles.find((f) => f.path.endsWith('.js')).text;
const css = app.outputFiles.filter((f) => f.path.endsWith('.css')).map((f) => f.text).join('\n');
const workerSrc = worker.outputFiles[0].text;

const html = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Section Editor 3D</title>
<style>
${css}
</style>
</head>
<body>
<div id="root"></div>
<script>globalThis.__WORKER_SRC__=${JSON.stringify(workerSrc)};</script>
<script>${js.replace(/<\/script/g, '<\\/script')}</script>
</body>
</html>
`;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`${out}: ${(html.length / 1024 / 1024).toFixed(2)} MB (app ${(js.length / 1024).toFixed(0)} KB, worker ${(workerSrc.length / 1024).toFixed(0)} KB, css ${(css.length / 1024).toFixed(0)} KB)`);
