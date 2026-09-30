// Visibility rules and the documents guests are allowed to read.
// Shared by the admin page (browser) and scripts/publish.js (Node).

export function normalizeTag(tag) {
  return String(tag)
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Tags in the CSV are separated by semicolons: "bride's side; wedding only"
export function parseTags(value) {
  if (!value) return [];
  return [...new Set(String(value).split(';').map(normalizeTag).filter(Boolean))];
}

export function matchesRule(rule, tags) {
  if (!rule) return true;
  const has = new Set(tags.map(normalizeTag));
  const anyOf = (rule.anyOf || []).map(normalizeTag);
  const allOf = (rule.allOf || []).map(normalizeTag);
  const noneOf = (rule.noneOf || []).map(normalizeTag);
  if (anyOf.length && !anyOf.some((t) => has.has(t))) return false;
  if (!allOf.every((t) => has.has(t))) return false;
  if (noneOf.some((t) => has.has(t))) return false;
  return true;
}

export function allEvents(config) {
  return config.occasions.flatMap((occasion) => occasion.events.map((event) => ({ ...event, occasionId: occasion.id })));
}

// Every tag referenced by any rule, used to warn about typos in the CSV.
export function tagsUsedInConfig(config) {
  const rules = [...allEvents(config).map((e) => e.visibleTo), ...config.pages.map((p) => p.visibleTo)];
  const tags = new Set();
  for (const rule of rules.filter(Boolean)) {
    for (const key of ['anyOf', 'allOf', 'noneOf']) for (const t of rule[key] || []) tags.add(normalizeTag(t));
  }
  return tags;
}

export function validateConfig(config) {
  const errors = [];
  const ids = new Set();
  for (const occasion of config.occasions) {
    for (const event of occasion.events) {
      if (ids.has(event.id)) errors.push(`Duplicate event id "${event.id}"`);
      ids.add(event.id);
    }
    if (occasion.rsvpDeadline && !/^\d{4}-\d{2}-\d{2}$/.test(occasion.rsvpDeadline)) {
      errors.push(`rsvpDeadline for "${occasion.id}" must look like 2027-01-31`);
    }
  }
  return errors;
}

// Deadlines last through the end of the day everywhere on Earth (UTC-12),
// so no guest is cut off early because of their time zone.
export function deadlineEnd(date) {
  return date ? new Date(Date.parse(`${date}T23:59:59Z`) + 12 * 3600 * 1000) : null;
}
const NO_DEADLINE = new Date('2100-01-01T00:00:00Z');

/*
 * Which events and pages a household can see.
 *
 * Listed guests are invited to events their own tags match. Additional guests
 * (added by the family on the RSVP form) use the household's
 * `additionalGuestTags` if set; otherwise they may attend any event that
 * someone in the household is invited to.
 */
export function householdView(config, household, extrasLimit) {
  const extraTags = household.additionalGuestTags || [];
  const visibleEvents = [];
  for (const event of allEvents(config)) {
    const invitedGuestIds = household.guests.filter((g) => matchesRule(event.visibleTo, g.tags)).map((g) => g.id);
    const allowsAdditionalGuests =
      extrasLimit > 0 && (extraTags.length ? matchesRule(event.visibleTo, extraTags) : invitedGuestIds.length > 0);
    if (invitedGuestIds.length || allowsAdditionalGuests) {
      visibleEvents.push({ ...event, invitedGuestIds, allowsAdditionalGuests });
    }
  }
  const pages = config.pages.filter((page) => household.guests.some((g) => matchesRule(page.visibleTo, g.tags)));
  return { events: visibleEvents, pages };
}

// Keep already-added guests even if the family's limit was later lowered.
export function extrasLimitFor(household, response) {
  return Math.max(household.maxAdditional || 0, response?.extras?.length || 0);
}

const stripRule = ({ visibleTo, ...rest }) => rest;

/*
 * The one document a family reads (invites/{code}). It contains only what
 * they're allowed to see: no tags, no other families, no hidden events.
 */
export function buildInvite(config, content, householdId, household, response) {
  const extrasLimit = extrasLimitFor(household, response);
  const view = householdView(config, household, extrasLimit);
  const visibleById = new Map(view.events.map((e) => [e.id, e]));

  const occasions = config.occasions
    .map((o) => ({
      id: o.id,
      title: o.title,
      dates: o.dates,
      location: o.location,
      rsvpDeadline: o.rsvpDeadline || null,
      closesAt: (deadlineEnd(o.rsvpDeadline) || NO_DEADLINE).toISOString(),
      events: o.events
        .filter((e) => visibleById.has(e.id))
        .map((e) => {
          const { occasionId, ...event } = stripRule(visibleById.get(e.id));
          return event;
        }),
    }))
    .filter((o) => o.events.length);

  const closes = occasions.map((o) => new Date(o.closesAt));
  return {
    householdId,
    name: household.name,
    couple: config.couple,
    contactEmail: config.contactEmail || '',
    heroImage: config.heroImage || '',
    homeHtml: content.homeHtml,
    guests: household.guests.map(({ id, firstName, lastName }) => ({ id, firstName, lastName })),
    extrasLimit,
    occasions,
    pages: view.pages.map((p) => ({ id: p.id, navLabel: p.navLabel, title: p.title, html: content.pages[p.id] || '' })),
    // Used by the security rules to validate RSVP writes
    eventIds: view.events.map((e) => e.id),
    rsvpClosesAt: closes.length ? new Date(Math.max(...closes)) : NO_DEADLINE,
  };
}

// Shown on the sign-in page before we know who the guest is.
export function buildPublicSite(config) {
  return {
    couple: config.couple,
    tagline: config.tagline || '',
    heroImage: config.heroImage || '',
    contactEmail: config.contactEmail || '',
    allowNameLookup: !!config.allowNameLookup,
  };
}

export function nameKey(first, last) {
  return `${normalizeTag(first)}|${normalizeTag(last)}`;
}

// Name-lookup documents are stored under a hash so the collection can't be browsed.
export async function nameHash(first, last) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(nameKey(first, last)));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
