import { isConfigured, readDoc, saveResponse, onAdminChange } from './firebase.js';
import { nameHash } from './shared/model.js';
import { newGuestId } from './shared/sync.js';

const app = document.getElementById('app');
let state = null; // { code, invite, response, isAdmin }
let draft = null; // Unsaved RSVP form state
let publicInfo = null;

// ─── Helpers ─────────────────────────────────────────────────────────────

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const formatDate = (iso, opts = { weekday: 'long', month: 'long', day: 'numeric' }) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', opts);
const formatDeadline = (iso) => formatDate(iso, { month: 'long', day: 'numeric', year: 'numeric' });
const mapsLink = (address) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
const isPlaceholder = (s) => /^\[.*\]$/.test(String(s || '').trim());
const isLocked = (occasion) => !state.isAdmin && new Date() > new Date(occasion.closesAt);
const allEventsOf = () => state.invite.occasions.flatMap((o) => o.events);
const fullName = (g) => `${g.firstName} ${g.lastName}`.trim();

function showFatal(message) {
  app.innerHTML = `<div class="container"><div class="alert error" style="margin-top:40px">${message}</div></div>`;
}

// ─── Session ─────────────────────────────────────────────────────────────
// Families stay signed in on their device via localStorage. Admin previews
// ("View site as this family") use sessionStorage so they only affect that tab.

function storedCode() {
  return sessionStorage.getItem('previewCode') || localStorage.getItem('inviteCode');
}

function forgetCode() {
  sessionStorage.removeItem('previewCode');
  localStorage.removeItem('inviteCode');
}

async function boot() {
  if (!isConfigured) {
    return showFatal('This site is not connected to Firebase yet. Fill in <code>site/firebase-config.js</code> (see README).');
  }

  // Personal invite links look like https://…/?invite=K7PM3Q2X
  const params = new URLSearchParams(location.search);
  if (params.has('invite')) {
    const code = params.get('invite').trim().toUpperCase();
    if (params.has('preview')) sessionStorage.setItem('previewCode', code);
    else localStorage.setItem('inviteCode', code);
    history.replaceState(null, '', location.pathname + location.hash);
  }

  const code = storedCode();
  if (!code) return renderLogin();
  try {
    if (!(await signIn(code))) {
      forgetCode();
      renderLogin("That invite link didn't work. Please enter the code from your invitation.");
    }
  } catch (err) {
    console.error(err);
    showFatal('Sorry, something went wrong loading the site. Please refresh and try again.');
  }
}

async function signIn(code) {
  const [invite, response] = await Promise.all([readDoc('invites', code), readDoc('responses', code)]);
  if (!invite) return false;
  state = {
    code,
    invite,
    response: response || { extras: [], rsvps: {}, dietary: {}, message: '', respondedAt: null },
    isAdmin: false,
  };
  if (sessionStorage.getItem('previewCode') === code) {
    onAdminChange(({ isAdmin }) => {
      state.isAdmin = isAdmin;
      renderChrome();
      route();
    });
  }
  renderChrome();
  route();
  return true;
}

// ─── Routing (hash-based so it works on GitHub Pages) ────────────────────

window.addEventListener('hashchange', () => {
  if (!state) return;
  route();
  window.scrollTo(0, 0);
});

