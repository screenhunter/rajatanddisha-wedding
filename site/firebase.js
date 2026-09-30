import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  initializeFirestore, doc, getDoc, getDocs, setDoc, collection, writeBatch, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { firebaseConfig } from './firebase-config.js';

export const isConfigured = !firebaseConfig.projectId.startsWith('[');

const app = initializeApp(isConfigured ? firebaseConfig : { projectId: 'demo-unconfigured', apiKey: 'none' });
export const db = initializeFirestore(app, { ignoreUndefinedProperties: true });
export const auth = getAuth(app);

export async function readDoc(collectionName, id) {
  const snap = await getDoc(doc(db, collectionName, id));
  return snap.exists() ? snap.data() : null;
}

export function saveResponse(code, data) {
  return setDoc(doc(db, 'responses', code), { ...data, respondedAt: serverTimestamp() });
}

// Store adapter used by shared/sync.js
export const store = {
  async list(name) {
    const snap = await getDocs(collection(db, name));
    return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
  },
  async commit(ops) {
    for (let i = 0; i < ops.length; i += 400) {
      const batch = writeBatch(db);
      for (const o of ops.slice(i, i + 400)) {
        const ref = doc(db, o.collection, o.id);
        o.op === 'set' ? batch.set(ref, o.data) : batch.delete(ref);
      }
      await batch.commit();
    }
  },
};

export async function signInAdmin() {
  return signInWithPopup(auth, new GoogleAuthProvider());
}

export function onAdminChange(callback) {
  return onAuthStateChanged(auth, async (user) => {
    if (!user) return callback({ user: null, isAdmin: false });
    let isAdmin = false;
    try {
      isAdmin = !!(await readDoc('admins', user.email));
    } catch {
      isAdmin = false;
    }
    callback({ user, isAdmin });
  });
}

export const signOutAdmin = () => signOut(auth);
