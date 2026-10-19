# One door per person — the plan

The design is in `platform-architecture.md` → "One door per person". This file holds the steps; each is released on its
own (old and new working together for one release), with its tests written first from the rules: every kind of caller ×
every door × the decision it must get. Tick a step when it is built, tested and deployed.

**The rules the steps reach.**
1. The ProjectDO decides every request about its project (the OrgDO, about its organisation), with ONE function of
   shared/permissions.ts, from its own rows. Nothing it is sent says what the caller holds — only who the caller is.
2. Everything done with a person's authority — a login or a key — enters through that person's UserDO: the guard
   (early refusal, rate limits, the person's AI and storage cost). The UserDO is trusted only for who is asking.
3. The engine connects to its ProjectDO. Bytes go to storage with a ticket, never through a DO.

**Where it starts (read from the code, 2026-10-19).** People's WebSockets go through the UserDO; every REST call goes
Worker → ProjectDO / OrgDO, and the Worker decides it (`projectAccessOf` / `orgAccessOf` → `x-sa-caps`, which the DO
applies); WebSockets are decided in the ProjectDO (`capsOf`). The two compute differently: stored capabilities vs the
role; the platform admin gets the project's capabilities from the Worker, everything (`ALL`) from the DO; a few Worker
routes check a coarse level instead of a capability. Keys (`sak_<project>_…`, `sak_org_<org>_…`) are kept by hash in
the ProjectDO / OrgDO, and their person is found only after the check.

## Step 1 — One standing, decided where the facts are (deployed 2026-10-19, control plane 36246c4a — verified on every live project)

- [x] The ProjectDO: one `standing(caller)` — a person (by email: the platform admin everything, an organisation
      admin the admin role, else their role), a key (cut to its maker now, chains included), a service member — used by
      the WebSocket path and the REST path alike. Same in the OrgDO.
- [x] The Worker sends who the caller is (`x-sa-caller`: the verified email, or the key), never what they hold. The DO
      applies `projectRouteNeeds` / `orgRouteNeeds` itself and refuses with the reason. `x-sa-caps` is removed.
- [x] Routes the Worker answers itself or sends elsewhere (messaging config/status/selftest, dashboard uploads,
      objects, `me`) ask the ProjectDO for the caller's standing (`/standing`) — no coarse level checks.
- [x] Tests: every kind of caller gets the same capabilities by WebSocket and by REST; every route's need is enforced
      in the DO; a forged or missing caller is refused (`one-door.test.ts`). Every other test now calls the DOs as a real
      person seated with a real role (`__tests__/caller.ts`) — the made-up capabilities had hidden two wrong tests (a
      developer making keys it may not; an organisation where a seeded owner was never there).
- [x] The Worker drops, at the front door, every header that says who is asking (`x-sa-caller`, `x-sa-caps`,
      `x-sa-actor`, `x-sa-key`, `x-sa-claims`, `x-sa-project`, `x-sa-org`) — they are only ever set by the platform.
- [x] A request with no caller is the platform's own call (the organisation's storage totals; creating an
      organisation passes on the platform admin who creates it).

## Step 2 — Every person's request through their UserDO (built and tested 2026-10-19; not deployed)

- [x] The Worker checks the login and hands the request to the person's UserDO — their home in the project's
      organisation; for the organisations list, their platform home — through `viaDoor` (worker.ts). The UserDO's door
      (`/door/<project|org|global>/<id>/<path>`, user-do.ts) passes it on with who is asking; the ProjectDO / OrgDO /
      GlobalDO decide (step 1). A key still goes straight to its DO until step 4.
- [x] The Worker no longer refuses what it passes on: only what it answers itself (the machine's status, a service
      token, a dashboard's bytes) is checked there, against the standing the ProjectDO decided.
- [x] Uploads and downloads already go straight to R2 from the Worker after the decision (dashboard builds, parcels).
- [x] Tests (`one-door.test.ts`): a person's project and organisation requests and the organisations list arrive
      through their door (`x-sa-door: person` on the answer); a refusal still comes from the ProjectDO behind it; a key
      does not come through a door yet. For one release a UserDO still on the code before (no door) is passed by.
- [ ] Still direct, as the platform's own composing calls made after a decision (no caller): the organisation's
      totals (storage, usage), project lists, the dev-environment delete, creating and removing a project, the
      organisation's connector settings and credits (they name `by`). The organisation's own routes are still checked in
      the Worker too (against the OrgDO's standing) before going through the door. Both go in step 5.
- [ ] A file a person adds to a session still goes through their UserDO (`/attach`) — bytes through a DO: to move to
      a ticket and R2 (step 5).

## Step 3 — The guard (built and tested 2026-10-19; not deployed)

- [x] Every answer the ProjectDO / OrgDO gives a person's request carries the standing it decided (`x-sa-standing`);
      the person's UserDO keeps it as its copy (`standing_copy`, migration 9) and strips the header. When who may do what
      changes — access granted, changed or removed, organisation admins, roles, domains, the organisation's people and
      roles — the DO pushes the new standing to each person's UserDO (`/door-standing`), after the change.
- [x] The UserDO refuses early what a copy younger than 10 minutes already refuses, with the DO's own words
      (`x-sa-guard: refused`); no copy, an old one, the standing question itself, or giving a project role go on.
- [x] Tests: the guard refuses in the ProjectDO's words; a promotion reaches it by push; a removal too; a copy that
      still says admin lets the request on and the ProjectDO refuses it.

## Step 4 — Keys belong to people

- [ ] A key is `sak_<org>_<person>_<secret>`, kept by hash in the person's UserDO with its scopes (projects or the
      organisation, and capabilities); the ProjectDO / OrgDO keep a reference row per key (name, person, scopes,
      revoked) and are the authority on it. The key goes Worker → its person's UserDO (checked there: unknown, revoked,
      expired) → the project, which decides: the person's standing now ∩ the key's scopes ∩ not revoked here.
- [ ] The agent socket (sacli) comes through the person's UserDO too. The engine's key is unchanged.
- [ ] Every existing key re-issued once (only hashes were kept): sacli profiles by `sacli login --browser`, agents'
      keys by their makers. The old shape is accepted for one release, then removed.
- [ ] Tests: a key never holds more than its person now; removing the person stops every key of theirs; a project's
      revoke counts even before the UserDO hears of it.

## Step 5 — Clean up

- [ ] The platform's composing calls that act for a person (listed in step 2) go through the door with who is
      asking; the Worker's organisation checks go to the OrgDO alone; a session's files by ticket.
- [ ] Remove the leftover organisation socket (`worker.ts` → OrgDO), the Worker's level checks, and every reference to
      what was removed; the docs say what is built.

## Later (planned, after the door)

- Per person, in the UserDO: rate limits, AI token cost, data storage cost.
- Very chatty live signals (typing, presence) by a ticket from the door, straight to the session's home.
- A shared session's owner leaving: handing their sessions to another person.
