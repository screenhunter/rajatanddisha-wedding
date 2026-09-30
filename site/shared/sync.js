/*
 * Guest-list import and rebuilding of the documents guests read.
 * Shared by the admin page (browser) and scripts/publish.js (Node).
 *
 * Firestore layout:
 *   households/{householdId}  admin only: names, emails, tags, limits
 *   responses/{inviteCode}    written by the family: RSVPs, added guests, dietary, message
 *   invites/{inviteCode}      read by the family: only the events/pages they can see
 *   nameIndex/{hash}          name lookup → invite code
 *   public/site               sign-in page info
 *   private/config            admin only: full config + page content
 *   admins/{email}            who may use the admin page
 *
 * `store` is a tiny adapter so the same code runs on either Firebase SDK:
 *   store.list(collection) → [{ id, data }]
 *   store.commit(ops)       ops: [{ op: 'set' | 'delete', collection, id, data }]
 */

import { parseCsv } from './csv.js';
import { parseTags, tagsUsedInConfig, nameKey, nameHash, buildInvite } from './model.js';

export const CSV_COLUMNS = [
  'household_id', 'household_name', 'first_name', 'last_name', 'email', 'phone',
  'tags', 'max_additional_guests', 'additional_guest_tags', 'invite_code',
];

// No 0/O/1/I/L so codes are easy to read off a printed card. 8 characters
// gives ~850 billion combinations, far too many to guess.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const randomString = (alphabet, length) =>
  [...crypto.getRandomValues(new Uint8Array(length))].map((b) => alphabet[b % alphabet.length]).join('');
export const newGuestId = () => `g${randomString('abcdefghijklmnopqrstuvwxyz0123456789', 10)}`;

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const set = (collection, id, data) => ({ op: 'set', collection, id, data });
const del = (collection, id) => ({ op: 'delete', collection, id });

export async function loadState(store) {
  const [households, responses, invites, names] = await Promise.all(
    ['households', 'responses', 'invites', 'nameIndex'].map((c) => store.list(c)),
  );
  return {
    households: new Map(households.map((d) => [d.id, d.data])),
    responses: new Map(responses.map((d) => [d.id, d.data])),
    inviteIds: invites.map((d) => d.id),
    nameIds: names.map((d) => d.id),
  };
}

/*
 * Parses the CSV and compares it with the current households. Nothing is
 * written here; pass the result to `importOps` to apply it.
 *
 * mode "sync":  the CSV is the complete list; households/guests missing from it are removed.
 * mode "merge": only adds and updates; nothing is removed.
 */
