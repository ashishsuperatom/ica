# Mobile login — what the iOS app needs from the control plane

**Audience: whoever owns `control-plane/superadmin`.** Nothing here is implemented. The
iOS surface cannot ship a real login until these routes exist; this is the contract it
will code against.

## Why not the current stand-in

The app today has a settings panel where a service token, host, and project id are typed
in by hand. That is scaffolding and should be deleted once this lands:

- a service token is a **long-lived bearer secret travelling through a clipboard**, with
  no expiry anyone notices and no per-user identity behind it;
- **host is infrastructure**, not a user preference;
- **the project list should come from who you are**, not from someone remembering an id.

## The flow

```
app  ──ASWebAuthenticationSession──▶  GET  /mobile/auth
                                       (Clerk sign-in; the same Clerk already used by /u)
     ◀──redirect───────────────────  superatom://auth?code=<one-time>
app  ──HTTPS─────────────────────▶   POST /api/auth/mobile/exchange { code }
     ◀────────────────────────────   { token, userId, role }
app  ──HTTPS─────────────────────▶   GET  /api/me/projects        (Bearer token)
     ◀────────────────────────────   [{ org, projects: [...] }]
```

### Why a one-time code and not the token in the redirect

The redirect URL is the weakest link in the chain: it can land in logs, and on iOS a
custom scheme can in principle be claimed by another installed app. A **60-second,
single-use** code is worthless to an interceptor, because redeeming it requires a second
HTTPS call the app makes itself. This is exactly why OAuth uses an authorization code
rather than returning the token to the browser.

If you would rather harden it further, add PKCE: the app sends
`code_challenge = S256(verifier)` when opening `/mobile/auth`, and must present the
`verifier` at exchange. The iOS side can support that from day one — say the word.

## Routes

### 1. `GET /mobile/auth`

Serves a minimal HTML page that signs the user in with Clerk (publishable key
`pk_test_YXB0LWFsaWVuLTIxLmNsZXJrLmFjY291bnRzLmRldiQ`, same as `user-ui/src/main.tsx`;
read it from a var rather than hard-coding a third copy). On success the page:

1. calls `session.getToken()` for the Clerk session token;
2. `POST /api/auth/mobile/code { clerkToken }` → `{ code }`;
3. `location.replace('superatom://auth?code=' + code)`.

Accept an optional `?redirect_uri=` but **allow-list it** — reflecting an arbitrary
scheme back is an open-redirect that hands the code to any app that asks.

### 2. `POST /api/auth/mobile/code`

Body `{ clerkToken }`. Reuse the existing `handleTokenExchange` logic verbatim — Clerk
session validation, the `SUPERADMIN_EMAILS` gate, and the 30-day platform JWT. Do **not**
write a second copy of the token rules.

Then mint a random code (≥128 bits, `crypto.getRandomValues`), store
`{ code → token, userId, role, expiresAt }`, and return `{ code, expiresIn: 60 }`.

**Storage must be strongly consistent.** The code is written in one request and claimed
seconds later, possibly from a different colo — KV's eventual consistency will lose that
race and fail logins unpredictably. Put it in the **GlobalDO** (it is already a singleton
with SQLite):

```sql
CREATE TABLE IF NOT EXISTS mobile_login_code (
  code       TEXT PRIMARY KEY,
  token      TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'user',
  expires_at INTEGER NOT NULL
);
```

Sweep `expires_at < now` on every touch; no separate cleanup job needed.

### 3. `POST /api/auth/mobile/exchange`

Body `{ code }` → `{ token, userId, role }`.

**Delete the row on claim, before returning.** Single use is what makes a replay inside
the 60-second window worthless. Return `401` for missing/expired/already-claimed —
identical response for all three, so the endpoint can't be used to probe which codes exist.

### 4. `GET /api/me/projects`

`Authorization: Bearer <platform JWT>` → the orgs and projects this user may reach:

```json
[{ "org":      { "id": "...", "name": "..." },
   "projects": [{ "id": "...", "name": "...", "subdomain": "..." }] }]
```

Resolution, using what already exists:

- `GlobalDO GET /organizations` for the org list;
- per org, `OrgDO POST /user-by-clerk-id { clerkUserId }` — the platform JWT's `userId`
  **is** the Clerk user id (`handleTokenExchange` signs `session.user_id`);
- for orgs where the user resolves, `OrgDO GET /projects`;
- `role === 'superadmin'` sees every org without the membership check.

This is O(number of orgs) and fine at current scale, but it is a **scan**, and worth
replacing with a real `Membership` table when `docs/identity-and-access.md` gets built.

Project-level access control is deliberately **not** enforced here yet — org membership
is the gate for now, by agreement. `ProjectDO.members` is where it belongs when it lands.

## What iOS does with this

- token → **device Keychain** (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`), never
  the database, which is backed up;
- the org/project response seeds the local `organization` / `project` / `membership` /
  `projectAccess` tables, so the in-app switcher works offline afterwards;
- host becomes a build constant; the settings panel is deleted;
- `superatom://` is registered as a URL scheme in the app's Info.plist.

## Compatibility

Everything above is **additive** — no existing route changes behaviour. The web app,
Teams adapter, and service tokens keep working exactly as they do now.

The same flow serves Android unchanged. A native Clerk SDK can replace step 1 later
without touching steps 2–4, because the app's token interface is the same either way.
