// Connects the Node scripts to Firestore with full admin rights (bypassing security rules).
//
// Talks to the Firestore REST API with Node's built-in fetch, which works through
// corporate proxies (scripts run with --use-env-proxy) where gRPC often doesn't.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp, cert } from 'firebase-admin/app';
import { firebaseConfig } from '../site/firebase-config.js';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function connect() {
  if (firebaseConfig.projectId.startsWith('[')) fail('Fill in site/firebase-config.js first (see README).');
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(ROOT, 'private', 'service-account.json');
  if (!existsSync(keyPath)) {
    fail(`Service account key not found at ${keyPath}.
  Firebase console → Project settings → Service accounts → Generate new private key,
  then save the downloaded file as private/service-account.json`);
  }
  const key = JSON.parse(readFileSync(keyPath, 'utf8'));
  if (key.project_id !== firebaseConfig.projectId) {
    fail(`The service account key is for project "${key.project_id}" but site/firebase-config.js uses "${firebaseConfig.projectId}".`);
  }
  const credential = cert(key);
  initializeApp({ credential });

  const dbPath = `projects/${key.project_id}/databases/(default)/documents`;
  const api = async (url, options = {}) => {
    const { access_token } = await credential.getAccessToken();
    const res = await fetch(`https://firestore.googleapis.com/v1/${url}`, {
      ...options,
      headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`Firestore ${res.status}: ${body.error?.message || JSON.stringify(body)}`);
    return body;
  };

  // Store adapter used by site/shared/sync.js
  const store = {
    async list(collection) {
      const docs = [];
      let pageToken = '';
      do {
        const page = await api(`${dbPath}/${collection}?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`);
        for (const d of page.documents || []) docs.push({ id: decodeURIComponent(d.name.split('/').pop()), data: decodeFields(d.fields) });
        pageToken = page.nextPageToken || '';
      } while (pageToken);
      return docs;
    },
    async commit(ops) {
      for (let i = 0; i < ops.length; i += 400) {
        const writes = ops.slice(i, i + 400).map((o) => {
          const name = `${dbPath}/${o.collection}/${o.id}`;
          return o.op === 'set' ? { update: { name, fields: encode(o.data).mapValue.fields } } : { delete: name };
        });
        await api(`${dbPath}:commit`, { method: 'POST', body: JSON.stringify({ writes }) });
      }
    },
  };
  return { store };
}

// Firestore REST value encoding
function encode(v) {
  if (v === null) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.filter((x) => x !== undefined).map(encode) } };
  if (typeof v === 'object') {
    const fields = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) fields[k] = encode(x);
    return { mapValue: { fields } };
  }
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  return { stringValue: String(v) };
}

function decode(v) {
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return new Date(v.timestampValue);
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decode);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields);
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  return v.stringValue;
}

const decodeFields = (fields = {}) => Object.fromEntries(Object.entries(fields).map(([k, x]) => [k, decode(x)]));

export function fail(message) {
  console.error(`\n✘ ${message}\n`);
  process.exit(1);
}
