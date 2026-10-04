// The sidebar, in the dashboard's design: the project with its live dot and a collapse toggle at the head; New chat
// and the chats; the agents the engine announced; the person signed in at the foot, name then email. Collapsed, a rail
// of icons. Everything it shows and does is handed in: this draws, App decides.

import type { ReactNode } from 'react'

export interface SidebarItem { key: string; label: string; title?: string; active: boolean; busy?: boolean; hue?: string; onClick: () => void }
export interface SidebarProps {
  collapsed: boolean
  onToggle: (collapsed: boolean) => void
  project: string
  projectTitle?: string
  connected: boolean
  onNewChat: () => void
  chats: SidebarItem[]
  agents: SidebarItem[]
  /** The project's agents, each opening a session. */
  sessionAgents?: SidebarItem[]
  account: ReactNode   // the foot: the signed-in person (App gives the Clerk-backed block, or the local one)
}

// Icons as inline lucide shapes: no icon service at runtime, the same strokes the dashboard draws.
const I = {
  panel: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  chat: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  agent: <><rect x="4" y="8" width="16" height="12" rx="2" /><path d="M12 4v4M9 13h.01M15 13h.01M9 17h6" /></>,
}
const Icon = ({ d, size = 17 }: { d: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d}</svg>
)
const Spin = () => <span style={{ width: 10, height: 10, borderRadius: '50%', border: '2px solid #c9d2dc', borderTopColor: T.primary, display: 'inline-block', animation: 'sa-spin 0.8s linear infinite', flexShrink: 0 }} />

// The dashboard's tokens, by value (this app has no stylesheet of its own).
export const T = {
  ink: '#1f2a37', muted: '#5b6b7f', faint: '#7b8898', line: '#e4e9f0', panel: '#eef2f6', sidebar: '#fbfcfd',
  primary: '#009193', primaryStrong: '#007476', primaryWash: 'color-mix(in srgb, #009193 10%, #ffffff)', win: '#15a34a', warn: '#f59e0b',
  w: 240, wCollapsed: 56,
}

export default function Sidebar(p: SidebarProps) {
  const dot = <span title={p.connected ? 'Connected' : 'Reconnecting…'} style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: p.connected ? T.win : T.warn }} />
  const item = (it: SidebarItem, icon: ReactNode, rail: boolean) => (
    <button key={it.key} onClick={it.onClick} title={it.title ?? it.label} className="sa-ui-nav" data-active={it.active}
      style={{ ...st.item, ...(rail ? st.itemRail : {}), ...(it.active ? st.itemActive : {}) }}>
      {it.busy ? <Spin /> : <span style={{ display: 'inline-flex', color: it.hue && !it.active ? it.hue : undefined }}>{icon}</span>}
      {!rail && <span style={st.itemText}>{it.label}</span>}
    </button>
  )
  return (
    <aside style={{ ...st.aside, width: p.collapsed ? T.wCollapsed : T.w }}>
      <style>{`@keyframes sa-spin{to{transform:rotate(360deg)}} .sa-ui-nav:hover{background:${T.panel} !important;color:${T.ink} !important} .sa-ui-nav[data-active="true"]:hover{background:${T.primaryWash} !important;color:${T.primaryStrong} !important} .sa-ui-btn:hover{background:${T.panel}}`}</style>
      {!p.collapsed ? (
        <>
          <div style={st.head}>
            <div style={st.brand} title={p.projectTitle ?? p.project}>
              <span style={st.logo}>{p.project.slice(0, 1).toUpperCase() || 'S'}</span>
              <span style={st.name}>{p.project}</span>
              {dot}
            </div>
            <button className="sa-ui-btn" style={st.iconBtn} onClick={() => p.onToggle(true)} title="Collapse sidebar" aria-label="Collapse sidebar"><Icon d={I.panel} size={19} /></button>
          </div>
          <div style={st.body}>
            {item({ key: 'new', label: 'New chat', active: false, onClick: p.onNewChat }, <Icon d={I.plus} />, false)}
            <div style={st.section}>Chats</div>
            {p.chats.length ? p.chats.map((c) => item(c, <Icon d={I.chat} />, false)) : <div style={st.empty}>No chats yet</div>}
            {!!p.sessionAgents?.length && <div style={st.section}>Agents</div>}
            {p.sessionAgents?.map((a) => item(a, <Icon d={I.agent} />, false))}
            {p.agents.length > 0 && <div style={st.section}>Consoles</div>}
            {p.agents.map((a) => item(a, <Icon d={I.agent} />, false))}
          </div>
          <div style={st.foot}>{p.account}</div>
        </>
      ) : (
        <>
          <div style={{ ...st.head, justifyContent: 'center', padding: 0 }}>
            <button className="sa-ui-btn" style={st.iconBtn} onClick={() => p.onToggle(false)} title="Expand sidebar" aria-label="Expand sidebar"><Icon d={I.panel} size={19} /></button>
          </div>
          <div style={st.rail}>
            {item({ key: 'new', label: 'New chat', active: false, onClick: p.onNewChat }, <Icon d={I.plus} />, true)}
            {p.sessionAgents?.map((a) => item(a, <Icon d={I.agent} />, true))}
            {p.agents.map((a) => item(a, <Icon d={I.agent} />, true))}
          </div>
          <div style={{ ...st.foot, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: 8, marginTop: 'auto' }}>{dot}</div>
        </>
      )}
    </aside>
  )
}

const st: Record<string, React.CSSProperties> = {
  aside: { flexShrink: 0, height: '100vh', position: 'sticky', top: 0, display: 'flex', flexDirection: 'column', background: T.sidebar, borderRight: `1px solid ${T.line}`,
           transition: 'width 180ms ease-out', fontFamily: 'Inter, system-ui, sans-serif', overflow: 'hidden' },
  head: { height: 56, padding: '0 12px', display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 },
  brand: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1, padding: '4px 6px' },
  logo: { width: 28, height: 28, borderRadius: 7, background: T.primary, color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 600, flexShrink: 0 },
  name: { fontSize: 13, fontWeight: 500, color: T.ink, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  iconBtn: { width: 36, height: 36, border: 'none', background: 'transparent', borderRadius: 9, color: T.faint, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 },
  body: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 12px 12px', display: 'flex', flexDirection: 'column', gap: 1 },
  rail: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '0 8px' },
  section: { padding: '14px 10px 4px', fontSize: 11, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: T.faint },
  item: { display: 'flex', alignItems: 'center', gap: 10, width: '100%', height: 32, padding: '0 10px', border: 'none', borderRadius: 9, background: 'transparent',
          fontSize: 13, color: T.muted, textAlign: 'left', cursor: 'pointer', flexShrink: 0, fontFamily: 'inherit', transition: 'background 120ms, color 120ms' },
  itemRail: { width: 36, height: 36, padding: 0, justifyContent: 'center' },
  itemActive: { background: T.primaryWash, color: T.primaryStrong, fontWeight: 500 },
  itemText: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  empty: { padding: '6px 10px', fontSize: 12, color: T.faint },
  foot: { padding: 12, borderTop: `1px solid ${T.line}` },
}
