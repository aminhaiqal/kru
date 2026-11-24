import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const result = await Bun.build({ entrypoints: [resolve(root, 'src/web/markdown.js')], outdir: resolve(root, 'src/web/public'), target: 'browser', format: 'iife', minify: true });
if (!result.success) throw new AggregateError(result.logs, 'Markdown renderer build failed');
const notices = ['marked', 'dompurify'].map(name => `${name}\n${readFileSync(resolve(root, 'node_modules', name, 'LICENSE'), 'utf8')}`).join('\n\n');
await Bun.write(resolve(root, 'src/web/public/markdown.LICENSE.txt'), notices);