function route() {
  closeNav();
  const path = location.hash.replace(/^#/, '') || '/';
  document.querySelectorAll('#site-nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#${path}`));

  if (path === '/') return renderHome();
  if (path === '/schedule') return renderSchedule();
  if (path === '/rsvp') return renderRsvp();
  const page = state.invite.pages.find((p) => `/${p.id}` === path);
  if (page) return renderContentPage(page);
  app.innerHTML = `<div class="container page-title"><h2>Page not found</h2><p><a href="#/">Go home</a></p></div>`;
}

// ─── Header, nav, footer ─────────────────────────────────────────────────

const navToggle = document.getElementById('nav-toggle');
const siteNav = document.getElementById('site-nav');
navToggle.addEventListener('click', () => {
  const open = siteNav.classList.toggle('open');
  navToggle.setAttribute('aria-expanded', open);
});
function closeNav() {
  siteNav.classList.remove('open');
  navToggle.setAttribute('aria-expanded', 'false');
}

function renderChrome() {
  const { couple, contactEmail, pages, name } = state.invite;
  document.title = couple.names;
  document.getElementById('site-header').hidden = false;
  document.getElementById('brand').textContent = couple.shortNames;

  const links = [['#/', 'Home'], ['#/schedule', 'Schedule'], ...pages.map((p) => [`#/${p.id}`, p.navLabel]), ['#/rsvp', 'RSVP']];
  siteNav.innerHTML =
    links.map(([href, label]) => `<a href="${href}">${esc(label)}</a>`).join('') +
    `<button type="button" class="nav-logout" id="logout">Log out</button>`;
  document.getElementById('logout').addEventListener('click', logout);

  const banner = document.getElementById('admin-banner');
  const previewing = sessionStorage.getItem('previewCode') === state.code;
  banner.hidden = !previewing;
  banner.innerHTML = `Admin preview: viewing as <strong>${esc(name)}</strong>.
    ${state.isAdmin ? 'RSVP deadlines are not enforced.' : 'Sign in on the admin page to edit past deadlines.'}
    <a href="admin.html">Back to admin</a>`;

  const footer = document.getElementById('footer');
  footer.hidden = false;
  footer.innerHTML = `
    <div class="container">
      <span class="brand">${esc(couple.names)}</span>
      ${couple.hashtag ? `<div>${esc(couple.hashtag)}</div>` : ''}
      ${contactEmail ? `<div>Questions? <a href="mailto:${esc(contactEmail)}">${esc(contactEmail)}</a></div>` : ''}
    </div>`;
}

function logout() {
  forgetCode();
  state = null;
  history.replaceState(null, '', location.pathname);
  document.getElementById('site-header').hidden = true;
  document.getElementById('footer').hidden = true;
  document.getElementById('admin-banner').hidden = true;
  renderLogin();
}

function heroHtml({ eyebrow, couple, heroImage, body }) {
  return `
    <section class="hero ${heroImage ? 'has-image' : ''}" ${heroImage ? `style="background-image:url('${esc(heroImage)}')"` : ''}>
      <div class="container">
        <div class="eyebrow">${esc(eyebrow)}</div>
        <h1>${esc(couple.names)}</h1>
        <div class="ornament">✦</div>
        ${body}
      </div>
    </section>`;
}

// ─── Login ───────────────────────────────────────────────────────────────

async function renderLogin(error = '') {
  try {
    publicInfo ||= await readDoc('public', 'site');
  } catch (err) {
    console.error(err);
  }
  if (!publicInfo) return showFatal('This site has not been published yet. Run <code>npm run publish</code> (see README).');
  document.title = publicInfo.couple.names;

  app.innerHTML = `
    ${heroHtml({
      eyebrow: 'We are getting married',
      couple: publicInfo.couple,
      heroImage: publicInfo.heroImage,
      body: publicInfo.tagline ? `<p class="sub">${esc(publicInfo.tagline)}</p>` : '',
    })}
    <div class="container">
      <div class="card login-card">
        <h2>Find your invitation</h2>
        <p class="muted">Enter the invite code from your invitation${publicInfo.allowNameLookup ? ', or your name,' : ''} to see your events and RSVP.</p>
        <div id="login-error" class="alert error" ${error ? '' : 'hidden'}>${esc(error)}</div>
        <form id="code-form">
          <div class="field">
            <label for="code">Invite code</label>
            <input type="text" id="code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="e.g. K7PM3Q2X">
          </div>
          <div class="field"><button class="btn block" type="submit">Continue</button></div>
        </form>
        ${
          publicInfo.allowNameLookup
            ? `<div class="divider">or</div>
          <form id="name-form">
            <div class="row-2">
              <div><label for="first">First name</label><input type="text" id="first" autocomplete="given-name"></div>
              <div><label for="last">Last name</label><input type="text" id="last" autocomplete="family-name"></div>
            </div>
            <div class="field"><button class="btn secondary block" type="submit">Find by name</button></div>
          </form>`
            : ''
        }
      </div>
    </div>`;

  const showError = (msg) => {
    const el = document.getElementById('login-error');
    el.textContent = msg;
    el.hidden = false;
  };
  const tryCode = async (code) => {
    try {
      if (await signIn(code)) localStorage.setItem('inviteCode', code);
      else showError("We couldn't find that invite code. Please check it and try again.");
    } catch (err) {
      console.error(err);
      showError('Something went wrong. Please try again.');
    }
  };

  document.getElementById('code-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = document.getElementById('code').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code) return showError('Please enter your invite code.');
    tryCode(code);
  });
  document.getElementById('name-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const first = document.getElementById('first').value.trim();
    const last = document.getElementById('last').value.trim();
    if (!first || !last) return showError('Please enter both your first and last name.');
    const match = await readDoc('nameIndex', await nameHash(first, last)).catch(() => null);
    if (!match) return showError("We couldn't find that name. Try the name on your invitation, or use your invite code.");
    if (match.ambiguous) return showError('More than one guest has that name. Please use the invite code from your invitation.');
    tryCode(match.code);
  });
}

