import { isConfigured, readDoc, store, signInAdmin, signOutAdmin, onAdminChange } from './firebase.js';
import { allEvents, householdView, extrasLimitFor } from './shared/model.js';
import { loadState, planImport, importOps, rebuildOps } from './shared/sync.js';
import { toCsv } from './shared/csv.js';

const root = document.getElementById('admin');
const logoutBtn = document.getElementById('logout');
let state = null; // households / responses / ids from Firestore
let published = null; // private/config: { config, homeHtml, pages }
let report = null;
let tab = 'responses';
let pendingCsv = null;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const siteUrl = new URL('./', location.href).href;
const inviteLink = (code) => `${siteUrl}?invite=${code}`;
const toDate = (t) => (t?.toDate ? t.toDate() : t ? new Date(t) : null);

function message(html, type = 'info') {
  root.innerHTML = `<div class="card" style="max-width:520px;margin:48px auto"><div class="alert ${type}">${html}</div></div>`;
}

logoutBtn.addEventListener('click', async () => {
  await signOutAdmin();
  location.reload();
});

if (!isConfigured) {
  message('This site is not connected to Firebase yet. Fill in <code>site/firebase-config.js</code> (see README).', 'error');
} else {
  onAdminChange(async ({ user, isAdmin }) => {
    logoutBtn.hidden = !user;
    if (!user) return renderLogin();
    if (!isAdmin) {
      return message(
        `<strong>${esc(user.email)}</strong> is not an admin. Add it to <code>adminEmails</code> in <code>private/site.js</code> and run <code>npm run publish</code>.`,
        'error',
      );
    }
    await reload();
  });
}

function renderLogin() {
  root.innerHTML = `
    <div class="card" style="max-width:420px;margin:48px auto;text-align:center">
      <h2>Admin</h2>
      <p class="muted">Sign in with a Google account listed in <code>adminEmails</code>.</p>
      <div id="err" class="alert error" hidden></div>
      <button class="btn block" id="google">Sign in with Google</button>
    </div>`;
  document.getElementById('google').addEventListener('click', async () => {
    try {
      await signInAdmin();
    } catch (err) {
      const el = document.getElementById('err');
      el.textContent = err.code === 'auth/popup-closed-by-user' ? 'Sign-in was cancelled.' : err.message;
      el.hidden = false;
    }
  });
}

async function reload() {
  root.innerHTML = '<div class="loading">Loading…</div>';
  try {
    [state, published] = await Promise.all([loadState(store), readDoc('private', 'config')]);
  } catch (err) {
    console.error(err);
    return message(`Couldn't load data: ${esc(err.message)}. Check that you've published <code>firestore.rules</code>.`, 'error');
  }
  if (!published) return message('No content has been published yet. Run <code>npm run publish</code> first.', 'error');
  report = buildReport();
  render();
}

// ─── Report: who is invited to what, and what they answered ──────────────

function buildReport() {
  const { config } = published;
  const events = allEvents(config);
  const occasionTitle = new Map(config.occasions.map((o) => [o.id, o.title]));
  const stats = new Map(events.map((e) => [e.id, { yes: [], no: [], pending: [] }]));

  const households = [...state.households]
    .map(([id, h]) => {
      const response = state.responses.get(h.code) || {};
      const view = householdView(config, h, extrasLimitFor(h, response));
      const people = [
        ...h.guests.map((g) => ({ ...g, isAdditional: false })),
        ...(response.extras || []).map((x) => ({ ...x, tags: [], isAdditional: true })),
      ].map((p) => {
        const invitedTo = {};
        for (const e of view.events) {
          if (!(e.invitedGuestIds.includes(p.id) || (p.isAdditional && e.allowsAdditionalGuests))) continue;
          const status = response.rsvps?.[e.id]?.[p.id] || 'pending';
          invitedTo[e.id] = status;
          stats.get(e.id)[status].push(`${p.firstName} ${p.lastName}`);
        }
        return { ...p, events: invitedTo, dietary: response.dietary?.[p.id] || '' };
      });
      return {
        id,
        name: h.name,
        code: h.code,
        maxAdditional: h.maxAdditional,
        respondedAt: toDate(response.respondedAt),
        message: response.message || '',
        pages: view.pages.map((p) => p.title),
        people,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    events: events.map((e) => ({ id: e.id, name: e.name, date: e.date, occasion: occasionTitle.get(e.occasionId), ...stats.get(e.id) })),
    households,
  };
}

function render() {
  const tabs = [
    ['responses', 'Responses'],
    ['households', `Guests (${report.households.length})`],
    ['import', 'Upload guest list'],
  ];
  root.innerHTML = `
    <div class="tabs">${tabs.map(([id, label]) => `<button data-tab="${id}" class="${tab === id ? 'active' : ''}">${label}</button>`).join('')}</div>
    <div id="tab"></div>`;
  root.querySelectorAll('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      tab = b.dataset.tab;
      render();
    }),
  );
  ({ responses: renderResponses, households: renderHouseholds, import: renderImport })[tab]();
}

