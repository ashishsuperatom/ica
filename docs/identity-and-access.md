# Identity & Access — design (not implemented)

Status: **design / thinking doc.** No code wired. Captures the protocol and data
structures for logging users in, giving them access, and SSO — across every
surface (web, Teams, Slack, mobile) — so we build it deliberately later.

## What already exists (the seed)

The web path already has the right shape; this design *generalises* it, it does
not replace it.

- **Web login:** Clerk authenticates the human → `POST /api/auth/token` validates
  the Clerk session → returns **our own JWT** (HMAC-SHA256) carrying
  `{ userId, orgId, role }`. Clerk is used once; every later call uses our JWT.
- **Trust boundary (already correct):** the hub/`ProjectDO` authenticates each WS
  connection at `hello` (browser sends `token: <our-jwt>`, server clients send
  `key: sk-proj-…`), and **ALWAYS stamps `from` on every relayed message — clients
  never set it.** The engine trusts the stamp.

So there is already **one platform token** and **one enforcement point**. The gap
is only: (a) more surfaces need to mint that token from *their* IdP, and (b) we
need a canonical, surface-independent identity + access model behind it.

## Principles

1. **One canonical identity, many external logins.** A person is one `Principal`.
   Clerk, Entra (Teams), Slack, mobile are just *external identities* linked to it.
2. **The platform token is the only currency.** Every surface, however it logs in,
   ends up presenting the same platform-issued JWT to the hub. The hub verifies
   *our* token, not the surface's raw credential.
3. **The DO is the Policy Enforcement Point.** It already stamps identity; it also
   decides which project a connection may reach and which message classes it may
   send. The engine trusts the stamp and enforces data scopes.
4. **Clients never self-assert.** Identity, org, project, role, and scopes are all
   server-derived and signed into the token; a client cannot claim them.
5. **JSON-answer analogy:** just as the structured answer is the common
   denominator every surface renders differently, the **platform token is the
   common denominator every surface authenticates into differently.**

## Core data structures

Issuer-agnostic (we own the system of record; Clerk/Entra/Slack are issuers, not
the source of truth).

```
Principal            # the canonical person
  id                 # sa-usr-…
  primaryEmail
  displayName
  status             # active | suspended
  createdAt

ExternalIdentity     # a login this Principal can use — the federation table
  id
  principalId  → Principal
  issuer             # clerk | entra | slack | apple | google | …
  subject            # the issuer's stable user id (Clerk userId / AAD oid / Slack user_id)
  email, emailVerified
  claims             # raw issuer claims (audit / re-resolution)
  linkedAt
  UNIQUE(issuer, subject)          # (issuer, subject) → exactly one Principal

Org                  # the platform tenant (customer)
  id                 # sa-org-…
  name, status, plan
  createdAt

OrgBinding           # maps a surface's "org" to our Org — the Teams tenant→project routing, generalised
  id
  orgId  → Org
  surface            # web | teams | slack
  externalOrgId      # Clerk orgId | AAD tenantId | Slack team_id
  verified           # domain-verified / admin-consented (see open Q: org-claim trust)
  UNIQUE(surface, externalOrgId)

Project              # one engine instance (already exists: ProjectDO)
  id
  orgId  → Org
  name
  engineRef          # which machine/instance
  status

Membership           # org-level role
  principalId → Principal
  orgId       → Org
  role               # owner | admin | builder | member
  createdAt
  UNIQUE(principalId, orgId)

ProjectGrant         # project-level access (subject may be a principal OR a whole org)
  id
  subjectType        # principal | org
  subjectId
  projectId  → Project
  role               # builder | analyst | viewer
  scopes             # OPTIONAL fine-grain (start null = whole project):
                     #   datasourceIds[]? personaId? intentTags[]?
  grantedBy, createdAt, expiresAt?

Session              # optional server-side record for revocation (token is otherwise stateless)
  id (jti)
  principalId, surface, device
  issuedAt, lastSeenAt, revokedAt?

Invite / AccessRequest        # HOW access is given
  Invite:        email, orgId|projectId, role, token, expiresAt, acceptedByPrincipalId?
  AccessRequest: principalId, orgId|projectId, requestedRole, status  # pending|granted|denied
```

### Roles → capabilities (the two-plane profiles, made explicit)

Access control is a **hard boundary**, distinct from *persona* (which is soft
prompt-guidance + an adversarial filter, deliberately not enforced).

```
BUILDER plane   (build/maintain computation)   connect_source, edit_semantic_model,
                                               run_consolidation, view_agent_terminal,
                                               manage_project
RUNTIME plane   (ask + consume)                ask, view_answer, modify_answer,
                                               download, view_intent_graph

owner/admin  → builder plane + runtime plane + manage members/grants
builder      → builder plane + runtime plane
analyst      → runtime plane (ask/modify/download)
viewer       → view_answer only (no ask/modify)
```

(This is the `role: developer | user` axis in today's UI, promoted to a real
capability set.)

