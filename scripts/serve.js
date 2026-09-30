// Serves site/ at http://localhost:3000 for previewing before pushing to GitHub.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './firebase-admin.js';

const SITE = path.join(ROOT, 'site');
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.csv': 'text/csv',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp',
};
const port = Number(process.env.PORT) || 3000;

createServer(async (req, res) => {
  let file = path.normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (file.endsWith('/')) file += 'index.html';
  const full = path.join(SITE, file);
  if (!full.startsWith(SITE)) return res.writeHead(403).end();
  try {
    const body = await readFile(full);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(port, () => console.log(`Previewing site/ at http://localhost:${port}  (admin: http://localhost:${port}/admin.html)`));