// ─── Responses ───────────────────────────────────────────────────────────

function renderResponses() {
  const people = report.households.flatMap((h) => h.people);
  const responded = report.households.filter((h) => h.respondedAt).length;
  const nameList = (title, names) =>
    names.length ? `<details><summary>${title} (${names.length})</summary><ul>${names.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details>` : '';

  document.getElementById('tab').innerHTML = `
    <div class="card">
      <strong>${responded}</strong> of <strong>${report.households.length}</strong> households have responded ·
      <strong>${people.length}</strong> guests total (${people.filter((p) => p.isAdditional).length} added by families)
      <div class="actions" style="margin-top:12px">
        <button class="btn small" id="export">Download all responses (CSV)</button>
        <button class="btn secondary small" id="refresh">Refresh</button>
      </div>
    </div>
    <div class="stat-grid section">
      ${report.events
        .map(
          (e) => `
        <div class="card">
          <div class="muted small">${esc(e.occasion)} · ${esc(e.date)}</div>
          <h3>${esc(e.name)}</h3>
          <div class="counts">
            <span class="status-pill yes">${e.yes.length} attending</span>
            <span class="status-pill no">${e.no.length} declined</span>
            <span class="status-pill pending">${e.pending.length} no response</span>
          </div>
          ${nameList('Attending', e.yes)}${nameList('Declined', e.no)}${nameList('No response yet', e.pending)}
        </div>`,
        )
        .join('')}
    </div>`;
  document.getElementById('export').addEventListener('click', exportCsv);
  document.getElementById('refresh').addEventListener('click', reload);
}

