# Template — a REST / HTTP API (`kind: rest`)

A source reached over HTTP (a SaaS API, an internal service). Some APIs can't be queried like SQL — you fetch
resources and the analyst works with the returned shapes.

## Connect
- **Auth — pick what the API uses:** an API key/header, OAuth 2.0 client-credentials (machine token, cached + refreshed), or a user-delegated OAuth token. Read creds from the source's `.env`, never hardcode.
- Implement `query(op, params)` as the API's natural operation (a path + query/body), returning an **array of clean row objects** (map the payload; drop envelope/metadata).
- `introspect()` returns what's available — endpoints/resource types, and inferred field shapes from a sample response when there's no schema endpoint.
- Respect **rate limits + pagination** (follow `next`/cursor; accumulate). Set `ready()` true only once a real call succeeds.

## Common issues (do these every time)
- **Normalize the response** to flat, clean rows the analyst can compute over; keep field names stable.
- **Pagination:** page to completion; if a result set is unbounded, throw a clear "narrow the request" error rather than returning a partial silently.
- Put API-specific quirks (required filters, id formats, throttling) in the source `description`.

## Verify
`GET /sources` → `ready:true` → `POST /introspect` → real resources → `POST /query` with a tiny call → real rows.
