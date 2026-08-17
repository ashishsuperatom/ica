// Env config for the Teams bot. Values come from .env (see .env.example). We read
// process.env directly — the process is expected to be started with the env loaded
// (tsx picks up a .env via --env-file, or your shell/host injects it).

export const config = {
  // Engine hub (the bot is an adapter onto it).
  hubWs: process.env.SA_HUB_WS ?? 'wss://superatom.site',
  projectId: process.env.SA_PROJECT_ID ?? '',
  // v1 credential: the per-PROJECT API key (sk-proj-…) — the DO accepts this for server-side "adapters"
  // (same credential the code-engine uses). Eventually a per-USER platform JWT (see docs/identity-and-access.md);
  // engineToken is kept for that future path.
  engineKey: process.env.SA_ENGINE_KEY ?? '',
  engineToken: process.env.SA_ENGINE_TOKEN ?? '',

  // Teams / Azure Bot credentials (blank => local/emulator, unauthenticated).
  appId: process.env.MicrosoftAppId ?? '',
  appPassword: process.env.MicrosoftAppPassword ?? '',
  appType: process.env.MicrosoftAppType ?? 'MultiTenant',
  appTenantId: process.env.MicrosoftAppTenantId ?? '',

  port: Number(process.env.PORT ?? 3978),
}