export function planImport(csvText, config, state, mode = 'sync') {
  const { headers, records } = parseCsv(csvText);
  const errors = [];
  const warnings = [];

  const missing = ['first_name', 'last_name'].filter((c) => !headers.includes(c));
  if (missing.length) return { errors: [`Missing required column(s): ${missing.join(', ')}`], warnings };
  const unknown = headers.filter((h) => !CSV_COLUMNS.includes(h));
  if (unknown.length) warnings.push(`Ignoring unrecognized column(s): ${unknown.join(', ')}`);

  // Group rows into households
  const rows = new Map();
  for (const r of records) {
    if (!r.first_name || !r.last_name) {
      errors.push(`Line ${r._line}: first_name and last_name are required.`);
      continue;
    }
    const id = r.household_id ? slug(r.household_id) : slug(`${r.first_name}-${r.last_name}`);
    if (!id) {
      errors.push(`Line ${r._line}: household_id must contain letters or numbers.`);
      continue;
    }
    if (!rows.has(id)) rows.set(id, { name: '', code: '', maxAdditional: null, additionalGuestTags: null, guests: [] });
    const hh = rows.get(id);
    const setOnce = (field, value, label) => {
      if (value === '' || value == null) return;
      if (hh[field] === '' || hh[field] == null) hh[field] = value;
      else if (JSON.stringify(hh[field]) !== JSON.stringify(value)) {
        warnings.push(`Line ${r._line}: household "${id}" has conflicting ${label}; using the first one.`);
      }
    };
    setOnce('name', r.household_name, 'household_name');
    setOnce('code', (r.invite_code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''), 'invite_code');
    if (r.max_additional_guests) {
      const n = Number(r.max_additional_guests);
      if (!Number.isInteger(n) || n < 0) errors.push(`Line ${r._line}: max_additional_guests must be a whole number.`);
      else setOnce('maxAdditional', n, 'max_additional_guests');
    }
    if (r.additional_guest_tags) setOnce('additionalGuestTags', parseTags(r.additional_guest_tags), 'additional_guest_tags');

    const key = nameKey(r.first_name, r.last_name);
    if (hh.guests.some((g) => g.key === key)) {
      errors.push(`Line ${r._line}: ${r.first_name} ${r.last_name} appears twice in household "${id}".`);
      continue;
    }
    hh.guests.push({ key, firstName: r.first_name, lastName: r.last_name, email: r.email || null, phone: r.phone || null, tags: parseTags(r.tags) });
  }

  const existing = state.households;
  const removedIds = mode === 'sync' ? [...existing.keys()].filter((id) => !rows.has(id)) : [];
  const keptExisting = [...existing.keys()].filter((id) => !rows.has(id) && !removedIds.includes(id));

  // Invite codes: keep existing ones unless the CSV sets a new one
  const taken = new Map(keptExisting.map((id) => [existing.get(id).code, id]));
  for (const [id, hh] of rows) {
    if (!hh.code) continue;
    if (taken.has(hh.code)) errors.push(`Invite code ${hh.code} is used by both "${taken.get(hh.code)}" and "${id}".`);
    taken.set(hh.code, id);
    if (hh.code.length < 8) warnings.push(`Invite code ${hh.code} ("${id}") is short. Codes of 8+ characters are much harder to guess.`);
  }
  for (const [id, hh] of rows) {
    if (hh.code) continue;
    const current = existing.get(id)?.code;
    if (current && !taken.has(current)) hh.code = current;
    else do hh.code = randomString(CODE_ALPHABET, 8); while (taken.has(hh.code));
    taken.set(hh.code, id);
  }

  // Tags that no event/page rule mentions are usually typos
  const known = tagsUsedInConfig(config);
  const unusedTags = new Set();
  for (const hh of rows.values()) {
    for (const t of [...(hh.additionalGuestTags || []), ...hh.guests.flatMap((g) => g.tags)]) if (!known.has(t)) unusedTags.add(t);
  }
  if (unusedTags.size) {
    warnings.push(`These tags are not used by any event or page in private/site.js (check for typos): ${[...unusedTags].map((t) => `"${t}"`).join(', ')}`);
  }

  // Build the final households, keeping guest ids stable so RSVPs stay attached
  const summary = { householdsAdded: 0, householdsUpdated: 0, householdsRemoved: removedIds.length, guestsAdded: 0, guestsUpdated: 0, guestsRemoved: 0 };
  const removals = [];
  const households = new Map(keptExisting.map((id) => [id, existing.get(id)]));
  const codeChanges = [];

  for (const [id, hh] of rows) {
    const before = existing.get(id);
    const beforeGuests = new Map((before?.guests || []).map((g) => [nameKey(g.firstName, g.lastName), g]));
    before ? summary.householdsUpdated++ : summary.householdsAdded++;

    const guests = hh.guests.map(({ key, ...g }) => {
      const match = beforeGuests.get(key);
      match ? summary.guestsUpdated++ : summary.guestsAdded++;
      beforeGuests.delete(key);
      return { id: match?.id || newGuestId(), ...g };
    });
    if (mode === 'merge') guests.push(...beforeGuests.values());
    else {
      for (const g of beforeGuests.values()) {
        summary.guestsRemoved++;
        const answered = Object.values(state.responses.get(before.code)?.rsvps || {}).some((r) => g.id in r);
        removals.push(`${g.firstName} ${g.lastName} (from ${before.name})${answered ? ': their RSVP answers will be ignored' : ''}`);
      }
    }

    const name =
      hh.name ||
      before?.name ||
      (guests.length === 1 ? `${guests[0].firstName} ${guests[0].lastName}` : `The ${[...new Set(guests.map((g) => g.lastName))].join(' / ')} Family`);
    const maxAdditional = hh.maxAdditional ?? 0;
    const extras = state.responses.get(before?.code)?.extras?.length || 0;
    if (extras > maxAdditional) warnings.push(`"${name}" already added ${extras} guest(s) but the new limit is ${maxAdditional}. Existing guests are kept.`);
    if (!guests.some((g) => g.tags.length)) warnings.push(`"${name}" has no tags, so they will only see events with no visibleTo rule.`);
    if (before && before.code !== hh.code) codeChanges.push({ from: before.code, to: hh.code });

    households.set(id, { name, code: hh.code, maxAdditional, additionalGuestTags: hh.additionalGuestTags || [], guests });
  }
  for (const id of removedIds) {
    const h = existing.get(id);
    removals.push(`Household ${h.name}${state.responses.has(h.code) ? ' (has already RSVPed; responses will be deleted)' : ''}`);
  }

  return { errors, warnings, summary, removals, mode, households, removedIds, codeChanges };
}

export function importOps(plan, state) {
  if (plan.errors.length) throw new Error('Cannot apply an import that has errors.');
  const ops = [];
  const responses = new Map(state.responses);

  for (const id of plan.removedIds) {
    const code = state.households.get(id).code;
    ops.push(del('households', id), del('responses', code));
    responses.delete(code);
  }
  for (const { from, to } of plan.codeChanges) {
    if (!responses.has(from)) continue;
    ops.push(set('responses', to, responses.get(from)), del('responses', from));
    responses.set(to, responses.get(from));
    responses.delete(from);
  }
  for (const [id, data] of plan.households) {
    if (data !== state.households.get(id)) ops.push(set('households', id, data));
  }
  return { ops, responses };
}

// Regenerates every family's invite document and the name-lookup index.
export async function rebuildOps(config, content, households, responses, state) {
  const ops = [];
  const codes = new Set();
  for (const [id, h] of households) {
    codes.add(h.code);
    ops.push(set('invites', h.code, buildInvite(config, content, id, h, responses.get(h.code))));
  }
  for (const code of state.inviteIds) if (!codes.has(code)) ops.push(del('invites', code));

  const index = new Map();
  if (config.allowNameLookup) {
    for (const h of households.values()) {
      for (const g of h.guests) {
        const hash = await nameHash(g.firstName, g.lastName);
        const prior = index.get(hash);
        index.set(hash, prior && prior.code !== h.code ? { ambiguous: true } : { code: h.code });
      }
    }
  }
  for (const [hash, data] of index) ops.push(set('nameIndex', hash, data));
  for (const hash of state.nameIds) if (!index.has(hash)) ops.push(del('nameIndex', hash));
  return ops;
}
