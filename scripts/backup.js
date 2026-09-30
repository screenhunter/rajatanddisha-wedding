// Saves a copy of everything in Firestore to private/backups/.
//
//   npm run backup
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { connect, ROOT } from './firebase-admin.js';

const COLLECTIONS = ['households', 'responses', 'invites', 'nameIndex', 'public', 'private', 'admins'];
const { store } = connect();

const data = {};
for (const name of COLLECTIONS) {
  data[name] = Object.fromEntries((await store.list(name)).map((d) => [d.id, d.data]));
}

const dir = path.join(ROOT, 'private', 'backups');
mkdirSync(dir, { recursive: true });
const file = path.join(dir, `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify(data, null, 2));
console.log(`✔ Saved ${path.relative(ROOT, file)}`);
process.exit(0);
