// Microsoft 365: a person's own Teams chats and Outlook mail, with their own Microsoft account (the platform signs them in
// with a code — a device sign-in — and hands an access token as the secret accessToken). A tree of two levels: Teams chats
// (the recent ones with their last message, then each chat's messages) and Outlook mail (each folder's messages).
import { apiConnector, json, ConnectorError, type ConnectorContext, type Entity, type TreeNode } from '../../src/api'

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

async function mail(ctx: ConnectorContext, folder: string, limit: number, unread = false) {
  const msgs = await pages(ctx, `${GRAPH}/me/mailFolders/${encodeURIComponent(folder)}/messages?$top=${PAGE}&$orderby=receivedDateTime desc${unread ? '&$filter=isRead eq false' : ''}&$select=receivedDateTime,from,subject,bodyPreview,isRead,hasAttachments,importance`, limit)
  return msgs.map((m) => ({ received_at: m.receivedDateTime ?? null, from: who(m), from_address: m.from?.emailAddress?.address ?? null, subject: m.subject ?? null, preview: m.bodyPreview ?? null, read: m.isRead ?? null, attachments: m.hasAttachments ?? null, importance: m.importance ?? null }))
}

// WHAT IT HOLDS, named for the index (the same for everyone — each person reads only their own): read by name, or walked
// as the tree below.
const ENTITIES: Entity[] = [
  { name: 'recent_chats', label: 'Recent Teams chats', description: "The reader's Teams chats, newest activity first, each with its last message.", fields: [
    { name: 'chat', type: 'string', description: "The chat's topic, or its members' names" }, { name: 'chat_id', type: 'string', key: true, description: 'Read its messages with chat_messages' },
    { name: 'kind', type: 'string', description: 'oneOnOne, group or meeting' }, { name: 'last_message_at', type: 'timestamp' }, { name: 'last_from', type: 'string' }, { name: 'last_message', type: 'string' }] },
  { name: 'chat_messages', label: 'Messages of a Teams chat', description: "One chat's messages, newest first (filters: chat_id, from recent_chats).", filters: ['chat_id'], fields: [
    { name: 'at', type: 'timestamp' }, { name: 'from', type: 'string' }, { name: 'text', type: 'string' }, { name: 'id', type: 'string', key: true }] },
  { name: 'mail', label: 'Outlook mail', description: "The reader's mail, newest first (filters: folder — inbox unless said; unread: true for unread only).", filters: ['folder', 'unread'], fields: [
    { name: 'received_at', type: 'timestamp' }, { name: 'from', type: 'string' }, { name: 'from_address', type: 'string' }, { name: 'subject', type: 'string' }, { name: 'preview', type: 'string' },
    { name: 'read', type: 'boolean' }, { name: 'attachments', type: 'boolean' }, { name: 'importance', type: 'string' }] },
]

const ROOTS: TreeNode[] = [
  { id: 'chats', label: 'Teams chats', table: false },
  { id: 'mail', label: 'Outlook mail', table: false },
]

export const createBridge = apiConnector('microsoft-365', {
  description: "Microsoft 365 — the reader's own Teams chats and Outlook mail.",
  headers: ({ secrets }) => (secrets.accessToken ? { authorization: `Bearer ${secrets.accessToken}` } : {}),
  requires: ['accessToken'],
  entities: ENTITIES,
  read: {
    recent_chats: async (ctx, { limit }) => ({ rows: await recentChats(ctx, limit), next: null }),
    chat_messages: async (ctx, { filters, limit }) => {
      const id = String((filters as any)?.chat_id ?? '')
      if (!id) throw new ConnectorError('chat_messages needs filters.chat_id — take one from recent_chats')
      return { rows: await chatMessages(ctx, id, limit), next: null }
    },
    mail: async (ctx, { filters, limit }) => ({ rows: await mail(ctx, String((filters as any)?.folder ?? 'inbox'), limit, (filters as any)?.unread === true || (filters as any)?.unread === 'true'), next: null }),
  },
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
