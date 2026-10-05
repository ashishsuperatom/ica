// @superatom/ui — the platform's one UI framework: every surface (the user UI, a dashboard, the control plane, a
// program's view) is built from these. Its rules are design/DESIGN-SYSTEM.md; its styles are design/index.css,
// imported once by the app.

// intents, programs, the thread's shape
export { Intent, INTENT_ATTR, readIntent, listIntents, listenIntents, type ScreenIntent, type IntentProps } from './intent.ts'
export { loadProgramUI, ProgramLoadError, type LoadOptions } from './load.ts'
export { Thread, pathOf, latestUnder, siblingsOf, type ThreadProps } from './thread.ts'

// the design system
export * from './design/index.ts'

// answers: blocks, renderers, the one answer component, paths from here, artifacts
export * from './answer/blocks.ts'
export { BlockView, Blocks, type BlockCallbacks, type Renderer } from './components/blocks/index.tsx'
export { ringAllowed, RING_MAX } from './components/blocks/Bars.tsx'
export { BeatRows, BeatsDisclosure } from './components/blocks/Beats.tsx'
export { default as Answer, answerParts, periodsOf, type AnswerProps, type AnswerCall } from './components/answer/Answer.tsx'
export { default as Paths, type Recognised, type LearnedPath, type Offered } from './components/answer/Paths.tsx'
export { default as Artifacts, type Artifact } from './components/answer/Artifacts.tsx'

// the thread on screen
export { default as BlockFrame, type FrameProps } from './components/frame/BlockFrame.tsx'
export { default as BranchBar, type Sibling } from './components/frame/BranchBar.tsx'
export { default as Steps, Separator, type StepItem } from './components/frame/Steps.tsx'
export { default as LocalThread, useThread, startThread, type BlockApi, type BlockDef, type Registry, type LocalBlock } from './components/frame/LocalThread.tsx'
export { useBlockHeader, useBlockCopy, type Header, type CopyText } from './components/frame/header.tsx'
export { blockToText } from './components/frame/copy.ts'
export { useBlockKeys, revealBlock } from './components/frame/navigation.ts'

// the shell
export { default as AppShell } from './components/layout/AppShell.tsx'
export { default as Sidebar, type NavItem, type NavGroup } from './components/layout/Sidebar.tsx'
export { default as UserProfile } from './components/layout/UserProfile.tsx'
export { default as ConnectionStatus, type Connection } from './components/layout/ConnectionStatus.tsx'

// primitives
export * from './components/ui/Section.tsx'
export { default as Select, Popover, type Option } from './components/ui/Select.tsx'
export { default as MultiSelect, type MultiOption, type MultiGroup } from './components/ui/MultiSelect.tsx'
export { default as ViewToggle, useView, type ViewOption } from './components/ui/ViewToggle.tsx'
export { default as Donut, legendLayout, type Slice, type LegendLayout } from './components/ui/Donut.tsx'
export { default as StackedBars } from './components/ui/StackedBars.tsx'
export { default as Settle } from './components/ui/Settle.tsx'
export { default as Nothing } from './components/ui/Nothing.tsx'
export { default as Toasts } from './components/ui/Toasts.tsx'

// helpers
export * from './lib/format.ts'
export { markdownToHtml } from './lib/markdown.ts'
export { recall, remember } from './lib/remember.ts'
export { notify, dismiss, useToasts, type Toast, type ToastKind } from './lib/toast.ts'
export * from './lib/draft.ts'
export * from './lib/highlight.ts'
