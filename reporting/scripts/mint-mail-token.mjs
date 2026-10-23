// Mint a per-app mail token. The token is a secret: this prints only the token on
// stdout, so it can be piped, and puts everything else on stderr.
//
//   MAIL_SIGNING_KEYS='{"slob-prod":{...}}' \
//     pnpm mail:token --kid slob-prod --days 3650
//
// For local use, --key can build a one-entry registry:
//
//   pnpm mail:token --kid slob-prod --project slob-prod \
//     --domains dabur.com,superatom.ai \
//     --from-name "SLOB Action Planning" --key "<saved key>" --days 3650
//
// That mode never prints the key: save it in MAIL_SIGNING_KEYS (and a password
// manager) yourself. The token goes to stdout; give it to the app.

import { mintToken, parseRegistry } from '../src/mail/token.ts'

function usage() {
  console.error(`usage: pnpm mail:token --kid <kid> [--days 90] [options]

--days 3650 is a 10-year token; use it for unattended server-to-server callers.
--days 0 is also accepted for no expiry, but the default is 90 days.

With an existing registry (recommended):
  MAIL_SIGNING_KEYS='{"<kid>":{...}}' pnpm mail:token --kid <kid> [--days 90]

To create one entry locally (the key is not printed; save it yourself):
  pnpm mail:token --kid <kid> --project <project> --domains <domain,domain> \\
    --from-name "<display name>" --key <base64/base64url 32-byte key> [--days 90]

The token is written to stdout; all messages go to stderr.`)
}

function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      usage()
      process.exit(0)
    }
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`)
    const eq = arg.indexOf('=')
    if (eq > 0) {
      options[arg.slice(2, eq)] = arg.slice(eq + 1)
      continue
    }
    const key = arg.slice(2)
    const value = argv[++i]
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for --${key}`)
    options[key] = value
  }
  return options
}

try {
  const options = parseArgs(process.argv.slice(2))
  const days = Number(options.days ?? '90')
  if (!Number.isInteger(days) || days < 0 || days > 3650) {
    throw new Error('--days must be 0 (never) or an integer from 1 to 3650')
  }

  let registry
  let kid = options.kid

  if (options.key) {
    if (!kid) throw new Error('--kid is required')
    if (!options.project || !options.domains || !options['from-name']) {
      throw new Error('--project, --domains and --from-name are required with --key')
    }
    const domains = options.domains.split(',').map((domain) => domain.trim()).filter(Boolean)
    if (!domains.length) throw new Error('--domains must name at least one hostname')
    const candidate = {
      [kid]: {
        key: options.key,
        project: options.project,
        domains,
        fromName: options['from-name'],
      },
    }
    registry = parseRegistry(JSON.stringify(candidate))
    if (!registry) throw new Error('the key/entry is invalid (key must be at least 32 bytes; domains must be hostnames)')
  } else {
    registry = parseRegistry(process.env.MAIL_SIGNING_KEYS)
    if (!registry) throw new Error('set MAIL_SIGNING_KEYS, or pass --key with the entry fields')
    if (!kid) {
      const kids = Object.keys(registry)
      if (kids.length !== 1) throw new Error('--kid is required when the registry has more than one key')
      kid = kids[0]
    }
  }

  const entry = registry[kid]
  if (!entry) throw new Error(`no registry entry for kid: ${kid}`)

  const token = await mintToken(registry, kid, days * 86400)
  const expires = days === 0 ? 'never' : new Date(Date.now() + days * 86400_000).toISOString()
  console.error(`kid=${kid} project=${entry.project} domains=${entry.domains.join(',')} expires=${expires}`)
  process.stdout.write(`${token}\n`)
} catch (e) {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`)
  usage()
  process.exit(1)
}
