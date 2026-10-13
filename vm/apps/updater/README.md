# The box's updater

Runs beside each project's engine as `superatom-<project name>-updater` (started by the installer, get.superatom.site/engine/install.sh), from the engine image:
`node /app/apps/updater/updater.mjs`. It switches the engine to the release chosen for the project in the admin console
(Operations → Engine version) or with `sacli engine switch <tag>`. How a switch goes and every outcome:
`docs/deploying-the-engine.md`, "How a switch happens on the box".

On the box:

| To | Run |
|---|---|
| see what it did | `docker logs superatom-<project name>-updater` |
| see the last outcome | `docker exec superatom-<project name> cat /app/data/<project>/engine-release/result.json` |
| make it again (it is not running) | run the installer on the box again: `curl -fsSL https://get.superatom.site/engine/install.sh \| sh` (the data is kept) |
| stop following releases for a while | `docker stop superatom-<project name>-updater`; `docker start` it to follow again |

A release can be switched to only if it reports that it came up (`engine-release/running.json`): every release from
`dev-20261010-5ff39c5e` on. An earlier one is started, never reports, and is rolled back after 90 s.
