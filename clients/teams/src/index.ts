// Bot server: a restify endpoint the Bot Framework / Teams posts activities to.
// CloudAdapter authenticates the request (using the Microsoft App credentials),
// then hands the turn to SuperatomBot. Run with `pnpm dev`.

import restify from 'restify'
import { CloudAdapter, ConfigurationBotFrameworkAuthentication } from 'botbuilder'
import { config } from './config.js'
import { SuperatomBot, onTurnError } from './bot.js'

// Credentials for the adapter. Blank appId => local/emulator (unauthenticated).
const auth = new ConfigurationBotFrameworkAuthentication({
  MicrosoftAppId: config.appId,
  MicrosoftAppPassword: config.appPassword,
  MicrosoftAppType: config.appType,
  MicrosoftAppTenantId: config.appTenantId,
} as any)

const adapter = new CloudAdapter(auth)
adapter.onTurnError = onTurnError

const bot = new SuperatomBot()

const server = restify.createServer()
server.use(restify.plugins.bodyParser())

server.post('/api/messages', async (req, res) => {
  await adapter.process(req, res, (context) => bot.run(context))
})

// Health check.
server.get('/healthz', (_req, res, next) => { res.send(200, { ok: true }); next() })

server.listen(config.port, () => {
  console.log(`[teams] bot listening on :${config.port} — POST /api/messages`)
  if (!config.projectId) console.warn('[teams] SA_PROJECT_ID is empty — set it in .env before asking questions.')
})
