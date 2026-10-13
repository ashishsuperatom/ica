// Sign-in (Clerk): which instance, in one place. Publishable keys are public by design — each encodes its instance's
// frontend host. The deployed consoles use production (clerk.superatom.site); a local `vite` dev server uses the
// development instance, because a production instance only works on its own domain. The platform accepts a session
// from either and checks it with that instance's secret (CLERK_SECRET_KEY, CLERK_DEV_SECRET_KEY) — access is by email,
// so a person is the same person through both.
export const CLERK_PRODUCTION_KEY = 'pk_live_Y2xlcmsuc3VwZXJhdG9tLnNpdGUk'
export const CLERK_DEVELOPMENT_KEY = 'pk_test_YXB0LWFsaWVuLTIxLmNsZXJrLmFjY291bnRzLmRldiQ'

/** The instance's frontend host a publishable key names: pk_<live|test>_<base64("<host>$")>. */
export const clerkHost = (publishableKey: string): string => atob(publishableKey.split('_')[2] ?? '').replace(/\$$/, '')
