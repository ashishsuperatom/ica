// ── OAuth: the providers people sign in with, for a connection read with each person's own account ─────────────────
//
// A connector says it signs people in with one (its manifest: identity person-oauth, oauth { provider, scopes }); an
// organisation registers its own app with that provider (its client id and secret, sealed in the OrgDO); the platform runs
// the flow and keeps each person's tokens where their own key is kept (their UserDO, by project and connection).
// docs/connectors-plan.md R6.

export interface OAuthProvider {
  id: string; title: string
  authorize: string; token: string
  /** Asked with every sign-in: what makes the provider give a refresh token, and ask each time. */
  params: Record<string, string>
  /** Where an organisation registers its app, for the console to point at. */
  console: string
  /** Signs people in with a code shown to them (OAuth device code, RFC 8628) rather than sending the browser there and
   *  back: where the code is asked for. Its app is a public client — an app id, no secret. */
  device?: string
  /** The platform's own app with this provider, used by every organisation that has none of its own: the setting that
   *  holds its app id (a Worker variable — an app id is not a secret). */
  platformApp?: string
}

export const OAUTH_PROVIDERS: Record<string, OAuthProvider> = {
  google: {
    id: 'google', title: 'Google',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    params: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    console: 'https://console.cloud.google.com/apis/credentials',
  },
  microsoft: {
    id: 'microsoft', title: 'Microsoft',
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    device: 'https://login.microsoftonline.com/common/oauth2/v2.0/devicecode',
    params: {},
    console: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    platformApp: 'OAUTH_MICROSOFT_APP',
  },
}

/** Where every provider sends a person back: one address for every organisation and connector. */
export const OAUTH_CALLBACK = 'https://superatom.site/api/oauth/callback'

/** A person's tokens, as kept (sealed) in their UserDO in place of a key of their own. */
export interface OAuthTokens { provider: string; access_token: string; refresh_token: string | null; expires_at: number; scope?: string; account?: string | null }
