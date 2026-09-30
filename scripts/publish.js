// Uploads private/site.js and private/pages/*.html to Firebase and rebuilds
// every family's invite so they see the latest events and pages.
//
//   npm run publish
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getSecurityRules } from 'firebase-admin/security-rules';
import { connect, fail, ROOT } from './firebase-admin.js';
import { validateConfig, buildPublicSite, allEvents } from '../site/shared/model.js';
import { loadState, rebuildOps } from '../site/shared/sync.js';

const PRIVATE = path.join(ROOT, 'private');
const readPage = (file) => {
  const p = path.join(PRIVATE, 'pages', path.basename(file));
  if (!existsSync(p)) fail(`Page file not found: private/pages/${file}`);
  return readFileSync(p, 'utf8');
};

export async function publish(store) {
  const config = JSON.parse(JSON.stringify((await import(pathToFileURL(path.join(PRIVATE, 'site.js')))).default));
  const errors = validateConfig(config);
  if (errors.length) fail(`Problems in private/site.js:\n  - ${errors.join('\n  - ')}`);

  const adminEmails = (config.adminEmails || []).map((e) => e.trim().toLowerCase()).filter((e) => e && !e.startsWith('['));
  if (!adminEmails.length) console.warn('⚠ No adminEmails set in private/site.js, so nobody can use the admin page.');

  const content = {
    homeHtml: readPage('home.html'),
    pages: Object.fromEntries(config.pages.map((p) => [p.id, readPage(p.file)])),
  };

  const state = await loadState(store);
  const existingAdmins = await store.list('admins');

  const ops = [
    { op: 'set', collection: 'private', id: 'config', data: { config, ...content, publishedAt: new Date() } },
    { op: 'set', collection: 'public', id: 'site', data: buildPublicSite(config) },
    ...adminEmails.map((email) => ({ op: 'set', collection: 'admins', id: email, data: { email } })),
    ...existingAdmins.filter((a) => !adminEmails.includes(a.id)).map((a) => ({ op: 'delete', collection: 'admins', id: a.id })),
    ...(await rebuildOps(config, content, state.households, state.responses, state)),
  ];
  await store.commit(ops);
  return { events: allEvents(config).length, pages: config.pages.length, households: state.households.size, adminEmails };
}

// Keeps the live database rules in sync with firestore.rules
async function deployRules() {
  try {
    await getSecurityRules().releaseFirestoreRulesetFromSource(readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8'));
    console.log('✔ Deployed firestore.rules');
  } catch (err) {
    fail(`Couldn't deploy firestore.rules: ${err.message}
  Make sure you've created the Firestore database (Firebase console → Firestore Database → Create database).`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { store } = connect();
  await deployRules();
  const result = await publish(store);
  console.log(`✔ Published ${result.events} events and ${result.pages} pages.`);
  console.log(`✔ Rebuilt invites for ${result.households} households.`);
  console.log(`✔ Admins: ${result.adminEmails.join(', ') || '(none)'}`);
  process.exit(0);
}