function exportCsv() {
  const events = report.events;
  const headers = [
    'household_id', 'household_name', 'invite_code', 'invite_link', 'first_name', 'last_name', 'email', 'phone',
    'tags', 'additional_guest', 'dietary', ...events.map((e) => e.name), 'household_message', 'responded_at',
  ];
  const rows = report.households.flatMap((h) =>
    h.people.map((p) => [
      h.id, h.name, h.code, inviteLink(h.code), p.firstName, p.lastName, p.email || '', p.phone || '',
      p.tags.join('; '), p.isAdditional ? 'yes' : 'no', p.dietary, ...events.map((e) => p.events[e.id] || 'not invited'),
      h.message, h.respondedAt ? h.respondedAt.toISOString() : '',
    ]),
  );
  const url = URL.createObjectURL(new Blob([toCsv(headers, rows)], { type: 'text/csv' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `wedding-rsvps-${new Date().toISOString().slice(0, 10)}.csv` });
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Households ──────────────────────────────────────────────────────────

function renderHouseholds() {
  const eventName = new Map(report.events.map((e) => [e.id, e.name]));
  document.getElementById('tab').innerHTML = `
    <input type="search" id="search" placeholder="Search by name, tag, or invite code">
    <div id="list"></div>`;

  const draw = (q) => {
    q = q.trim().toLowerCase();
    const matches = report.households.filter(
      (h) => !q || [h.name, h.code, ...h.people.flatMap((p) => [p.firstName, p.lastName, ...p.tags])].join(' ').toLowerCase().includes(q),
    );
    document.getElementById('list').innerHTML =
      matches
        .map(
          (h) => `
      <div class="card household">
        <div class="household-head">
          <h3 style="margin:0">${esc(h.name)}</h3>
          <span class="status-pill ${h.respondedAt ? 'yes' : 'pending'}">${h.respondedAt ? `Responded ${h.respondedAt.toLocaleDateString()}` : 'Not responded'}</span>
        </div>
        <div class="small muted" style="margin:6px 0">
          Code <code>${esc(h.code)}</code> ·
          ${h.maxAdditional ? `Up to ${h.maxAdditional} additional guest(s)` : 'No additional guests'}
          ${h.pages.length ? ` · Sees pages: ${h.pages.map(esc).join(', ')}` : ''}
        </div>
        <div class="actions" style="margin-bottom:8px">
          <button class="btn secondary small" data-copy="${esc(inviteLink(h.code))}">Copy invite link</button>
          <a class="btn secondary small" target="_blank" rel="noopener" href="${esc(`${inviteLink(h.code)}&preview=1`)}">View site as this family</a>
        </div>
        ${h.people
          .map(
            (p) => `
          <div class="guest-line">
            <strong>${esc(p.firstName)} ${esc(p.lastName)}</strong> ${p.isAdditional ? '<span class="muted">(added by family)</span>' : ''}
            ${p.email ? `<span class="muted"> · ${esc(p.email)}</span>` : ''}
            <div>${p.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
            <div class="chips">${
              Object.entries(p.events)
                .map(([id, s]) => `<span class="chip ${s}">${esc(eventName.get(id))}: ${s === 'yes' ? 'attending' : s === 'no' ? 'declined' : 'no response'}</span>`)
                .join('') || '<span class="muted small">Not invited to any events (check tags)</span>'
            }</div>
            ${p.dietary ? `<div class="small">Dietary: ${esc(p.dietary)}</div>` : ''}
          </div>`,
          )
          .join('')}
        ${h.message ? `<div class="alert info small">“${esc(h.message)}”</div>` : ''}
      </div>`,
        )
        .join('') || '<p class="muted">No guests yet. Upload your guest list first.</p>';
  };

  document.getElementById('search').addEventListener('input', (e) => draw(e.target.value));
  document.getElementById('list').addEventListener('click', async (e) => {
    const copy = e.target.closest('[data-copy]');
    if (!copy) return;
    await navigator.clipboard.writeText(copy.dataset.copy);
    copy.textContent = 'Copied!';
    setTimeout(() => (copy.textContent = 'Copy invite link'), 1500);
  });
  draw('');
}

// ─── Import ──────────────────────────────────────────────────────────────

function renderImport() {
  document.getElementById('tab').innerHTML = `
    <div class="card stack">
      <div>
        <h3>Upload guest list</h3>
        <p class="muted small">Upload a CSV file (Excel and Google Sheets can both "Save as / Download as CSV").
        You'll see a preview of the changes before anything is saved. Re-uploading an updated list keeps existing RSVPs
        for guests whose household ID and name haven't changed.</p>
        <a class="btn secondary small" href="guest-list-template.csv" download>Download CSV template</a>
      </div>
      <div>
        <label for="file">CSV file</label>
        <input type="file" id="file" accept=".csv,text/csv">
      </div>
      <div>
        <label class="radio"><input type="radio" name="mode" value="sync" checked>
          <span><strong>This is my complete guest list.</strong> Anyone not in the file is removed (along with their RSVPs).</span></label>
        <label class="radio"><input type="radio" name="mode" value="merge">
          <span><strong>Only add or update.</strong> Nobody is removed.</span></label>
      </div>
      <button class="btn" id="preview" disabled>Preview changes</button>
      <div id="result"></div>
    </div>`;

  const fileInput = document.getElementById('file');
  const previewBtn = document.getElementById('preview');
  const out = document.getElementById('result');
  const mode = () => document.querySelector('input[name=mode]:checked').value;

  fileInput.addEventListener('change', async () => {
    pendingCsv = fileInput.files[0] ? await fileInput.files[0].text() : null;
    previewBtn.disabled = !pendingCsv;
    out.innerHTML = '';
  });
  document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', () => (out.innerHTML = '')));

  previewBtn.addEventListener('click', () => {
    const plan = planImport(pendingCsv, published.config, state, mode());
    const list = (items) => `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
    const s = plan.summary;
    out.innerHTML = `
      ${plan.errors.length ? `<div class="alert error"><strong>Please fix these problems in your CSV and upload again:</strong>${list(plan.errors)}</div>` : ''}
      ${plan.warnings.length ? `<div class="alert info"><strong>Warnings:</strong>${list(plan.warnings)}</div>` : ''}
      ${
        s && !plan.errors.length
          ? `<div class="alert info">
              <strong>Preview (nothing saved yet):</strong>
              <ul>
                <li>Households: ${s.householdsAdded} new, ${s.householdsUpdated} updated, ${s.householdsRemoved} removed</li>
                <li>Guests: ${s.guestsAdded} new, ${s.guestsUpdated} updated, ${s.guestsRemoved} removed</li>
              </ul>
              ${plan.removals.length ? `<strong>Will be removed:</strong>${list(plan.removals)}` : ''}
            </div>
            <button class="btn" id="apply">Save these changes</button>`
          : ''
      }`;

    document.getElementById('apply')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Saving…';
      try {
        const { ops, responses } = importOps(plan, state);
        ops.push(...(await rebuildOps(published.config, published, plan.households, responses, state)));
        await store.commit(ops);
        await reload();
        tab = 'import';
        render();
        document.getElementById('result').innerHTML =
          `<div class="alert success"><strong>Guest list saved.</strong> ${plan.households.size} households are ready. See the Guests tab for invite links.</div>`;
      } catch (err) {
        console.error(err);
        e.target.disabled = false;
        e.target.textContent = 'Save these changes';
        out.insertAdjacentHTML('beforeend', `<div class="alert error">Saving failed: ${esc(err.message)}</div>`);
      }
    });
  });
}
