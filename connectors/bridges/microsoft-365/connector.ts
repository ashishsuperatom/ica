// Microsoft 365: a person's own Teams chats and Outlook mail, with their own Microsoft account (the platform signs them in
// with a code — a device sign-in — and hands an access token as the secret accessToken). A tree of two levels: Teams chats
// (the recent ones with their last message, then each chat's messages) and Outlook mail (each folder's messages).
import { apiConnector, json, ConnectorError, type ConnectorContext, type TreeNode } from '../../src/api'

const GRAPH = 'https://graph.microsoft.com/v1.0'
const PAGE = 50

/** A message's words without its markup (Teams and Outlook send HTML). */
const text = (html: unknown) => String(html ?? '').replace(/<(br|\/p|\/div)\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, '\n\n').trim()
const who = (m: any) => m?.from?.user?.displayName ?? m?.from?.application?.displayName ?? m?.from?.emailAddress?.name ?? m?.from?.emailAddress?.address ?? null

/** Every page of a Graph list, up to `limit` items. */
async function pages(ctx: ConnectorContext, first: string, limit: number): Promise<any[]> {
  const out: any[] = []
  let url: string | null = first
  while (url && out.length < limit) {
    const { data } = await json(ctx, url)
    out.push(...(data.value ?? []))
    url = data['@odata.nextLink'] ?? null
  }
  return out.slice(0, limit)
}

const chatName = (c: any) => c.topic || (c.members ?? []).map((m: any) => m.displayName).filter(Boolean).join(', ') || c.chatType || c.id

async function recentChats(ctx: ConnectorContext, limit: number) {
  const chats = await pages(ctx, `${GRAPH}/me/chats?$expand=lastMessagePreview,members&$orderby=lastMessagePreview/createdDateTime desc&$top=${PAGE}`, limit)
  return chats.map((c) => ({ chat: chatName(c), chat_id: c.id, kind: c.chatType ?? null, last_message_at: c.lastMessagePreview?.createdDateTime ?? null, last_from: who(c.lastMessagePreview), last_message: text(c.lastMessagePreview?.body?.content).slice(0, 500) || null }))
}

async function chatMessages(ctx: ConnectorContext, id: string, limit: number) {
  const msgs = await pages(ctx, `${GRAPH}/me/chats/${encodeURIComponent(id)}/messages?$top=${PAGE}&$orderby=createdDateTime desc`, limit)
  return msgs.filter((m) => m.messageType === 'message').map((m) => ({ at: m.createdDateTime ?? null, from: who(m), text: text(m.body?.content) || null, id: m.id }))
}

async function mailFolders(ctx: ConnectorContext): Promise<TreeNode[]> {
  const folders = await pages(ctx, `${GRAPH}/me/mailFolders?$top=${PAGE}`, 200)
  return folders.map((f) => ({ id: f.id, label: f.displayName, table: true, detail: { messages: f.totalItemCount ?? null, unread: f.unreadItemCount ?? null } }))
}

async function mail(ctx: ConnectorContext, folder: string, limit: number) {
  const msgs = await pages(ctx, `${GRAPH}/me/mailFolders/${encodeURIComponent(folder)}/messages?$top=${PAGE}&$orderby=receivedDateTime desc&$select=receivedDateTime,from,subject,bodyPreview,isRead,hasAttachments,importance`, limit)
  return msgs.map((m) => ({ received_at: m.receivedDateTime ?? null, from: who(m), from_address: m.from?.emailAddress?.address ?? null, subject: m.subject ?? null, preview: m.bodyPreview ?? null, read: m.isRead ?? null, attachments: m.hasAttachments ?? null, importance: m.importance ?? null }))
}

const ROOTS: TreeNode[] = [
  { id: 'chats', label: 'Teams chats', table: false },
  { id: 'mail', label: 'Outlook mail', table: false },
]

export const createBridge = apiConnector('microsoft-365', {
  description: "Microsoft 365 — the reader's own Teams chats and Outlook mail.",
  headers: ({ secrets }) => (secrets.accessToken ? { authorization: `Bearer ${secrets.accessToken}` } : {}),
  requires: ['accessToken'],
  async test(ctx) {
    const { data } = await json(ctx, `${GRAPH}/me?$select=displayName,userPrincipalName,mail`)
    return `signed in as ${data.mail ?? data.userPrincipalName ?? data.displayName ?? 'someone'}`
  },
  tree: {
    levels: [{ name: 'Where' }, { name: 'Chat or folder' }],
    async children(ctx, { path, search, limit }) {
      const term = String(search ?? '').toLowerCase()
      const keep = (n: TreeNode) => !term || n.label.toLowerCase().includes(term)
      if (!path.length) return { nodes: ROOTS.filter(keep), next: null }
      if (path[0] === 'chats') {
        const chats = (await recentChats(ctx, 100)).map((c) => ({ id: c.chat_id, label: c.chat, table: true, detail: { kind: c.kind, last: c.last_message_at } }))
        return { nodes: [{ id: 'recent', label: 'Recent chats (each with its last message)', table: true }, ...chats].filter(keep).slice(0, limit), next: null }
      }
      if (path[0] === 'mail') return { nodes: (await mailFolders(ctx)).filter(keep).slice(0, limit), next: null }
      throw new ConnectorError(`"${path[0]}" is neither chats nor mail`)
    },
    async read(ctx, { path, limit }) {
      const n = Math.min(limit ?? 100, 1000)
      if (path[0] === 'chats') return { rows: path[1] === 'recent' ? await recentChats(ctx, n) : await chatMessages(ctx, path[1], n), next: null }
      if (path[0] === 'mail') return { rows: await mail(ctx, path[1], n), next: null }
      throw new ConnectorError(`"${path[0]}" is neither chats nor mail`)
    },
  },
})
