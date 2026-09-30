# Wedding Website

A mobile-friendly wedding site hosted free on **GitHub Pages**, with guest data stored in **Firebase Firestore**.
Each family sees only the events and pages their tags allow, and submits one RSVP for everyone in their party.

## How it fits together

| Where | What | Who can see it |
|---|---|---|
| **GitHub** (public repo) | `site/`: the website code | Everyone. It contains no event details, guest names or page text. |
| **Your laptop** (`private/`, never committed) | Events, venues, tag rules, page text, admin emails, service-account key | Only you |
| **Firebase** | Guest list, RSVPs, and a per-family copy of just the events and pages that family can see | Enforced by `firestore.rules` |

Families don't need accounts. Their invite code unlocks exactly one document containing their events.
Nobody can list or browse the database except admins, who sign in with Google.

## One-time setup

### 1. Firebase
1. Go to https://console.firebase.google.com → **Add project**. Analytics is not needed.
2. **Build → Firestore Database → Create database**. Choose **production mode** and a location near most guests (e.g. `us-east4`).
3. **Build → Authentication → Get started → Sign-in method → Google → Enable.**
4. **Project settings (⚙) → General → Your apps → Web (`</>`)**: register an app, then copy the `firebaseConfig`
   values into `site/firebase-config.js`. These are safe to make public.
5. **Project settings → Service accounts → Generate new private key.** Save the file as
   `private/service-account.json`. **Keep it secret**: it has full admin access. It's git-ignored.

The free **Spark** plan is plenty for a wedding (50k reads and 20k writes a day). No credit card needed.

### 2. Your details
You'll need Node.js 24.5 or newer on your laptop (`node --version`).
1. Edit `private/site.js`: your Google email in `adminEmails`, names, events, deadlines, tag rules.
2. Edit the pages in `private/pages/`.
3. Publish them to Firebase. This also deploys the security rules in `firestore.rules`:
   ```bash
   npm install
   npm run publish
   ```

### 3. GitHub Pages
1. Create a new repository on GitHub. It must be **public** for free Pages hosting.
2. Push this folder to it (`private/` is automatically excluded):
   ```bash
   git init && git add . && git commit -m "Wedding website"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
3. In the repo: **Settings → Pages → Source: GitHub Actions.** Every push to `main` now deploys `site/`.
4. The site will be at `https://<you>.github.io/<repo>/`. The admin page is `…/admin.html`.
5. Back in Firebase: **Authentication → Settings → Authorized domains → Add** `<you>.github.io`.

Before pushing, always check `git status` doesn't list anything in `private/`.

### 4. Guests
Open the admin page, sign in with Google, and upload your guest list CSV on the **Upload guest list** tab.
Use **View site as this family** to check that each family sees the right events.

## Day to day

| To change… | Do this |
|---|---|
| Events, venues, times, tag rules, page text | Edit `private/…`, then `npm run publish` |
| The guest list | Re-upload the CSV on the admin page |
| Site design (colors, fonts, layout) or photos | Edit `site/…`, then `git push` |
| See RSVPs / download a spreadsheet | Admin page → Responses |
| Back up everything | `npm run backup` (saves to `private/backups/`) |

Preview the site locally with `npm run dev` → http://localhost:3000. It uses your real Firebase data.

**Back up `private/`** somewhere safe (a private GitHub repo, Google Drive, …). It's not in the public repo.

**Don't change an event's `id`** after guests start RSVPing. Everything else about an event can change.

## Guest list CSV format

One row per guest. Guests who share a `household_id` are one family with one RSVP.
`site/guest-list-template.csv` has examples of each case.

| Column | Required | Notes |
|---|---|---|
| `household_id` | recommended | Short unique label, e.g. `sharma-family`, on every row of the family. **Keep it the same between uploads**: it's how existing RSVPs are matched. Blank means the guest becomes a household of one. |
| `household_name` | no | How the family is greeted, e.g. "The Sharma Family". Defaults to "The *Lastname* Family". |
| `first_name` | **yes** | |
| `last_name` | **yes** | |
| `email` | no | Visible only to admins |
| `phone` | no | Visible only to admins |
| `tags` | yes, in practice | Separated by **semicolons**: `groom's side; wedding only; india travel`. Case doesn't matter. Families never see their tags. |
| `max_additional_guests` | no | How many extra people the family may add (they must give full names). Blank or `0` means none. Only needed on one row of the family. |
| `additional_guest_tags` | no | Tags for those extra guests. If blank, they can attend any event someone in the family is invited to. |
| `invite_code` | no | Leave blank to auto-generate a random 8-character code (recommended), or set your own. |

Tags used in the sample config:

| Tag | Effect |
|---|---|
| `bride's side` / `groom's side` | Which wedding events they see (e.g. Haldi = bride's side, Baraat = groom's side) |
| `wedding only` | Hides the Reception |
| `reception only` | Hides all India events |
| `india travel` | Shows the **Travel** page |
| `us` | Shows the **Travel & Lodging** page |

You can invent any tags. Just reference them in `private/site.js`. The upload preview warns about tags
that no event or page uses (usually typos).

## How guests get in

- **Personal link** (best): `https://<you>.github.io/<repo>/?invite=K7PM3Q2X`. Copy it from the admin Guests tab,
  or download the responses CSV, which has an `invite_link` column for mail merges.
- **Invite code** typed on the sign-in page (print it on the invitation).
- **Name lookup**: first + last name. Convenient, but anyone who knows a guest's name can open their invitation.
  Turn it off with `allowNameLookup: false`, then `npm run publish`.

## Security notes

- The rules (`firestore.rules`) only let a family read their own invite and write their own RSVP.
  An RSVP can only list events they're invited to, can't exceed their additional-guest limit, and is refused
  after their last RSVP deadline. Admins can always edit.
- Per-occasion deadlines (India vs. US) are enforced on the RSVP page. The database itself allows edits
  until the family's *latest* deadline.
- Invite codes are the keys to each family's invitation. The random 8-character codes can't practically be guessed.
  Short custom codes trigger a warning.