// ─── Home ────────────────────────────────────────────────────────────────

function renderHome() {
  const { invite, response } = state;
  const open = invite.occasions.filter((o) => !isLocked(o) && o.rsvpDeadline);
  const nextDeadline = open.map((o) => o.rsvpDeadline).sort()[0];
  let status = '';
  if (response.respondedAt) {
    status = `Thank you for your RSVP! ${nextDeadline ? `You can update it until ${formatDeadline(nextDeadline)}.` : ''}`;
  } else if (nextDeadline) {
    status = `Kindly RSVP by ${formatDeadline(nextDeadline)}.`;
  }

  app.innerHTML = `
    ${heroHtml({
      eyebrow: `Welcome, ${invite.name}`,
      couple: invite.couple,
      heroImage: invite.heroImage,
      body: `
        <div class="occasion-summary">
          ${invite.occasions.map((o) => `<div class="item"><h3>${esc(o.title)}</h3><div>${esc(o.dates)}</div><div>${esc(o.location)}</div></div>`).join('')}
        </div>
        ${status ? `<p class="sub" style="margin-top:28px">${status}</p>` : ''}
        <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-top:12px">
          <a class="btn" href="#/rsvp">${response.respondedAt ? 'Update RSVP' : 'RSVP'}</a>
          <a class="btn secondary" href="#/schedule">View schedule</a>
        </div>`,
    })}
    <div class="container section"><div class="content">${invite.homeHtml || ''}</div></div>`;
}

// ─── Schedule ────────────────────────────────────────────────────────────

function renderSchedule() {
  const { invite, response } = state;
  const namesFor = (e) => [
    ...e.invitedGuestIds.map((id) => invite.guests.find((g) => g.id === id)).filter(Boolean),
    ...(e.allowsAdditionalGuests ? response.extras : []),
  ];
  const partySize = invite.guests.length + response.extras.length;

  const eventCard = (e) => {
    const invited = namesFor(e);
    const meta = [
      e.venue && `<li><strong>Where:</strong> ${esc(e.venue)}</li>`,
      e.address && `<li><strong>Address:</strong> ${isPlaceholder(e.address) ? esc(e.address) : `<a href="${mapsLink(e.address)}" target="_blank" rel="noopener">${esc(e.address)}</a>`}</li>`,
      e.attire && `<li><strong>Attire:</strong> ${esc(e.attire)}</li>`,
      partySize > 1 && invited.length && `<li><strong>Invited:</strong> ${invited.map((g) => esc(g.firstName)).join(', ')}</li>`,
    ].filter(Boolean);
    return `
      <article class="card event-card">
        <h3>${esc(e.name)}</h3>
        <div class="time">${esc(e.time)}</div>
        ${e.description ? `<p>${esc(e.description)}</p>` : ''}
        <ul class="event-meta">${meta.join('')}</ul>
      </article>`;
  };

  const occasionHtml = (o) => {
    const days = [...new Set(o.events.map((e) => e.date))].sort();
    return `
      <section>
        <div class="occasion-header"><h2>${esc(o.title)}</h2><p>${esc(o.dates)} · ${esc(o.location)}</p></div>
        ${days
          .map((d) => `
          <div class="day-label">${formatDate(d)}</div>
          <div class="event-grid">${o.events.filter((e) => e.date === d).map(eventCard).join('')}</div>`)
          .join('')}
      </section>`;
  };

  app.innerHTML = `
    <div class="container">
      <div class="page-title"><h2>Schedule</h2><p>The events you're invited to</p></div>
      ${invite.occasions.length ? invite.occasions.map(occasionHtml).join('') : '<p class="muted" style="text-align:center">Details coming soon.</p>'}
    </div>`;
}

