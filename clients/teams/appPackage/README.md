# Teams app package

Sideload into Teams as a `.zip` containing exactly:

```
manifest.json
color.png      # 192×192, full-color app icon
outline.png    # 32×32, transparent white outline
```

The two PNG icons are not committed (binary assets) — add your own before
zipping. Placeholders while experimenting: any 192×192 and 32×32 PNG will do.

## Fill in the manifest ids

`manifest.json` uses two placeholders you must replace before packaging:

- `${{TEAMS_APP_ID}}` — a GUID you generate for this app (stable across versions).
- `${{BOT_ID}}` — the **Microsoft App (bot) ID** from your Azure Bot resource
  (the same value as `MicrosoftAppId` in `../.env`).

(The `${{...}}` syntax matches Teams Toolkit token substitution; if you're not
using the toolkit, just paste the real GUIDs in.)

## Package + upload

```
cd appPackage
zip ../superatom-teams.zip manifest.json color.png outline.png
```

Then in Teams: **Apps → Manage your apps → Upload a custom app** → pick the zip.
