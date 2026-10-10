// @superatom/ui — the platform's one UI framework: every surface (the user UI, a dashboard, the control plane, a
// program's view) is built from these. Its rules are design/DESIGN-SYSTEM.md; its styles are design/index.css,
// imported once by the app.

// intents, programs, the thread's shape
export { Intent, INTENT_ATTR, readIntent, listIntents, listenIntents, sendIntent, type ScreenIntent, type IntentProps } from './intent.ts'
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
export { Icon } from './components/ui/Icon.tsx'
export { default as AppShell } from './components/layout/AppShell.tsx'
export { default as AskBar } from './components/frame/AskBar.tsx'
export { default as StepSkeleton } from './components/frame/StepSkeleton.tsx'
export { ProgramEnvContext, useProgramEnv, type ProgramEnv } from './components/frame/programEnv.ts'
export { NavList, type NavItem, type NavGroup } from './components/layout/Sidebar.tsx'
export { default as RailSidebar, type RailPlace } from './components/layout/RailSidebar.tsx'
export { default as SuperatomMark } from './components/layout/SuperatomMark.tsx'
export { Arranged, ArrangeButton, ArrangeProvider, useArrange, useArranging, arranged } from './components/frame/arrange.tsx'
export { default as Breadcrumbs, type Crumb, type CrumbChoice } from './components/layout/Breadcrumbs.tsx'
export { default as UserProfile, MenuItem, MenuRule } from './components/layout/UserProfile.tsx'
export { default as ConnectionStatus, type Connection, type Upgrading } from './components/layout/ConnectionStatus.tsx'
export { default as Search, useSearchKey, type SearchItem } from './components/layout/Search.tsx'

// a view's question and what it stands on: the controls, the next moves, about these numbers
export { default as QuestionControls, memberKeys, destinationOf, type QuestionOp, type QuestionCatalog, type QuestionMember } from './components/question/QuestionControls.tsx'
export { default as WindowControl } from './components/question/WindowControl.tsx'
export { default as NextMoves, MovePill } from './components/question/NextMoves.tsx'
export { default as AboutNumbers, type AboutFacts } from './components/question/AboutNumbers.tsx'

// the semantic components: what a screen composes
export { Columns, ColumnsSearch, type ColumnSpec, type ColumnItem } from './components/semantic/Columns.tsx'
export { TreeColumns, type TreeColumn, type TreeColumnRow } from './components/semantic/TreeColumns.tsx'
export { SourceHub, SourceMark, sourceColumns, searchTables, type HubSource, type TreeTable, type TreeField } from './components/semantic/Sources.tsx'
export { Explorer, type ExplorerTable, type ExplorerColumn, type ExplorerRequest, type ExplorerFilter, type ExplorerPlace, type ExplorerQuery } from './components/semantic/Explorer.tsx'
export { Form, Field, Input, Choices, Receipt, RecordList, ChartFrame, Status, AttentionList, ActionBar, Empty, Loading, PageHeader, Tabs, Notice, Code, Figures, Toolbar, Dialog, type Column, type Attention, type State as StatusState } from './components/semantic/index.tsx'
export { default as Track, type TrackStep, type TrackState } from './components/semantic/Track.tsx'

// primitives
export * from './components/ui/Section.tsx'
export { default as Select, Popover, type Option } from './components/ui/Select.tsx'
export { default as MultiSelect, type MultiOption, type MultiGroup } from './components/ui/MultiSelect.tsx'
export { default as ViewToggle, useView, type ViewOption } from './components/ui/ViewToggle.tsx'
export { default as Donut, legendLayout, type Slice, type LegendLayout } from './components/ui/Donut.tsx'
export { default as StackedBars } from './components/ui/StackedBars.tsx'
export { default as TimeColumns, type TimeSeries } from './components/ui/TimeColumns.tsx'
export { default as Settle } from './components/ui/Settle.tsx'
export { default as Nothing } from './components/ui/Nothing.tsx'
export { default as Toasts } from './components/ui/Toasts.tsx'

// helpers
export * from './lib/format.ts'
export { FormatsProvider, useFormat, formatsOf, type Formats, type UnitFormat } from './lib/formats.tsx'
export { markdownToHtml } from './lib/markdown.ts'
export { recall, remember } from './lib/remember.ts'
export { lru, type Lru } from './lib/lru.ts'
export { notify, dismiss, useToasts, type Toast, type ToastKind } from './lib/toast.ts'
export * from './lib/draft.ts'
export * from './lib/highlight.ts'