## The auth protocol (per connection)

Seven steps, ending at the existing `hello` handshake:

```
A. Authenticate        surface verifies the human with its native IdP
                       → a verified external credential (issuer, subject, email, …)
B. Resolve / link      (issuer, subject) → Principal
                       found → use it; not found → create-or-link by VERIFIED email;
                       ambiguous → pending-link flow (never silently merge)
C. Resolve org+project OrgBinding(surface, externalOrgId) → Org → Project
                       (explicit pick, or the org's default project)
D. Authorize           Membership + ProjectGrant → compute {role, capabilities, scopes}
                       (JIT-provision a default member on first login from a bound org)
E. Mint token          platform Auth service signs a JWT (claims below)
F. Connect             client opens  wss://<hub>/_ws/<projectId>?token=<jwt>
                       DO verifies OUR token, resolves the connection, and STAMPS
                       {principalId, orgId, projectId, role, caps} onto every message
G. Enforce             DO gates: may this connection target this project? is this
                       message class within its caps (builder vs runtime)?
                       engine additionally enforces data scopes from the stamp
```

### Platform token (claims)

```
sub  principalId          org  orgId            prj  projectId
sur  surface (web|teams|slack|mobile)
rol  role                 cap  [capabilities]   scp  scopes (optional)
iat, exp, jti             # jti ↔ Session for revocation
```

One signer, one verifier (the DO). Everything downstream is uniform regardless of
which surface authenticated.

## Per-surface authentication (step A → B)

- **Web / mobile:** Clerk (already). Clerk also brokers enterprise SSO (below).
  Mobile uses the same Clerk→platform-token exchange over HTTPS.
- **Teams:** the user is already SSO'd into their Entra tenant. Every bot Activity
  carries `tenantId` + the user's `aadObjectId` — a *verified* external identity we
  get for free. `OrgBinding(teams, tenantId)` → Org. For email/group claims, use
  Teams SSO (on-behalf-of → Graph). **Bot service-token path:** the bot is a
  trusted confidential client holding a platform service credential; it presents
  (service credential + attested AAD identity from the signed Activity) to the
  Auth service to mint a **user-scoped** platform token. The bot never fabricates
  identity — the platform attests it. (This closes the open item from the Teams
  scaffold.)
- **Slack:** Slack OIDC → `team_id` + `user_id`. `OrgBinding(slack, team_id)` → Org.
  Same token-exchange pattern.

## SSO & provisioning

- **Enterprise SSO (web/mobile):** delegate to **Clerk enterprise connections**
  (SAML/OIDC) — the customer's Okta/Entra/Google Workspace federates into Clerk;
  we receive a verified identity + org. Little work for us.
- **Teams SSO:** native — identity comes from the tenant; no separate login.
- **JIT provisioning:** first login from a *bound, verified* org auto-creates a
  `Membership` with the org's default role.
- **Deprovisioning:** SSO/SCIM removal (later) revokes `Membership` + open
  `Session`s. Directory sync (SCIM) is a Phase-2 nicety, not v1.
- **Audit:** every access decision (grant, deny, token mint, project reach) is
  logged — fits the platform's provenance/"reasoning-trace" ethos.

## Open decisions (the "how we have to think about it")

1. **Identity join key.** Auto-link external logins by *verified* email, or require
   explicit account-linking? Email is convenient but risky (reuse, unverified).
   Lean: link only on verified email; otherwise an explicit link flow. Never
   silently merge.
2. **Canonical store vs Clerk-as-hub.** Do we own the `Principal` store
   (issuer-agnostic, recommended — Teams/Slack won't funnel cleanly through Clerk),
   or make Clerk the identity hub and federate everything into it? Recommend: own
   the Principal; Clerk stays the web/mobile issuer + enterprise-SSO broker only.
3. **Org-claim trust.** How do we trust that AAD tenant X == platform Org Y? Via
   admin-consent at app install **plus** a domain-verification step, so a random
   tenant can't claim an existing Org. `OrgBinding.verified` gates this.
4. **Scope granularity.** Start coarse (project-level role); the `ProjectGrant.scopes`
   column is designed so we can tighten to datasource/persona/intent later without a
   migration.
5. **Where the Auth service runs.** A Cloudflare Worker on the runtime plane issues
   and signs tokens; publish a JWKS so the DO verifies by public key (upgrade from
   today's shared HMAC secret once multiple issuers exist).
6. **Token lifetime / revocation.** Short-lived platform tokens + refresh, with
   `jti`→`Session` for hard revoke. Bot-minted user tokens should be short and
   per-conversation.

## Non-goals (for v1) / phasing

- v1: canonical Principal + ExternalIdentity, OrgBinding, Membership,
  project-level ProjectGrant, the token + DO enforcement, Clerk (web/mobile) and
  Teams (Entra) issuers.
- Later: Slack issuer, SCIM directory sync, fine-grained scopes, per-datasource
  access, self-serve Store distribution.
```
