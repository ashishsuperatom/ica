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

## Step 4 — Keys belong to people (built and tested 2026-10-19; not deployed)

- [x] A key is `sak_<project>_<person>_<secret>` or `sak_org_<org>_<person>_<secret>` (person = personId; the secret is
      always the last 43 characters, so the old shape is told apart by length). Its hash is kept only by the person's
      UserDO (`keys`, migration 10; `person-keys.ts`), with where it works; the project / organisation keeps the reference
      row (its `hash` column holds a placeholder) and is the authority on it.
- [x] A key goes Worker → its person's UserDO (`viaDoor`; the organisation from the key, or from its project), which
      checks it (unknown, revoked, expired, works elsewhere) and passes on only which key and whose
      (`{kind: 'agent', keyId, email}`) — the secret goes no further. The project decides: its row in force, its maker the
      person said, what it was given cut to what that person holds now (an organisation's key: as the organisation says).
- [x] The agent socket comes through the person's UserDO too: sacli opens `/_ws/<project>?agent=1&person=<personId>`, the
      UserDO's hub checks the key in the hello and links it to the project as an agent (`personLink` surface `agent`).
      The HTTP agent call and the organisation's agent route go through the door the same way. The engine's key is
      unchanged.
- [x] Revoking at the project or organisation tells the person's UserDO, which stops the key at the door; the DO refuses
      it anyway. Making a key fails (and its row is revoked) if the person's UserDO cannot keep it.
- [x] Every existing key is renewed once: `sacli keys renew [--all]` — the same key (id, capabilities, maker, the keys it
      made), a new secret that names its person, saved in the profile; the old secret stops working. For one release the
      old shape is still checked in the project / organisation by its hash, and its socket still goes to the project.
- [x] Tests: a key names its person and only their door can check it; a revoke and removing the person stop it at once;
      renewing keeps the key and kills the old secret (`key-renew.test.ts`, on a real SQLite table). Tests open a key's
      socket as sacli does (`socketQuery`). A revoked key coming back is stopped at its person's door, so the project's
      history no longer sees that attempt — the person's own history (planned) is where it belongs.

## Step 5 — Clean up (built and tested 2026-10-19; not deployed)

- [x] The person actions that skipped the door go through it: deleting one's dev environment (`project.develop`), an
      organisation's connector and sign-in-app settings, granting credits.
- [x] A file a person adds: admitted at their UserDO, its bytes written to the bucket by the Worker (`attachments.ts`) —
      no bytes through a DO.
- [x] Removed: the organisation's socket (the Worker's route, the OrgDO's socket, sessions and broadcasts — no client
      opened it), the ProjectDO's `/key-access`, step 1's fallback, `x-sa-caps`, and every unused name in the Worker's
      code; the unused-names check is now on for it (`tsconfig.worker.json`), as for the console.
- [x] The docs say what is built: this plan, platform-architecture ("One door per person", and the 2026-10-06 section no
      longer says keys go to the project), storage.md (the UserDO's `standing_copy` and `keys`, the key tables'
      placeholder hash), features.md.
- Kept, on purpose: the platform's own composing calls made after a decision (an organisation's totals, project lists,
  creating and removing a project); the Worker's check of the organisation's routes it composes itself, against the
  OrgDO's standing.

## After the deploy — the last of the old shape (one short change)

Everything marked `ONE RELEASE ONLY` in the code goes, once every live DO runs this code and every key is renewed:
- [ ] Renew every key: `sacli keys renew --all` on each machine that holds keys (the forge, the Mac), and any key given
      to an agent or a script.
- [ ] Remove: the old key shape (`AgentKeys.verify` by hash, `renew`, the `/renew` routes and their needs, `sacli keys
      renew`, the Worker's and ws-route's direct path for old keys, the old checks in the ProjectDO's and OrgDO's
      `standing`, `agentCall`, the OrgDO's `/agent` and `/key-access`), and the fallback for a UserDO with no door.
- [ ] A migration drops the key tables' `hash` column (the reference rows keep none).

## Later (planned, after the door)

- Per person, in the UserDO: rate limits, AI token cost, data storage cost.
- Very chatty live signals (typing, presence) by a ticket from the door, straight to the session's home.
- A shared session's owner leaving: handing their sessions to another person.
