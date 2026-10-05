// The Dynamic Worker's main module: an operation arrives as a POST; fetch is the gateway (the loader set it as the
// worker's only way out).
// @ts-ignore — the connector's bundled code sits beside this module in the sandbox
import connector from './connector.js'
import { runOp, type Op } from './sandbox'

export default {
  async fetch(request: Request): Promise<Response> {
    const { op, settings, req } = await request.json() as { op: Op; settings: Record<string, unknown>; req: unknown }
    // fetch called through a function: the runtime refuses its global fetch called with another `this`.
    return Response.json(await runOp(connector, op, settings ?? {}, req, (input, init) => fetch(input, init)))
  },
}
