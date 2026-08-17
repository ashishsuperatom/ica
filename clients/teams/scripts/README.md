# Teams scripts

Setup + test helpers. You log in / provide secrets; these do the mechanical work.

| Script            | What it does                                                            |
|-------------------|------------------------------------------------------------------------|
| `ask.ts`          | Engine smoke test — ask a project a question, print the JSON answer. No Teams/Azure needed. Run this FIRST. `pnpm ask "<question>"` |
| `package-app.sh`  | Zip `appPackage/` (manifest + icons) for sideloading into Teams.        |

More will land here as we automate Azure Bot creation and per-org (tenant→project)
config for the LOB distribution.
