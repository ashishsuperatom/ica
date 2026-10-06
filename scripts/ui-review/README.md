# UI review

Every console and Workspace page, at desktop (1440), tablet (1024) and phone (390) widths, captured from production with
real data and checked for the mistakes that kept reaching people:

- **clipped** — a control cut off or hidden by a container that hides its overflow
- **overflow** — the page scrolls sideways
- **flush** — text pressed against the inner edge of a card, panel or dialog
- **overlap** — a control lying over another

```
node scripts/ui-review/run.mjs login              # once: sign in, in the window that opens (the profile keeps it)
node scripts/ui-review/run.mjs config app=https://<project>.superatom.site
node scripts/ui-review/run.mjs run [filter]       # every page, or those whose key contains filter
node scripts/ui-review/run.mjs accept             # the next run is compared with this one
```

The gallery (`index.html` in the run's folder) shows each shot beside the accepted one, with every issue marked on it.
Runs live in `~/.superatom/review` — screenshots hold real data, so never in the repo. A page's steps (pages.mjs) only
select and open things; nothing is changed. Add a page to `pages.mjs` when you add one to the console or the Workspace.