// ─── Content pages (Travel etc.) ─────────────────────────────────────────

function renderContentPage(page) {
  app.innerHTML = `
    <div class="container">
      <div class="page-title"><h2>${esc(page.title)}</h2></div>
      <div class="card content">${page.html}</div>
    </div>`;
}

// ─── RSVP ────────────────────────────────────────────────────────────────

function initDraft() {
  const r = state.response;
  draft = {
    extras: r.extras.map((x) => ({ ...x })),
    responses: structuredClone(r.rsvps || {}),
    dietary: { ...(r.dietary || {}) },
    message: r.message || '',
  };
}

const extrasEditable = () =>
  state.invite.extrasLimit > 0 && state.invite.occasions.some((o) => !isLocked(o) && o.events.some((e) => e.allowsAdditionalGuests));
const namedExtras = () => draft.extras.filter((x) => x.firstName.trim() || x.lastName.trim());

// Everyone who should answer for an event, as { id, label }
function participants(event) {
  const listed = event.invitedGuestIds
    .map((id) => state.invite.guests.find((g) => g.id === id))
    .filter(Boolean)
    .map((g) => ({ id: g.id, label: fullName(g) }));
  const extras = event.allowsAdditionalGuests ? namedExtras().map((x) => ({ id: x.id, label: fullName(x), isExtra: true })) : [];
  return [...listed, ...extras];
}

const allPeople = () => [
  ...state.invite.guests.map((g) => ({ id: g.id, label: fullName(g) })),
  ...namedExtras().map((x) => ({ id: x.id, label: fullName(x) })),
];

function renderRsvp(flash = '') {
  initDraft();
  const { invite, response } = state;
  const anyOpen = invite.occasions.some((o) => !isLocked(o));
  const limit = invite.extrasLimit;

  app.innerHTML = `
    <div class="container">
      <div class="page-title"><h2>RSVP</h2><p>${esc(invite.name)}</p></div>
      <div id="rsvp-alert">${flash}</div>
      ${invite.occasions.length ? '' : '<p class="muted" style="text-align:center">There are no events to RSVP for yet.</p>'}

      ${
        extrasEditable()
          ? `<section class="card section" id="extras-section">
              <h3>Additional guests</h3>
              <p class="muted">You're welcome to bring up to <strong>${limit}</strong> additional guest${limit === 1 ? '' : 's'}. Please tell us their full names so we can include them in the headcount.</p>
              <div id="extras-list"></div>
              <button type="button" class="btn secondary small" id="add-extra" style="margin-top:14px">+ Add a guest</button>
            </section>`
          : ''
      }

      <div id="rsvp-events"></div>

      ${
        invite.occasions.length
          ? `<section class="card section" id="dietary-section"></section>
            <section class="card section">
              <h3>A note for the couple</h3>
              <label for="message" class="sr-only">Message</label>
              <textarea id="message" maxlength="2000" placeholder="Optional: questions, well wishes, anything we should know" ${anyOpen ? '' : 'disabled'}>${esc(draft.message)}</textarea>
            </section>
            ${anyOpen ? `<div class="submit-bar"><button class="btn block" id="submit-rsvp">${response.respondedAt ? 'Update RSVP' : 'Submit RSVP'}</button></div>` : ''}`
          : ''
      }
    </div>`;

  renderExtras();
  renderRsvpEvents();
  renderDietary();

  document.getElementById('add-extra')?.addEventListener('click', () => {
    if (draft.extras.length >= limit) return;
    draft.extras.push({ id: newGuestId(), firstName: '', lastName: '' });
    renderExtras();
    document.querySelector('#extras-list .extra-row:last-child input')?.focus();
  });
  document.getElementById('message')?.addEventListener('input', (e) => (draft.message = e.target.value));
  document.getElementById('submit-rsvp')?.addEventListener('click', submitRsvp);
}

