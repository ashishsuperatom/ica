# The box's updater

Runs beside each project's engine as `sa-engine-updater-<project>` (started by `sacli engine start`), from the engine image:
`node /app/apps/updater/updater.mjs`. It switches the engine to the release chosen for the project in the admin console
(Operations → Engine version) or with `sacli engine switch <tag>`. How a switch goes and every outcome:
`docs/deploying-the-engine.md`, "How a switch happens on the box".

On the box:

| To | Run |
|---|---|
| see what it did | `docker logs sa-engine-updater-<project>` |
| see the last outcome | `docker exec sa-engine-<project> cat /app/data/<project>/engine-release/result.json` |
| make it again (it is not running) | `sacli engine start` (from a machine with `DOCKER_HOST=ssh://<box>`) |
| stop following releases for a while | `docker stop sa-engine-updater-<project>`; `docker start` it to follow again |

A release can be switched to only if it reports that it came up (`engine-release/running.json`): every release from
`dev-20261010-5ff39c5e` on. An earlier one is started, never reports, and is rolled back after 90 s.