function renderExtras() {
  const list = document.getElementById('extras-list');
  if (!list) return;
  list.innerHTML = draft.extras
    .map(
      (x, i) => `
      <div class="extra-row" data-id="${esc(x.id)}">
        <div class="field"><label for="xf-${i}">First name</label><input type="text" id="xf-${i}" data-field="firstName" maxlength="80" value="${esc(x.firstName)}"></div>
        <div class="field"><label for="xl-${i}">Last name</label><input type="text" id="xl-${i}" data-field="lastName" maxlength="80" value="${esc(x.lastName)}"></div>
        <button type="button" class="remove" aria-label="Remove guest">×</button>
      </div>`,
    )
    .join('');
  document.getElementById('add-extra').disabled = draft.extras.length >= state.invite.extrasLimit;

  list.querySelectorAll('.extra-row').forEach((row) => {
    const extra = draft.extras.find((x) => x.id === row.dataset.id);
    row.querySelectorAll('input').forEach((input) =>
      input.addEventListener('input', () => {
        extra[input.dataset.field] = input.value;
        renderRsvpEvents();
        renderDietary();
      }),
    );
    row.querySelector('.remove').addEventListener('click', () => {
      draft.extras = draft.extras.filter((x) => x !== extra);
      renderExtras();
      renderRsvpEvents();
      renderDietary();
    });
  });
}

function renderRsvpEvents() {
  const container = document.getElementById('rsvp-events');
  container.innerHTML = state.invite.occasions
    .map((o) => {
      const locked = isLocked(o);
      const note = locked
        ? `RSVPs closed on ${formatDeadline(o.rsvpDeadline)}. Please contact us if you need to make a change.`
        : o.rsvpDeadline
          ? `Please respond by ${formatDeadline(o.rsvpDeadline)}.`
          : '';
      return `
        <section class="section">
          <div class="occasion-header" style="margin-top:28px">
            <h2>${esc(o.title)}</h2>
            <p>${esc(o.dates)} · ${esc(o.location)}</p>
            ${note ? `<p class="small">${note}</p>` : ''}
          </div>
          ${o.events.map((e) => eventRsvpCard(e, locked)).join('')}
        </section>`;
    })
    .join('');

  container.querySelectorAll('[data-answer]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const { event, guest, answer } = btn.dataset;
      (draft.responses[event] ||= {})[guest] = answer;
      const row = btn.closest('.person-row');
      row.classList.remove('missing');
      row.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b === btn));
    }),
  );
  container.querySelectorAll('[data-all]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const event = allEventsOf().find((e) => e.id === btn.dataset.event);
      for (const p of participants(event)) (draft.responses[event.id] ||= {})[p.id] = btn.dataset.all;
      renderRsvpEvents();
    }),
  );
}

function eventRsvpCard(event, locked) {
  const people = participants(event);
  const answers = draft.responses[event.id] || {};
  const rows = people
    .map((p) => {
      const answer = answers[p.id];
      const control = locked
        ? `<span class="status-pill ${answer || 'pending'}">${answer === 'yes' ? 'Attending' : answer === 'no' ? 'Not attending' : 'No response'}</span>`
        : `<div class="choice" role="group" aria-label="${esc(p.label)} at ${esc(event.name)}">
            <button type="button" class="yes" data-answer="yes" data-event="${esc(event.id)}" data-guest="${esc(p.id)}" aria-pressed="${answer === 'yes'}">Attending</button>
            <button type="button" class="no" data-answer="no" data-event="${esc(event.id)}" data-guest="${esc(p.id)}" aria-pressed="${answer === 'no'}">Not attending</button>
          </div>`;
      return `
        <div class="person-row" data-event="${esc(event.id)}" data-guest="${esc(p.id)}">
          <div class="person-name">${esc(p.label)} ${p.isExtra ? '<span class="muted">(guest)</span>' : ''}</div>
          ${control}
        </div>`;
    })
    .join('');

  return `
    <article class="card rsvp-event">
      <div class="rsvp-event-head">
        <div>
          <h3>${esc(event.name)}</h3>
          <div class="muted small">${formatDate(event.date)} · ${esc(event.time)}</div>
        </div>
        ${
          !locked && people.length > 1
            ? `<div class="quick-actions">
                <button type="button" class="link-btn" data-all="yes" data-event="${esc(event.id)}">Everyone attending</button>
                <button type="button" class="link-btn" data-all="no" data-event="${esc(event.id)}">No one</button>
              </div>`
            : ''
        }
      </div>
      ${rows || '<p class="muted small" style="margin-top:12px">Add your guests above to RSVP for them.</p>'}
    </article>`;
}

function renderDietary() {
  const section = document.getElementById('dietary-section');
  if (!section) return;
  const anyOpen = state.invite.occasions.some((o) => !isLocked(o));
  section.innerHTML = `
    <h3>Dietary needs</h3>
    <p class="muted small">Let us know about any dietary restrictions or allergies (e.g. vegetarian, vegan, Jain, nut allergy). Leave blank if none.</p>
    ${allPeople()
      .map(
        (p, i) => `
        <div class="field">
          <label for="diet-${i}">${esc(p.label)}</label>
          <input type="text" id="diet-${i}" maxlength="300" data-guest="${esc(p.id)}" value="${esc(draft.dietary[p.id] || '')}" ${anyOpen ? '' : 'disabled'}>
        </div>`,
      )
      .join('')}`;
  section.querySelectorAll('input').forEach((input) =>
    input.addEventListener('input', () => (draft.dietary[input.dataset.guest] = input.value)),
  );
}

function showRsvpAlert(type, html) {
  document.getElementById('rsvp-alert').innerHTML = `<div class="alert ${type}">${html}</div>`;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function submitRsvp() {
  const incomplete = draft.extras.some((x) => (x.firstName.trim() || x.lastName.trim()) && !(x.firstName.trim() && x.lastName.trim()));
  if (incomplete) return showRsvpAlert('error', 'Please enter both a first and last name for each additional guest.');

  // Every person needs an answer for every open event. Closed events keep their saved answers.
  const rsvps = {};
  let firstMissing = null;
  for (const o of state.invite.occasions) {
    for (const e of o.events) {
      if (isLocked(o)) {
        if (state.response.rsvps?.[e.id]) rsvps[e.id] = state.response.rsvps[e.id];
        continue;
      }
      rsvps[e.id] = {};
      for (const p of participants(e)) {
        const answer = draft.responses[e.id]?.[p.id];
        if (answer === 'yes' || answer === 'no') rsvps[e.id][p.id] = answer;
        else {
          const row = document.querySelector(`.person-row[data-event="${CSS.escape(e.id)}"][data-guest="${CSS.escape(p.id)}"]`);
          row?.classList.add('missing');
          firstMissing ||= row;
        }
      }
    }
  }
  if (firstMissing) {
    document.getElementById('rsvp-alert').innerHTML =
      '<div class="alert error">Please choose <strong>Attending</strong> or <strong>Not attending</strong> for everyone highlighted in red.</div>';
    firstMissing.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  const extras = namedExtras().map((x) => ({ id: x.id, firstName: x.firstName.trim(), lastName: x.lastName.trim() }));
  const dietary = {};
  for (const p of allPeople()) {
    const note = (draft.dietary[p.id] || '').trim().slice(0, 300);
    if (note) dietary[p.id] = note;
  }
  const data = { extras, rsvps, dietary, message: draft.message.trim().slice(0, 2000) };

  const button = document.getElementById('submit-rsvp');
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    await saveResponse(state.code, data);
    state.response = { ...data, respondedAt: new Date() };
    renderRsvp('<div class="alert success"><strong>Thank you!</strong> Your RSVP has been saved. You can come back and make changes any time before the deadline.</div>');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    console.error(err);
    button.disabled = false;
    button.textContent = state.response.respondedAt ? 'Update RSVP' : 'Submit RSVP';
    showRsvpAlert(
      'error',
      err.code === 'permission-denied'
        ? 'Your RSVP could not be saved. The RSVP deadline may have passed. Please contact us.'
        : 'Your RSVP could not be saved. Please check your connection and try again.',
    );
  }
}

boot();
