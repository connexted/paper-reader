import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createArticleBoundaryStore, type ArticleBoundaryStore } from './articleBoundaryStore'
import { createArticleNavigation } from './articleNavigation'
import { api } from './api'
import { useDialogFocus, useMenuFocus } from './dialogFocus'
import { useReadingProgress } from './readingProgress'
import { clearOffline, offlineArticles, removeOffline, saveOffline } from './offline'
import { fullTextMode, setFullTextMode, type FullTextMode } from './fullTextPreferences'
import { FeedRepair } from './components/FeedRepair'
import { ArticleDiscussion } from './components/ArticleDiscussion'
import { ConnectionSettings } from './components/ConnectionSettings'
import { isDarkTheme, toggledTheme } from './appearance'
import { removeBrokenArticleImage, shouldShowArticleLeadImage } from './articleImages'
import { Icon } from './components/Icon'
import { ActivitySettings, FiltersSettings, ReportsSettings } from './components/SettingsPanels'
import { TopicsLibrary } from './components/TopicsLibrary'
import { feedMatchesFilter, type FeedFilter } from './feedFilters'
import { automaticFullTextFeeds, recordFullTextSuccess } from './fullTextPreferences'
import { movementDirection } from './keyboard'
import { readReaderLocation, readerLocationUrl, type MobilePane, type ReaderLocation } from './location'
import { articleEdgeState, swipeDirection, type GesturePoint } from './mobileGestures'
import { initialReaderChromeScrollState, readerChromeCanAutoHide, updateReaderChromeScroll } from './readerChrome'
import { authorLine, resistedPullDistance, shouldAutoMarkRead, shouldAutomaticallyFetchFullArticle, shouldFetchFullArticle, shouldReleaseToRefresh } from './reading'
import { formatInstagramHtml, formatThreadsHtml, formatXPostHtml, formatYoutubeHtml } from './socialHtml'
import type { ArticleReport, BriefingDetail, BriefingSummary, Entry, Feed, Folder, NavigationPayload, StreamRef, XThreadPost } from './types'

type ReaderFont = 'literata' | 'source'
type ReaderSize = 'small' | 'medium' | 'large'
type ReaderSpacing = 'compact' | 'comfortable' | 'spacious'
type ReaderWidth = 'narrow' | 'standard' | 'wide'
type ArticleBoundaryDirection = 'previous' | 'next'
type ArticleTransition = '' | 'previous-in' | 'next-in'

const ARTICLE_BOUNDARY_DISTANCE = 56
const ARTICLE_BOUNDARY_ZONE_SIZE = 96

const allStream: StreamRef = { kind: 'all', id: 'all', title: 'All articles' }
function articleContent(entry: Entry): Partial<Entry> { return { contentHtml: entry.contentHtml, excerpt: entry.excerpt, readingMinutes: entry.readingMinutes, author: entry.author, fullText: Boolean(entry.fullText) } }

type PulseContext = { id: string; title: string; ids: string[] }
function savedPulseContext(id?: string): PulseContext | null {
  try { const value = JSON.parse(sessionStorage.getItem(`paper-collection:${id}`) || 'null'); return value?.id === id && Array.isArray(value.ids) ? value : null } catch { return null }
}

const starredStream: StreamRef = { kind: 'starred', id: 'starred', title: 'Starred' }

function sidebarFolderRank(folder: Folder): number {
  return ['games', 'tech'].indexOf(folder.title.trim().toLowerCase()) + 1
}

interface OverlayState {
  command: boolean
  help: boolean
  settings: boolean
  appearance: boolean
}

type SettingsSection = 'feeds' | 'filters' | 'reports' | 'activity' | 'connections'

const closedOverlays: OverlayState = { command: false, help: false, settings: false, appearance: false }

interface ToastState {
  message: string
  actionLabel?: string
  action?: () => void
}

interface FeedContextState {
  feed: Feed
  left: number
  top: number
}

interface FolderContextState {
  folder: Folder
  left: number
  top: number
}

interface EntryContextState {
  entry: Entry
  left: number
  top: number
}

interface SelectionContextState {
  quote: string
  left: number
  top: number
}

export default function App() {
  const [initialLocation] = useState(() => readReaderLocation())
  const [view, setView] = useState(initialLocation.view)
  const [navigation, setNavigation] = useState<NavigationPayload | null>(null)
  const [stream, setStream] = useState<StreamRef>(initialLocation.stream)
  const [entries, setEntries] = useState<Entry[]>([])
  const [selectedId, setSelectedId] = useState(initialLocation.selectedId)
  const [unreadOnly, setUnreadOnly] = useState(initialLocation.unreadOnly)
  const [query, setQuery] = useState(initialLocation.query)
  const [searchStream, setSearchStream] = useState<StreamRef>(initialLocation.searchStream || allStream)
  const [searchUnread, setSearchUnread] = useState(initialLocation.searchUnread || false)
  const [after, setAfter] = useState(initialLocation.after || '')
  const [before, setBefore] = useState(initialLocation.before || '')
  const dates = useMemo(() => ({ after, before: before && Number.isFinite(Date.parse(before)) ? new Date(Date.parse(before) + 86400000).toISOString() : '' }), [after, before])
  const [libraryMode, setLibraryMode] = useState<'stream' | 'recent' | 'offline'>(initialLocation.library || 'stream')
  const [linkedCollection, setLinkedCollection] = useState(initialLocation.view === 'pulse' ? initialLocation.collection : undefined)
  const [pulseContext, setPulseContext] = useState<PulseContext | null>(() => savedPulseContext(initialLocation.collection))
  const [listError, setListError] = useState('')
  const [actionError, setActionError] = useState<{ id: string; message: string; operation: 'read' | 'unread' | 'star' | 'unstar' } | null>(null)
  const [lastSync, setLastSync] = useState<string | null>(null)
  const [online, setOnline] = useState(navigator.onLine)
  const [syncError, setSyncError] = useState('')
  const [autoRead, setAutoRead] = useState(() => localStorage.getItem('paper-auto-read') !== 'manual')
  const [fullMode, setFullMode] = useState<FullTextMode>('auto')
  const feedVersions = useRef(new Map<string, Entry>())
  const fullVersions = useRef(new Map<string, Entry>())
  const [readwiseBusy, setReadwiseBusy] = useState(false)
  const [bulkPreview, setBulkPreview] = useState<{ token: string; count: number; label: string } | null>(null)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [offlineBusy, setOfflineBusy] = useState(false)

  const [loading, setLoading] = useState(true)
  const [entryOrder, setEntryOrder] = useState<'newest' | 'oldest'>('newest')
  const [savingOrder, setSavingOrder] = useState(false)
  const entryOrderRef = useRef(entryOrder)
  entryOrderRef.current = entryOrder
  const [loadingMore, setLoadingMore] = useState(false)
  const [continuation, setContinuation] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [topicsRefreshKey, setTopicsRefreshKey] = useState(0)
  const [fetchingFullTextId, setFetchingFullTextId] = useState('')
  const [fullTextError, setFullTextError] = useState<{ id: string; message: string } | null>(null)
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [mobilePane, setMobilePane] = useState<MobilePane>(initialLocation.mobilePane)
  const [mobileLayout, setMobileLayout] = useState(() => window.matchMedia('(max-width: 1040px)').matches)
  const [overlays, setOverlays] = useState<OverlayState>(closedOverlays)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('feeds')
  const [settingsFeedId, setSettingsFeedId] = useState('')
  const [feedContext, setFeedContext] = useState<FeedContextState | null>(null)
  const [folderContext, setFolderContext] = useState<FolderContextState | null>(null)
  const [entryContext, setEntryContext] = useState<EntryContextState | null>(null)
  const [selectionContext, setSelectionContext] = useState<SelectionContextState | null>(null)
  const [discussionTarget, setDiscussionTarget] = useState<{ entry: Entry; quote: string } | null>(null)
  useEffect(() => {
    if (discussionTarget && (discussionTarget.entry.id !== selectedId || view !== 'reader')) setDiscussionTarget(null)
  }, [selectedId, view, discussionTarget])
  const [reportEntry, setReportEntry] = useState<Entry | null>(null)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [theme, setTheme] = useState(() => localStorage.getItem('paper-theme') || 'system')
  const [readerFont, setReaderFont] = useState<ReaderFont>(() => localStorage.getItem('paper-reader-font') === 'source' ? 'source' : 'literata')
  const [readerSize, setReaderSize] = useState<ReaderSize>(() => storedChoice('paper-reader-size', ['small', 'medium', 'large'], 'medium'))
  const [readerSpacing, setReaderSpacing] = useState<ReaderSpacing>(() => storedChoice('paper-reader-spacing', ['compact', 'comfortable', 'spacious'], 'comfortable'))
  const [readerWidth, setReaderWidth] = useState<ReaderWidth>(() => storedChoice('paper-reader-width', ['narrow', 'standard', 'wide'], 'standard'))
  const [pullDistance, setPullDistance] = useState(0)
  const [sourcePullDistance, setSourcePullDistance] = useState(0)
  const [readerChromeHidden, setReaderChromeHidden] = useState(false)
  const [articleBoundaryStore] = useState(createArticleBoundaryStore)
  const [articleNavigation] = useState(createArticleNavigation)
  const [articleNavigationBusy, setArticleNavigationBusy] = useState(false)
  const [articleTransition, setArticleTransition] = useState<ArticleTransition>('')
  const [automaticFullFeeds, setAutomaticFullFeeds] = useState(() => automaticFullTextFeeds(localStorage))
  const [status, setStatus] = useState({ discussionConfigured: false, readwiseConfigured: false, kirbyConfigured: false, briefingConfigured: false })
  const listRef = useRef<HTMLDivElement>(null)
  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId
  const pendingListScroll = useRef<{ top: number; anchors: Array<{ node: HTMLElement; top: number }> } | null>(null)
  const sourceListRef = useRef<HTMLElement>(null)
  const storyRowRefs = useRef(new Map<string, HTMLElement>())
  const articleRef = useRef<HTMLElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const loadMoreRef = useRef<HTMLDivElement>(null)
  const streamStartRef = useRef<HTMLDivElement>(null)
  const toastTimer = useRef<number | undefined>(undefined)
  const requestSerial = useRef(0)
  const loadedEntriesScope = useRef('')
  const pullStartY = useRef(0)
  const pullStartX = useRef(0)
  const pullEligible = useRef(false)
  const sourcePullStartY = useRef(0)
  const sourcePullEligible = useRef(false)
  const automaticFullTextAttempts = useRef(new Set<string>())
  const manuallyUnreadId = useRef('')
  const readerChromeScroll = useRef(initialReaderChromeScrollState())
  const storyGestureStart = useRef<(GesturePoint & { atTop: boolean; atBottom: boolean }) | null>(null)
  const storyGestureLast = useRef<GesturePoint | null>(null)
  const articleBoundaryGesture = useRef<{ direction: ArticleBoundaryDirection | null; travel: number; ready: boolean }>({ direction: null, travel: 0, ready: false })
  const articleBoundaryHaptic = useRef(false)
  const preparedStreamLoad = useRef<StreamRef | null>(null)
  const readerChromeTap = useRef<(GesturePoint & { pointerId: number }) | null>(null)

  const selected = entries.find(entry => entry.id === selectedId) || null
  const currentReader = useRef({ stream, selected })
  currentReader.current = { stream, selected }
  const selectedIndex = selected ? entries.findIndex(entry => entry.id === selected.id) : -1
  const currentFolderIndex = stream.kind === 'category' ? navigation?.folders.findIndex(folder => folder.id === stream.id) ?? -1 : -1
  const folderNavigation = libraryMode === 'stream' && !query && !pulseContext && currentFolderIndex >= 0
  const previousFolder = folderNavigation ? navigation?.folders.slice(0, currentFolderIndex).reverse().find(folder => !unreadOnly || folder.unread > 0) : undefined
  const nextFolder = folderNavigation ? navigation?.folders.slice(currentFolderIndex + 1).find(folder => !unreadOnly || folder.unread > 0) : undefined
  const previousFolderAvailable = Boolean(previousFolder)
  const nextFolderAvailable = Boolean(nextFolder)
  const atStreamEnd = selectedIndex >= 0 && selectedIndex === entries.length - 1 && !continuation
  const atStreamStart = selectedIndex === 0
  const previousArticleAvailable = pulseContext && selected ? pulseContext.ids.indexOf(selected.id) > 0 : selectedIndex > 0 || previousFolderAvailable
  const nextArticleAvailable = pulseContext && selected ? pulseContext.ids.indexOf(selected.id) < pulseContext.ids.length - 1 : (selectedIndex >= 0 && selectedIndex < entries.length - 1) || Boolean(continuation) || nextFolderAvailable
  const previousArticleTitle = pulseContext ? 'Previous article in collection' : selectedIndex > 0 ? entries[selectedIndex - 1].title : 'Beginning'
  const nextArticleTitle = pulseContext ? 'Next article in collection' : selectedIndex >= 0 && selectedIndex < entries.length - 1 ? entries[selectedIndex + 1].title : continuation ? 'Next article' : 'End'
  const starredView = !query && stream.kind === 'starred'
  const streamUnreadOnly = query ? searchUnread : unreadOnly && !starredView
  const unreadStreamTotal = !query && streamUnreadOnly ? streamUnreadCount(navigation, stream) : null
  const visibleStreamTotal = libraryMode === 'stream' ? unreadStreamTotal : null
  const feedIcons = useMemo(() => {
    const icons = new Map<string, string>()
    for (const folder of navigation?.folders || []) {
      for (const feed of folder.feeds) icons.set(feed.id, feed.iconUrl)
    }
    for (const feed of navigation?.uncategorized || []) icons.set(feed.id, feed.iconUrl)
    return icons
  }, [navigation])
  const visibleFolders = useMemo(() => (navigation?.folders || [])
    .filter(folder => !unreadOnly || folder.unread > 0)
    .map(folder => ({ ...folder, feeds: unreadOnly ? folder.feeds.filter(feed => feed.unread > 0) : folder.feeds })), [navigation, unreadOnly])
  const visibleUncategorized = useMemo(() => (navigation?.uncategorized || [])
    .filter(feed => !unreadOnly || feed.unread > 0), [navigation, unreadOnly])
  const sidebarFolders = useMemo(() => [
    ...visibleFolders.filter(folder => sidebarFolderRank(folder) === 0),
    null,
    ...visibleFolders.filter(folder => sidebarFolderRank(folder) > 0),
  ], [visibleFolders])
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const darkThemeActive = isDarkTheme(theme, systemDark)

  const notify = useCallback((message: string, action?: { label: string; run: () => void }) => {
    window.clearTimeout(toastTimer.current)
    setToast({ message, actionLabel: action?.label, action: action?.run })
    toastTimer.current = window.setTimeout(() => setToast(null), action ? 8000 : 2600)
  }, [])

  const copyArticleUrl = useCallback(async (entry: Entry) => {
    try {
      await navigator.clipboard.writeText(entry.url)
      notify('Article URL copied')
    } catch {
      notify('Could not copy the article URL. Use Copy link address on Original.')
    }
  }, [notify])

  useReadingProgress(selected, articleRef, view === 'reader' && mobilePane === 'article')
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update); window.addEventListener('offline', update)
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update) }
  }, [])
  useEffect(() => { const update = () => setFullMode(selected ? fullTextMode(selected.feedId) : 'auto'); update(); window.addEventListener('paper-preferences', update); return () => window.removeEventListener('paper-preferences', update) }, [selected?.feedId])
  const loadStatus = useCallback(async () => {
    const next = await api.status()
    setStatus(next); if (!next.discussionConfigured) setDiscussionTarget(null); setLastSync(next.sync?.lastCompletedAt || null); setSyncError(next.sync?.lastError || '')
  }, [])

  const loadNavigation = useCallback(async () => {
    const payload = await api.navigation()
    const result = { ...payload, folders: [...payload.folders].sort((a, b) => sidebarFolderRank(a) - sidebarFolderRank(b)) }
    setNavigation(result)
    return result
  }, [])

  const loadEntries = useCallback(async (target = stream, select: 'keep' | 'first' | 'last' = 'keep', background: boolean | 'replace-in-place' = false) => {
    const serial = ++requestSerial.current
    const scope = JSON.stringify([libraryMode, query ? searchStream : target, query ? searchUnread : unreadOnly && target.kind !== 'starred', query, query ? dates : {}])
    setLoadingMore(false)
    if (!background) setLoading(true)
    try {
      setListError('')
      if (libraryMode !== 'stream') {
        const items = libraryMode === 'recent' ? await api.recentReading() : await offlineArticles()
        if (serial !== requestSerial.current) return
        setEntries(items); setContinuation(''); return
      }
      const result = await api.entries(query ? searchStream : target, query ? searchUnread : unreadOnly && target.kind !== 'starred', query, '', undefined, query ? dates : {})
      // A bulk action must not collapse a paginated list back to page one.
      const loadedCount = storyRowRefs.current.size
      const seenPages = new Set<string>()
      while (background === 'replace-in-place' && result.continuation && result.items.length < loadedCount) {
        if (serial !== requestSerial.current || seenPages.has(result.continuation)) break
        seenPages.add(result.continuation)
        const page = await api.entries(query ? searchStream : target, query ? searchUnread : unreadOnly && target.kind !== 'starred', query, result.continuation, undefined, query ? dates : {})
        result.items.push(...page.items)
        result.continuation = page.continuation
      }
      if (serial !== requestSerial.current) return
      const scopeChanged = loadedEntriesScope.current !== scope
      loadedEntriesScope.current = scope
      const orderChanged = Boolean(result.order && result.order !== entryOrderRef.current)
      setEntryOrder(result.order || 'newest')
      if (background === 'replace-in-place' && listRef.current) {
        const list = listRef.current
        const top = list.getBoundingClientRect().top
        pendingListScroll.current = { top: list.scrollTop, anchors: [...list.querySelectorAll<HTMLElement>('.story-row')]
          .filter(node => node.getBoundingClientRect().bottom > top)
          .map(node => ({ node, top: node.getBoundingClientRect().top })) }
      }
      setEntries(current => {
        if (scopeChanged) return result.items
        if (background === 'replace-in-place') {
          const next = result.items.map(item => item.id === selectedIdRef.current && current.find(old => old.id === item.id)?.fullText ? { ...item, ...articleContent(current.find(old => old.id === item.id)!) } : item)
          const selectedIndex = current.findIndex(item => item.id === selectedIdRef.current)
          const selectedEntry = current[selectedIndex]
          if (selectedEntry && !next.some(item => item.id === selectedEntry.id)) {
            // Keep an open read article in its existing relative position. The
            // missing-entry effect would otherwise fetch and prepend it.
            const nextSurvivor = current.slice(selectedIndex + 1).find(item => next.some(incoming => incoming.id === item.id))
            const index = nextSurvivor ? next.findIndex(item => item.id === nextSurvivor.id) : next.length
            next.splice(index, 0, selectedEntry)
          }
          return next
        }
        if (background !== true || orderChanged) return result.items
        const incoming = new Map(result.items.map(item => [item.id, item]))
        const known = new Set(current.map(item => item.id))
        const arrived = result.items.filter(item => !known.has(item.id))
        const retained = current.map(item => { const fresh = incoming.get(item.id); return fresh && item.fullText ? { ...fresh, contentHtml: item.contentHtml, excerpt: item.excerpt, readingMinutes: item.readingMinutes, fullText: true } : fresh || item })
        const merged = [...arrived, ...retained]
        return query ? merged : merged.sort((a, b) => (result.order === 'oldest' ? 1 : -1) * (a.timestamp - b.timestamp || (a.crawledAt || 0) - (b.crawledAt || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)))
      })
      setContinuation(result.continuation)
      setSelectedId(current => {
        if (select === 'first') return result.items[0]?.id || ''
        if (select === 'last') return result.items.at(-1)?.id || ''
        return current
      })
    } catch (error) {
      if (serial === requestSerial.current) setListError(error instanceof Error ? error.message : 'Paper could not load this stream')
    } finally {
      if (serial === requestSerial.current) setLoading(false)
    }
  }, [stream, unreadOnly, query, notify, searchStream, searchUnread, dates, libraryMode])

  const changeEntryOrder = async (order: 'newest' | 'oldest') => {
    if (savingOrder || order === entryOrder) return
    setSavingOrder(true)
    const serial = requestSerial.current
    try {
      await api.setStreamOrder(stream, order)
      if (serial === requestSerial.current) {
        setEntryOrder(order)
        // Start at the new end of the stream rather than pinning an article
        // from a distant page ahead of the newly ordered results.
        setSelectedId('')
        setMobilePane('stories')
        pushLocation({ selectedId: '', mobilePane: 'stories' })
        await loadEntries(stream)
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Paper could not save the article order')
    } finally { setSavingOrder(false) }
  }

  useLayoutEffect(() => {
    const snapshot = pendingListScroll.current
    pendingListScroll.current = null
    const list = listRef.current
    if (!snapshot || !list) return
    const anchor = snapshot.anchors.find(item => list.contains(item.node))
    if (anchor) list.scrollTop += anchor.node.getBoundingClientRect().top - anchor.top
    else list.scrollTop = snapshot.top
  }, [entries])

  const reloadFilteredLibrary = useCallback(async () => {
    const result = await loadNavigation()
    await loadEntries(stream, 'keep')
    setTopicsRefreshKey(current => current + 1)
    return result
  }, [loadEntries, loadNavigation, stream])

  const loadMore = useCallback(async (): Promise<Entry[]> => {
    if (!continuation || loadingMore) return []
    const serial = requestSerial.current
    setLoadingMore(true)
    try {
      const result = await api.entries(query ? searchStream : stream, streamUnreadOnly, query, continuation, undefined, query ? dates : {})
      if (serial !== requestSerial.current) return []
      const knownBeforeRequest = new Set(entries.map(entry => entry.id))
      const added = result.items.filter(entry => !knownBeforeRequest.has(entry.id))
      setEntries(current => {
        const known = new Set(current.map(entry => entry.id))
        return [...current, ...result.items.filter(entry => !known.has(entry.id))]
      })
      setContinuation(result.continuation)
      return added
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Paper could not load more articles')
      return []
    } finally {
      if (serial === requestSerial.current) setLoadingMore(false)
    }
  }, [continuation, entries, loadingMore, notify, query, stream, streamUnreadOnly, searchStream, dates, libraryMode, online])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await api.sync()
      await Promise.all([loadNavigation(), loadEntries(), loadStatus()])
      notify('Reader refreshed')
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Paper could not refresh the reader')
    } finally {
      setRefreshing(false)
    }
  }, [loadEntries, loadNavigation, notify, loadStatus])

  const beginPull = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const list = listRef.current
    pullEligible.current = Boolean(window.matchMedia('(max-width: 1040px)').matches && list && list.scrollTop <= 0 && !refreshing && event.touches.length === 1)
    pullStartY.current = event.touches[0]?.clientY || 0
    pullStartX.current = event.touches[0]?.clientX || 0
  }, [refreshing])

  const continuePull = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    if (!pullEligible.current) return
    const touch = event.touches[0]
    const y = (touch?.clientY || 0) - pullStartY.current
    const x = (touch?.clientX || 0) - pullStartX.current
    if (Math.abs(y) < Math.abs(x) * 1.2) return
    const distance = resistedPullDistance(y)
    if (distance > 0) event.preventDefault()
    setPullDistance(distance)
  }, [])

  const releasePull = useCallback(() => {
    const shouldRefresh = pullEligible.current && shouldReleaseToRefresh(pullDistance)
    pullEligible.current = false
    setPullDistance(0)
    if (shouldRefresh) void refresh()
  }, [pullDistance, refresh])

  const beginSourcePull = useCallback((event: React.TouchEvent<HTMLElement>) => {
    const list = sourceListRef.current
    sourcePullEligible.current = Boolean(window.matchMedia('(max-width: 1040px)').matches && list && list.scrollTop <= 0 && !refreshing && event.touches.length === 1)
    sourcePullStartY.current = event.touches[0]?.clientY || 0
  }, [refreshing])

  const continueSourcePull = useCallback((event: React.TouchEvent<HTMLElement>) => {
    if (!sourcePullEligible.current) return
    const distance = resistedPullDistance((event.touches[0]?.clientY || 0) - sourcePullStartY.current)
    if (distance > 0) event.preventDefault()
    setSourcePullDistance(distance)
  }, [])

  const releaseSourcePull = useCallback(() => {
    const shouldRefresh = sourcePullEligible.current && shouldReleaseToRefresh(sourcePullDistance)
    sourcePullEligible.current = false
    setSourcePullDistance(0)
    if (shouldRefresh) void refresh()
  }, [sourcePullDistance, refresh])

  const revealReaderChrome = useCallback(() => {
    const top = articleRef.current?.querySelector<HTMLElement>('.article-scroll')?.scrollTop || 0
    readerChromeScroll.current = initialReaderChromeScrollState(top)
    setReaderChromeHidden(false)
  }, [])

  const handleArticleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    if (!window.matchMedia('(max-width: 1040px)').matches || view !== 'reader' || mobilePane !== 'article') return
    const scroll = event.currentTarget
    const edge = articleEdgeState(scroll.scrollTop, scroll.scrollHeight, scroll.clientHeight, ARTICLE_BOUNDARY_ZONE_SIZE, ARTICLE_BOUNDARY_DISTANCE)
    const available = edge?.direction === 'previous' ? previousArticleAvailable : edge?.direction === 'next' ? nextArticleAvailable : false
    const boundary = edge ? { direction: edge.direction, progress: edge.progress, ready: edge.ready && available } : null
    articleBoundaryGesture.current = boundary
      ? { direction: boundary.direction, travel: edge!.distance, ready: boundary.ready }
      : { direction: null, travel: 0, ready: false }
    if (boundary?.ready && !articleBoundaryHaptic.current) {
      articleBoundaryHaptic.current = true
      navigator.vibrate?.(12)
    } else if (!boundary?.ready) articleBoundaryHaptic.current = false
    articleBoundaryStore.set(boundary)

    const logicalTop = Math.max(0, scroll.scrollTop - ARTICLE_BOUNDARY_ZONE_SIZE)
    if (!readerChromeCanAutoHide(scroll.scrollHeight, scroll.clientHeight, ARTICLE_BOUNDARY_ZONE_SIZE)) {
      readerChromeScroll.current = initialReaderChromeScrollState(logicalTop)
      setReaderChromeHidden(false)
      return
    }
    const next = updateReaderChromeScroll(readerChromeScroll.current, logicalTop)
    readerChromeScroll.current = next
    setReaderChromeHidden(current => current === next.hidden ? current : next.hidden)
  }, [articleBoundaryStore, mobilePane, nextArticleAvailable, previousArticleAvailable, view])

  const beginReaderChromeTap = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!readerChromeHidden) return
    readerChromeTap.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId }
  }, [readerChromeHidden])

  const moveReaderChromeTap = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const start = readerChromeTap.current
    if (!start || start.pointerId !== event.pointerId) return
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) readerChromeTap.current = null
  }, [])

  const finishReaderChromeTap = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const start = readerChromeTap.current
    readerChromeTap.current = null
    if (start?.pointerId === event.pointerId) revealReaderChrome()
  }, [revealReaderChrome])

  useEffect(() => {
    Promise.all([loadNavigation(), loadStatus()]).catch(error => setSyncError(error.message))
  }, [loadNavigation, loadStatus])

  useEffect(() => {
    const events = new EventSource('/api/events')
    const synced = () => {
      void loadNavigation().catch(error => setSyncError(error.message))
      void loadStatus().catch(error => setSyncError(error.message))
      if (view === 'reader') void loadEntries(stream, 'keep', true)
      setTopicsRefreshKey(current => current + 1)
    }
    const stateChanged = (event: MessageEvent) => {
      const change = JSON.parse(event.data) as { ids: string[]; operation: 'read' | 'unread' | 'star' | 'unstar' } | null
      if (!change) { synced(); return }
      const ids = new Set(change.ids)
      const patch = change.operation === 'read' ? { read: true } : change.operation === 'unread' ? { read: false } : change.operation === 'star' ? { starred: true } : { starred: false }
      setEntries(current => current.map(entry => ids.has(entry.id) ? { ...entry, ...patch } : entry))
      void loadNavigation().catch(error => setSyncError(error.message))
      setTopicsRefreshKey(value => value + 1)
    }
    const pulseUpdated = () => setTopicsRefreshKey(current => current + 1)
    events.addEventListener('pulse', pulseUpdated)
    events.addEventListener('sync', synced)
    events.addEventListener('connections', synced)
    events.addEventListener('state', stateChanged as EventListener)
    return () => {
      events.removeEventListener('pulse', pulseUpdated)
      events.removeEventListener('sync', synced)
      events.removeEventListener('connections', synced)
      events.removeEventListener('state', stateChanged as EventListener)
      events.close()
    }
  }, [loadEntries, loadNavigation, loadStatus, stream, view])

  useEffect(() => {
    if (preparedStreamLoad.current === stream) {
      preparedStreamLoad.current = null
      return
    }
    const timer = window.setTimeout(() => void loadEntries(stream), query ? 260 : 0)
    return () => window.clearTimeout(timer)
  }, [stream, unreadOnly, query, loadEntries])

  useEffect(() => {
    if (libraryMode === 'offline' || !online || !selectedId || entries.some(entry => entry.id === selectedId)) return
    let cancelled = false
    api.entry(selectedId).then(result => {
      if (!cancelled && result.entry) setEntries(current => current.some(entry => entry.id === result.entry!.id) ? current : [result.entry!, ...current])
    }).catch(error => !cancelled && notify(error instanceof Error ? error.message : 'Paper could not open that article'))
    return () => { cancelled = true }
  }, [entries, notify, selectedId, libraryMode, online])

  useEffect(() => {
    const marker = loadMoreRef.current
    const root = listRef.current
    if (!marker || !root || !continuation) return
    const observer = new IntersectionObserver(records => {
      if (records.some(record => record.isIntersecting)) void loadMore()
    }, { root, rootMargin: '240px' })
    observer.observe(marker)
    return () => observer.disconnect()
  }, [continuation, loadMore])

  useEffect(() => {
    const location: ReaderLocation = { view, stream, selectedId, unreadOnly, query, mobilePane, searchStream, searchUnread, after, before, library: libraryMode, collection: view === 'pulse' ? linkedCollection : pulseContext?.id }
    history.replaceState(location, '', readerLocationUrl(location))
  }, [mobilePane, query, selectedId, stream, unreadOnly, view, searchStream, searchUnread, after, before, libraryMode, pulseContext, linkedCollection])

  useEffect(() => {
    const onPopState = () => {
      const location = readReaderLocation()
      setView(location.view)
      setLinkedCollection(location.view === 'pulse' ? location.collection : undefined)
      setLibraryMode(location.library || 'stream')
      setPulseContext(savedPulseContext(location.collection))
      setStream(location.stream)
      setSelectedId(location.selectedId)
      setUnreadOnly(location.unreadOnly)
      setQuery(location.query)
      setSearchStream(location.searchStream || allStream); setSearchUnread(location.searchUnread || false); setAfter(location.after || ''); setBefore(location.before || '')
      setMobilePane(location.mobilePane)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('paper-theme', theme)
  }, [theme])

  useEffect(() => {
    document.documentElement.dataset.readerFont = readerFont
    localStorage.setItem('paper-reader-font', readerFont)
  }, [readerFont])

  useEffect(() => {
    document.documentElement.dataset.readerSize = readerSize
    document.documentElement.dataset.readerSpacing = readerSpacing
    document.documentElement.dataset.readerWidth = readerWidth
    localStorage.setItem('paper-reader-size', readerSize)
    localStorage.setItem('paper-reader-spacing', readerSpacing)
    localStorage.setItem('paper-reader-width', readerWidth)
  }, [readerSize, readerSpacing, readerWidth])

  useEffect(() => {
    revealReaderChrome()
    articleBoundaryGesture.current = { direction: null, travel: 0, ready: false }
    articleBoundaryStore.set(null)
  }, [articleBoundaryStore, mobilePane, revealReaderChrome, selectedId, view])

  useLayoutEffect(() => () => articleNavigation.cancel(), [articleNavigation, stream.id, stream.kind, selectedId, unreadOnly, query, mobilePane, view])

  useEffect(() => {
    const mobile = window.matchMedia('(max-width: 1040px)')
    const onChange = () => {
      setMobileLayout(mobile.matches)
      if (!mobile.matches) revealReaderChrome()
    }
    onChange()
    mobile.addEventListener('change', onChange)
    return () => mobile.removeEventListener('change', onChange)
  }, [revealReaderChrome])

  const pushLocation = useCallback((next: Partial<ReaderLocation>) => {
    const location: ReaderLocation = { view, stream, selectedId, unreadOnly, query, mobilePane, searchStream, searchUnread, after, before, library: libraryMode, collection: view === 'pulse' ? linkedCollection : pulseContext?.id, ...next }
    history.pushState(location, '', readerLocationUrl(location))
  }, [mobilePane, query, selectedId, stream, unreadOnly, view, searchStream, searchUnread, after, before, libraryMode, pulseContext, linkedCollection])

  const openStream = useCallback((target: StreamRef) => {
    setLibraryMode('stream'); setPulseContext(null)
    setFeedContext(null)
    setFolderContext(null)
    pushLocation({ view: 'reader', stream: target, selectedId: '', query: '', mobilePane: 'stories', library: 'stream', collection: undefined })
    setView('reader')
    setStream(target)
    setSelectedId('')
    setQuery('')
    setMobilePane('stories')
    requestAnimationFrame(() => listRef.current?.focus())
  }, [pushLocation])

  const openLibrary = useCallback((mode: 'recent' | 'offline') => {
    setLibraryMode(mode)
    setPulseContext(null)
    setFeedContext(null)
    setFolderContext(null)
    setEntryContext(null)
    pushLocation({ view: 'reader', stream: allStream, library: mode, selectedId: '', query: '', mobilePane: 'stories', collection: undefined })
    setView('reader')
    setStream(allStream)
    setSelectedId('')
    setQuery('')
    setMobilePane('stories')
    requestAnimationFrame(() => listRef.current?.focus())
  }, [pushLocation])

  const openFeedContext = useCallback((feed: Feed, left: number, top: number) => {
    setFolderContext(null)
    setEntryContext(null)
    setFeedContext({
      feed,
      left: Math.max(8, Math.min(left, window.innerWidth - 224)),
      top: Math.max(8, Math.min(top, window.innerHeight - 224)),
    })
  }, [])

  const openFolderContext = useCallback((folder: Folder, left: number, top: number) => {
    setFeedContext(null)
    setEntryContext(null)
    setFolderContext({
      folder,
      left: Math.max(8, Math.min(left, window.innerWidth - 224)),
      top: Math.max(8, Math.min(top, window.innerHeight - 142)),
    })
  }, [])

  const openEntryContext = useCallback((entry: Entry, left: number, top: number) => {
    setFeedContext(null)
    setFolderContext(null)
    setEntryContext({
      entry,
      left: Math.max(8, Math.min(left, window.innerWidth - 224)),
      top: Math.max(8, Math.min(top, window.innerHeight - 362)),
    })
  }, [])

  const switchFolder = useCallback((direction: 1 | -1) => {
    if (stream.kind !== 'category' || !navigation) return
    const folders = navigation.folders.filter(folder => !unreadOnly || folder.unread > 0)
    const currentIndex = folders.findIndex(folder => folder.id === stream.id)
    const folder = folders[currentIndex + direction]
    if (!folder) return
    navigator.vibrate?.(8)
    openStream({ kind: 'category', id: folder.id, title: folder.title })
  }, [navigation, openStream, stream, unreadOnly])

  const beginStoryGesture = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0]
    if (!touch || event.touches.length !== 1) return
    if (stream.kind === 'category') {
      pullEligible.current = false
      setPullDistance(0)
    } else beginPull(event)
    const point = { x: touch.clientX, y: touch.clientY }
    const list = event.currentTarget
    storyGestureStart.current = {
      ...point,
      atTop: list.scrollTop <= 2,
      atBottom: !continuation && !loadingMore && list.scrollHeight - list.clientHeight - list.scrollTop <= 2,
    }
    storyGestureLast.current = point
  }, [beginPull, continuation, loadingMore, stream.kind])

  const continueStoryGesture = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    if (stream.kind !== 'category') continuePull(event)
    const touch = event.touches[0]
    if (touch) storyGestureLast.current = { x: touch.clientX, y: touch.clientY }
  }, [continuePull, stream.kind])

  const releaseStoryGesture = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const start = storyGestureStart.current
    const changed = event.changedTouches[0]
    const end = changed ? { x: changed.clientX, y: changed.clientY } : storyGestureLast.current
    storyGestureStart.current = null
    storyGestureLast.current = null
    releasePull()
    if (!start || !end) return
    const swipe = swipeDirection(start, end)
    if (swipe === 'left') switchFolder(1)
    if (swipe === 'right') switchFolder(-1)
    if (stream.kind === 'category' && swipe === 'up' && start.atBottom) switchFolder(1)
    if (stream.kind === 'category' && swipe === 'down' && start.atTop) switchFolder(-1)
  }, [releasePull, stream.kind, switchFolder])

  const manageFeed = useCallback((feed: Feed) => {
    setFeedContext(null)
    setSettingsFeedId(feed.id)
    setSettingsSection('feeds')
    setOverlays({ ...closedOverlays, settings: true })
  }, [])

  const unsubscribeFeed = useCallback(async (feed: Pick<Feed, 'id' | 'title'>) => {
    setFeedContext(null)
    setEntryContext(null)
    try {
      await api.removeFeed(feed.id)
      const reader = currentReader.current
      if (reader.stream.kind === 'feed' && reader.stream.id === feed.id) openStream(allStream)
      else if (reader.selected?.feedId === feed.id) {
        setSelectedId('')
        setMobilePane('stories')
        pushLocation({ selectedId: '', mobilePane: 'stories' })
      }
      setEntries(current => current.filter(entry => entry.feedId !== feed.id))
      await loadNavigation()
      notify(`${feed.title} unsubscribed`)
    } catch (error) {
      notify(error instanceof Error ? error.message : 'FreshRSS could not remove this feed')
    }
  }, [loadNavigation, notify, openStream, pushLocation])

  const openBriefings = useCallback(() => {
    pushLocation({ view: 'briefings', selectedId: '', query: '', mobilePane: 'stories' })
    setView('briefings')
    setSelectedId('')
    setQuery('')
    setMobilePane('stories')
  }, [pushLocation])

  const openTopics = useCallback(() => {
    pushLocation({ view: 'pulse', selectedId: '', query: '', mobilePane: 'stories' })
    setView('pulse')
    setSelectedId('')
    setQuery('')
    setMobilePane('stories')
  }, [pushLocation])

  const openSources = useCallback(() => {
    setPulseContext(null)
    pushLocation({ view: 'reader', selectedId: '', query: '', mobilePane: 'sources' })
    setView('reader')
    setSelectedId('')
    setQuery('')
    setMobilePane('sources')
    requestAnimationFrame(() => sourceListRef.current?.focus())
  }, [pushLocation])

  const openEntry = useCallback((entry: Entry) => {
    pushLocation({ selectedId: entry.id, mobilePane: 'article' })
    setSelectedId(entry.id)
    setMobilePane('article')
    requestAnimationFrame(() => articleRef.current?.focus())
  }, [pushLocation])

  const openTopicEntry = useCallback(async (id: string, context?: { id: string; title: string; ids: string[] }) => {
    try {
      const result = await api.entry(id)
      if (!result.entry) throw new Error('Paper could not find this article')
      const entry = result.entry
      setLibraryMode('stream'); setPulseContext(context || null); setLinkedCollection(context?.id)
      if (context) sessionStorage.setItem(`paper-collection:${context.id}`, JSON.stringify(context))
      setEntries(current => current.some(item => item.id === entry.id) ? current.map(item => item.id === entry.id ? entry : item) : [entry, ...current])
      pushLocation({ view: 'reader', stream: allStream, selectedId: entry.id, unreadOnly: false, query: '', mobilePane: 'article', library: 'stream', collection: context?.id })
      setView('reader')
      setStream(allStream)
      setUnreadOnly(false)
      setQuery('')
      setSelectedId(entry.id)
      setMobilePane('article')
      requestAnimationFrame(() => articleRef.current?.focus())
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Paper could not open this article')
    }
  }, [notify, pushLocation])

  const closeEntry = useCallback(() => {
    if (pulseContext) { openTopics(); return }
    const closingId = selectedId
    pushLocation({ selectedId: '', mobilePane: 'stories' })
    setSelectedId('')
    setMobilePane('stories')
    requestAnimationFrame(() => {
      listRef.current?.focus()
      if (window.matchMedia('(max-width: 1040px)').matches) storyRowRefs.current.get(closingId)?.scrollIntoView({ block: 'start' })
    })
  }, [pushLocation, selectedId, pulseContext, openTopics])

  const changeMobilePane = useCallback((pane: MobilePane) => {
    pushLocation({ mobilePane: pane })
    setMobilePane(pane)
  }, [pushLocation])

  const changeUnreadOnly = useCallback((value: boolean) => {
    pushLocation({ unreadOnly: value, selectedId: '' })
    setUnreadOnly(value)
    setSelectedId('')
  }, [pushLocation])

  useLayoutEffect(() => {
    if (!selectedId || loading) return
    storyRowRefs.current.get(selectedId)?.scrollIntoView({ block: 'center', inline: 'nearest' })
    if (atStreamEnd) loadMoreRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    else if (atStreamStart) streamStartRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [selectedId, loading, atStreamEnd, atStreamStart])

  useEffect(() => {
    manuallyUnreadId.current = ''
  }, [selectedId])

  const updateEntry = useCallback((id: string, patch: Partial<Entry>) => {
    setEntries(current => current.map(entry => entry.id === id ? { ...entry, ...patch } : entry))
  }, [])

  const setEntryState = useCallback(async (entry: Entry, operation: 'read' | 'unread' | 'star' | 'unstar', quiet = false, origin: 'reader' | 'pulse' | 'automatic' = 'reader') => {
    if (!online) { notify('Connect to change reading state.'); return }
    if (operation === 'unread') manuallyUnreadId.current = entry.id
    else if (operation === 'read' && manuallyUnreadId.current === entry.id) manuallyUnreadId.current = ''
    const patch = operation === 'read' ? { read: true }
      : operation === 'unread' ? { read: false }
      : operation === 'star' ? { starred: true }
      : { starred: false }
    setActionError(null)
    updateEntry(entry.id, patch)
    try {
      await api.editState([entry.id], operation, origin)
    } catch (error) {
      if (origin === 'automatic') manuallyUnreadId.current = entry.id
      setActionError({ id: entry.id, message: error instanceof Error ? error.message : 'FreshRSS rejected the change', operation })
      updateEntry(entry.id, operation === 'read' ? { read: false } : operation === 'unread' ? { read: true } : operation === 'star' ? { starred: false } : { starred: true })
      notify(error instanceof Error ? error.message : 'FreshRSS rejected the change')
      return
    }
    if (!quiet) {
      const inverse = operation === 'read' ? 'unread' : operation === 'unread' ? 'read' : operation === 'star' ? 'unstar' : 'star'
      notify(operation === 'star' ? 'Starred' : operation === 'unstar' ? 'Star removed' : operation === 'read' ? 'Marked read' : 'Marked unread', {
        label: 'Undo',
        run: () => void setEntryState({ ...entry, ...patch }, inverse, true, origin),
      })
    }
    void loadNavigation().catch(() => notify('The change was saved. Counts will refresh shortly.'))
  }, [loadNavigation, notify, updateEntry, online])

  const markTopicRead = useCallback(async (ids: string[]): Promise<boolean> => {
    if (!ids.length) return true
    const idSet = new Set(ids)
    try {
      await api.editState(ids, 'read', 'pulse')
      setEntries(current => current.map(entry => idSet.has(entry.id) ? { ...entry, read: true } : entry))
      setTopicsRefreshKey(current => current + 1)
      void loadNavigation().catch(() => notify('The articles were marked read. Counts will refresh shortly.'))
      notify(`${ids.length} ${ids.length === 1 ? 'article' : 'articles'} marked read`, {
        label: 'Undo',
        run: () => void (async () => {
          try {
            await api.editState(ids, 'unread', 'pulse')
            setEntries(current => current.map(entry => idSet.has(entry.id) ? { ...entry, read: false } : entry))
            setTopicsRefreshKey(current => current + 1)
            await loadNavigation()
          } catch (error) {
            notify(error instanceof Error ? error.message : 'Paper could not restore the articles')
          }
        })(),
      })
      return true
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Paper could not mark this coverage read')
      return false
    }
  }, [loadNavigation, notify])

  const fetchFullText = useCallback(async (target: Entry | null = selected, quiet = false, force = false) => {
    if (!target?.url || target.kind !== 'article' || (target.fullText && !force) || fetchingFullTextId) return
    setFetchingFullTextId(target.id)
    setFullTextError(null)
    try {
      if (!target.fullText) feedVersions.current.set(target.id, target)
      const article = await api.fullText(target.url, force)
      const full = { ...target,
        contentHtml: article.contentHtml,
        excerpt: article.excerpt || target.excerpt,
        readingMinutes: article.readingMinutes,
        author: target.author || article.byline,
        fullText: true,
      }
      fullVersions.current.set(target.id, full)
      updateEntry(target.id, articleContent(full))
      if (!quiet) {
        const preference = recordFullTextSuccess(localStorage, target.feedId, target.id)
        if (preference.enabled) setAutomaticFullFeeds(current => new Set(current).add(target.feedId))
        notify(preference.becameEnabled
          ? `Future ${target.feedTitle} articles will load in full automatically`
          : article.cached ? 'Full article loaded from cache' : 'Full article loaded')
      }

    } catch (error) {
      setFullTextError({ id: target.id, message: error instanceof Error ? error.message : 'Paper could not fetch the full article' })
    } finally {
      setFetchingFullTextId('')
    }
  }, [fetchingFullTextId, notify, selected, updateEntry])

  useEffect(() => {
    if (!online || !selected || selected.fullText || selected.kind !== 'article' || mobilePane !== 'article' || fullMode === 'never' || (fullMode !== 'always' && !shouldAutomaticallyFetchFullArticle(selected, automaticFullFeeds.has(selected.feedId))) || automaticFullTextAttempts.current.has(selected.id)) return
    const timer = window.setTimeout(() => { automaticFullTextAttempts.current.add(selected.id); void fetchFullText(selected, true) }, 120)
    return () => window.clearTimeout(timer)
  }, [automaticFullFeeds, fetchFullText, mobilePane, selected, fullMode, online])

  useEffect(() => {
    if (!online || !autoRead || !selected || !shouldAutoMarkRead(selected, mobilePane, manuallyUnreadId.current)) return
    let timer: number | undefined
    const schedule = () => {
      window.clearTimeout(timer)
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        timer = window.setTimeout(() => void setEntryState(selected, 'read', true, 'automatic'), 1000)
      }
    }
    const cancel = () => window.clearTimeout(timer)
    schedule()
    document.addEventListener('visibilitychange', schedule)
    window.addEventListener('focus', schedule)
    window.addEventListener('blur', cancel)
    return () => {
      cancel()
      document.removeEventListener('visibilitychange', schedule)
      window.removeEventListener('focus', schedule)
      window.removeEventListener('blur', cancel)
    }
  }, [selected, mobilePane, setEntryState, autoRead, online])

  const move = useCallback((direction: 1 | -1, animate = false): Promise<boolean> => articleNavigation.run(async signal => {
    if (pulseContext && selected) {
      const index = pulseContext.ids.indexOf(selected.id)
      const id = pulseContext.ids[index + direction]
      if (!id) return null
      const result = await api.entry(id)
      if (signal.aborted || !result.entry) return null
      return () => { setEntries(current => current.some(item => item.id === id) ? current : [...current, result.entry!]); openEntry(result.entry!) }
    }
    if (loading) return null
    const commitEntry = (entry: Entry) => {
      articleBoundaryStore.set(null)
      setArticleTransition(animate ? direction > 0 ? 'next-in' : 'previous-in' : '')
      openEntry(entry)
    }
    const currentIndex = selected ? entries.findIndex(entry => entry.id === selected.id) : direction > 0 ? -1 : entries.length
    const next = entries[currentIndex + direction]
    if (next) return () => commitEntry(next)

    // Fetch without changing the current list. The navigation controller only
    // commits a result if the user is still here and the request has not expired.
    let cursor = direction > 0 ? continuation : ''
    const seen = new Set<string>()
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor)
      const result = await api.entries(query ? searchStream : stream, streamUnreadOnly, query, cursor, signal, query ? dates : {})
      if (signal.aborted) return null
      const known = new Set(entries.map(entry => entry.id))
      const more = result.items.filter(entry => !known.has(entry.id))
      if (more[0]) return () => {
        setEntries(current => {
          const currentIds = new Set(current.map(entry => entry.id))
          return [...current, ...more.filter(entry => !currentIds.has(entry.id))]
        })
        setContinuation(result.continuation)
        commitEntry(more[0])
      }
      cursor = result.continuation
    }
    if (libraryMode !== 'stream' || query || stream.kind !== 'category' || !navigation) return null
    const folderIndex = navigation.folders.findIndex(folder => folder.id === stream.id)
    if (folderIndex < 0) return null
    let candidateIndex = folderIndex + direction
    while (candidateIndex >= 0 && candidateIndex < navigation.folders.length) {
      const folder = navigation.folders[candidateIndex]
      if (!unreadOnly || folder.unread > 0) {
        const target = { kind: 'category' as const, id: folder.id, title: folder.title }
        const result = await api.entries(target, unreadOnly, '', '', signal)
        if (signal.aborted) return null
        if (result.items.length) return () => {
          const destination = direction > 0 ? result.items[0] : result.items.at(-1)!
          // Invalidate old list requests and avoid fetching this folder twice.
          requestSerial.current += 1
          preparedStreamLoad.current = target
          pushLocation({ stream: target, selectedId: destination.id, query: '', mobilePane: 'article' })
          setStream(target)
          setEntries(result.items)
          setEntryOrder(result.order || 'newest')
          setContinuation(result.continuation)
          setSelectedId(destination.id)
          setQuery('')
          setMobilePane('article')
          setLoading(false)
          setLoadingMore(false)
          articleBoundaryStore.set(null)
          setArticleTransition(animate ? direction > 0 ? 'next-in' : 'previous-in' : '')
          requestAnimationFrame(() => articleRef.current?.focus())
        }
      }
      candidateIndex += direction
    }
    return null
  }, setArticleNavigationBusy, error => notify(error instanceof Error ? error.message : 'Paper could not open the next article')),
  [articleBoundaryStore, articleNavigation, continuation, entries, navigation, notify, openEntry, pushLocation, query, selected, stream, unreadOnly, streamUnreadOnly, pulseContext, searchStream, dates, libraryMode, loading])

  const settleArticleBoundary = useCallback((direction: ArticleBoundaryDirection | null) => {
    const scroll = articleRef.current?.querySelector<HTMLElement>('.article-scroll')
    if (!scroll || !direction) return
    const maximum = Math.max(0, scroll.scrollHeight - scroll.clientHeight)
    const top = direction === 'previous'
      ? Math.min(ARTICLE_BOUNDARY_ZONE_SIZE, maximum / 2)
      : Math.max(Math.min(ARTICLE_BOUNDARY_ZONE_SIZE, maximum / 2), maximum - ARTICLE_BOUNDARY_ZONE_SIZE)
    scroll.scrollTo({ top, behavior: 'smooth' })
  }, [])

  const releaseArticleGesture = useCallback((cancelled = false) => {
    const boundary = articleBoundaryGesture.current
    articleBoundaryGesture.current = { direction: null, travel: 0, ready: false }
    articleBoundaryHaptic.current = false
    articleBoundaryStore.set(null)
    if (!cancelled && boundary.ready && boundary.direction) {
      settleArticleBoundary(boundary.direction)
      void move(boundary.direction === 'next' ? 1 : -1, true)
      return
    }
    settleArticleBoundary(boundary.direction)
  }, [articleBoundaryStore, move, settleArticleBoundary])

  const markAllRead = useCallback(async () => {
    if (libraryMode !== 'stream' || !online) { notify('Open a feed or search while connected to mark articles read.'); return }
    if (query) {
      try { const preview = await api.previewRead(searchStream, query, dates.after, dates.before); setBulkPreview({ ...preview, label: `Search results in ${searchStream.title}` }) }
      catch (error) { notify(error instanceof Error ? error.message : 'Could not preview this action') }
      return
    }
    try {
      const result = await api.markStreamRead(stream)
      if (streamUnreadOnly) {
        articleNavigation.cancel()
        requestSerial.current += 1
        setContinuation('')
        setLoadingMore(false)
        setLoading(false)
      }
      setEntries(current => streamUnreadOnly ? [] : current.map(entry => ({ ...entry, read: true })))
      setSelectedId('')
      await loadNavigation()
      if (result.count && result.undoToken) {
        notify(`Marked ${result.count} entries read`, { label: 'Undo', run: () => {
          void api.undo(result.undoToken!).then(async () => {
            await Promise.all([loadNavigation(), loadEntries(stream)])
            notify('Mark all read undone')
          }).catch(error => notify(error instanceof Error ? error.message : 'Paper could not undo that change'))
        } })
      } else notify('Nothing to mark read')
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Paper could not mark this stream read')
    }
  }, [stream, streamUnreadOnly, loadNavigation, loadEntries, notify, query, searchStream, dates, libraryMode, online, articleNavigation])

  const markFeedRead = useCallback(async (feed: Feed) => {
    const target: StreamRef = { kind: 'feed', id: feed.id, title: feed.title }
    setFeedContext(null)
    try {
      const result = await api.markStreamRead(target)
      if (stream.id === feed.id) {
        setEntries(current => unreadOnly ? [] : current.map(entry => ({ ...entry, read: true })))
        if (unreadOnly) setSelectedId('')
      }
      await loadNavigation()
      if (result.count && result.undoToken) {
        notify(`Marked ${result.count} ${feed.title} entries read`, { label: 'Undo', run: () => {
          void api.undo(result.undoToken!).then(async () => {
            await loadNavigation()
            if (stream.id === feed.id) await loadEntries(target)
            notify('Mark feed read undone')
          }).catch(error => notify(error instanceof Error ? error.message : 'Paper could not undo that change'))
        } })
      } else notify('Nothing to mark read')
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Paper could not mark this feed read')
    }
  }, [loadEntries, loadNavigation, notify, stream.id, unreadOnly])

  const markFolderRead = useCallback(async (folder: Folder) => {
    const target: StreamRef = { kind: 'category', id: folder.id, title: folder.title }
    setFolderContext(null)
    try {
      const result = await api.markStreamRead(target)
      if (stream.id === folder.id) {
        setEntries(current => unreadOnly ? [] : current.map(entry => ({ ...entry, read: true })))
        if (unreadOnly) setSelectedId('')
      }
      await loadNavigation()
      if (result.count && result.undoToken) {
        notify(`Marked ${result.count} ${folder.title} entries read`, { label: 'Undo', run: () => {
          void api.undo(result.undoToken!).then(async () => {
            await loadNavigation()
            if (stream.id === folder.id) await loadEntries(target)
            notify('Mark folder read undone')
          }).catch(error => notify(error instanceof Error ? error.message : 'Paper could not undo that change'))
        } })
      } else notify('Nothing to mark read')
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Paper could not mark this folder read')
    }
  }, [loadEntries, loadNavigation, notify, stream.id, unreadOnly])

  const markRelativeRead = useCallback(async (entry: Entry, direction: 'above' | 'below') => {
    setEntryContext(null)
    if (libraryMode !== 'stream' || !online) { notify('Open a feed or search while connected to use relative read actions.'); return }
    let serial = requestSerial.current
    try {
      const result = await api.markRelativeRead(query ? searchStream : stream, entry.id, direction, streamUnreadOnly, query, entryOrder, query ? dates : { after: '', before: '' })
      const changed = new Set(result.ids)
      setEntries(current => current.map(item => changed.has(item.id) ? { ...item, read: true } : item))
      // Keep the list mounted, including on no-op actions, instead of replacing
      // it with skeleton rows and resetting its scroll position.
      if (result.count) {
        const stillHere = serial === requestSerial.current
        serial = stillHere ? serial + 1 : -1
        await Promise.all([loadNavigation(), stillHere ? loadEntries(stream, 'keep', 'replace-in-place') : Promise.resolve()])
      }
      if (result.count && result.undoToken) {
        notify(`Marked ${result.count} ${direction} read`, { label: 'Undo', run: () => {
          void api.undo(result.undoToken!).then(async () => {
            setEntries(current => current.map(item => changed.has(item.id) ? { ...item, read: false } : item))
            await Promise.all([loadNavigation(), serial === requestSerial.current ? loadEntries(stream, 'keep', 'replace-in-place') : Promise.resolve()])
            notify('Mark read undone')
          }).catch(error => notify(error instanceof Error ? error.message : 'Paper could not undo that change'))
        } })
      } else notify(`Nothing unread ${direction}`)
    } catch (error) {
      notify(error instanceof Error ? error.message : `Paper could not mark articles ${direction} read`)
    }
  }, [entryOrder, loadEntries, loadNavigation, notify, query, stream, streamUnreadOnly, searchStream, dates, libraryMode, online])

  const saveEntryReadwise = useCallback(async (entry: Entry) => {
    if (!status.readwiseConfigured) return notify('Enable Readwise Reader in Settings > Reading & connections')
    if (readwiseBusy || entry.readwiseSavedAt) return
    setReadwiseBusy(true)
    try {
      const result = await api.saveReadwise(entry.url, entry.title)
      updateEntry(entry.id, { readwiseSavedAt: result.savedAt })
      notify('Saved to Readwise Reader')
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Readwise could not save this article')
    } finally { setReadwiseBusy(false) }
  }, [status.readwiseConfigured, notify, readwiseBusy, updateEntry])

  const saveReadwise = useCallback(async () => {
    if (selected) await saveEntryReadwise(selected)
  }, [saveEntryReadwise, selected])

  const createKirbyNote = useCallback(async (quote: string) => {
    if (!selected) return
    if (!status.kirbyConfigured) return notify('Enable Kirby notes in Settings > Reading & connections')
    setSelectionContext(null)
    const editor = window.open('about:blank', '_blank')
    if (editor) editor.opener = null
    try {
      const result = await api.createKirbyNote(selected.title, selected.url, quote)
      if (editor) {
        editor.location.replace(result.result.panelUrl)
        notify('Kirby note draft created')
      } else {
        notify('Kirby note draft created', { label: 'Open Kirby', run: () => window.open(result.result.panelUrl, '_blank', 'noopener') })
      }
      window.getSelection()?.removeAllRanges()
    } catch (error) {
      editor?.close()
      notify(error instanceof Error ? error.message : 'Paper could not create the Kirby note')
    }
  }, [notify, selected, status.kirbyConfigured])

  const commands = useMemo(() => [
    { label: 'Refresh reader', hint: 'r', run: refresh },
    { label: unreadOnly ? 'Show all articles' : 'Show unread articles', hint: 'u', run: () => changeUnreadOnly(!unreadOnly) },
    { label: 'Mark this stream read', hint: 'Shift A', run: markAllRead },
    { label: 'Manage feeds', hint: '', run: () => { setSettingsSection('feeds'); setOverlays({ ...closedOverlays, settings: true }) } },
    { label: 'Manage filters', hint: '', run: () => { setSettingsSection('filters'); setOverlays({ ...closedOverlays, settings: true }) } },
    { label: 'Article reports', hint: '', run: () => { setSettingsSection('reports'); setOverlays({ ...closedOverlays, settings: true }) } },
    { label: 'Activity log', hint: '', run: () => { setSettingsSection('activity'); setOverlays({ ...closedOverlays, settings: true }) } },
    { label: 'Appearance', hint: 'Aa', run: () => setOverlays({ ...closedOverlays, appearance: true }) },
    { label: 'Settings', hint: ',', run: () => setOverlays({ ...closedOverlays, settings: true }) },
    { label: 'Keyboard shortcuts', hint: '?', run: () => setOverlays({ ...closedOverlays, help: true }) },
  ], [changeUnreadOnly, refresh, unreadOnly, markAllRead])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (discussionTarget || bulkPreview || reportEntry || selectionContext || feedContext || folderContext || entryContext) return
      const target = event.target as HTMLElement
      const typing = target.matches('input,textarea,select,[contenteditable="true"]')
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOverlays({ ...closedOverlays, command: true })
        return
      }
      if (typing || overlays.command || overlays.help || overlays.settings || overlays.appearance) return
      const key = event.key
      const direction = movementDirection(key)
      if (direction) {
        event.preventDefault()
        void move(direction)
      } else if (key === 'Enter' && selected) {
        event.preventDefault()
        openEntry(selected)
      } else if (key === 'o' && selected?.url) {
        window.open(selected.url, '_blank', 'noopener')
      } else if (key === 'b' && selected?.url) {
        const opened = window.open(selected.url, '_blank', 'noopener')
        opened?.blur()
        window.focus()
      } else if (key === 'q') {
        event.preventDefault()
        void saveReadwise()
      } else if (key === 'm' && selected) {
        void setEntryState(selected, selected.read ? 'unread' : 'read')
      } else if (key === 's' && selected) {
        void setEntryState(selected, selected.starred ? 'unstar' : 'star')
      } else if (key === 'A' && event.shiftKey) {
        event.preventDefault()
        void markAllRead()
      } else if (key === 'r') {
        event.preventDefault()
        void refresh()
      } else if (key === 'f' && selected?.kind === 'article') {
        event.preventDefault()
        void fetchFullText()
      } else if (key === 'Escape' || key === 'u') {
        closeEntry()
      } else if (key === '[') {
        setSidebarVisible(value => !value)
      } else if (key === ',') {
        setOverlays({ ...closedOverlays, settings: true })
      } else if (key === '?') {
        setOverlays({ ...closedOverlays, help: true })
      } else if (key === '/') {
        event.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeEntry, move, openEntry, overlays, selected, refresh, fetchFullText, markAllRead, saveReadwise, setEntryState, discussionTarget, bulkPreview, reportEntry, selectionContext, feedContext, folderContext, entryContext])

  const appClass = `app ${sidebarVisible ? '' : 'sidebar-hidden'} ${readerChromeHidden ? 'mobile-reader-chrome-hidden' : ''}`
  return (
    <div
      className={`${appClass}${discussionTarget ? ' discussion-open' : ''}`}
      data-mobile-pane={mobilePane}
      data-view={view}
      onPointerDownCapture={beginReaderChromeTap}
      onPointerMoveCapture={moveReaderChromeTap}
      onPointerUpCapture={finishReaderChromeTap}
      onPointerCancelCapture={() => { readerChromeTap.current = null }}
      onFocusCapture={() => { if (readerChromeHidden) revealReaderChrome() }}
      onKeyDownCapture={() => { if (readerChromeHidden) revealReaderChrome() }}
    >
      <header className="topbar">
        <button className="wordmark" onClick={() => openStream(allStream)} aria-label="Open all articles">
          <img className="brand-logo brand-logo-dark" src="/brand/paper-logo.svg" alt="" />
          <img className="brand-logo brand-logo-light" src="/brand/paper-logo-light.svg" alt="" />
        </button>
        <label className="search-box">
          <Icon name="search" />
          <input ref={searchRef} value={query} onChange={event => { setView('reader'); setLibraryMode('stream'); setPulseContext(null); setSelectedId(''); setMobilePane('stories'); setQuery(event.target.value) }} aria-label="Search articles" placeholder="Search articles" />
          <kbd>/</kbd>
        </label>
        <button className="command-button" onClick={() => setOverlays({ ...closedOverlays, command: true })}><span>Commands</span><kbd>Ctrl K</kbd></button>
      </header>

      <aside className="sidebar panel">
        <div className="sidebar-heading">
          <span>Library</span>
          {mobileLayout && <div className="source-filter">
            <ArticleFilter unreadOnly={unreadOnly} onChange={changeUnreadOnly} />
          </div>}
          <button className="icon-button" onClick={() => { setSettingsFeedId(''); setSettingsSection('feeds'); setOverlays({ ...closedOverlays, settings: true }) }} aria-label="Manage feeds"><Icon name="plus" /></button>
        </div>
        <nav
          className={`source-nav ${sourcePullDistance > 0 ? 'pulling pull-active' : ''} ${refreshing ? 'pull-active' : ''}`}
          aria-label="Feed sources"
          ref={sourceListRef}
          tabIndex={0}
          onTouchStart={beginSourcePull}
          onTouchMove={continueSourcePull}
          onTouchEnd={releaseSourcePull}
          onTouchCancel={releaseSourcePull}
          style={{ '--pull-distance': `${sourcePullDistance || (refreshing ? 44 : 0)}px` } as React.CSSProperties}
        >
          <div className={`pull-refresh-indicator ${shouldReleaseToRefresh(sourcePullDistance) ? 'ready' : ''} ${refreshing ? 'refreshing' : ''}`}><Icon name="back" /><span>{refreshing ? 'Refreshing' : shouldReleaseToRefresh(sourcePullDistance) ? 'Release to refresh' : 'Pull to refresh'}</span></div>
          <div className="source-nav-content">
          <SourceButton active={view === 'reader' && libraryMode === 'stream' && !query && stream.kind === 'all'} icon="feed" label="All articles" count={navigation?.unread || 0} onClick={() => openStream(allStream)} />
          <SourceButton active={view === 'reader' && libraryMode === 'stream' && !query && stream.kind === 'starred'} icon="star" label="Starred" count={navigation?.starred || 0} onClick={() => openStream(starredStream)} />
          <SourceButton active={view === 'reader' && libraryMode === 'recent'} icon="reader" label="Continue reading" count={0} onClick={() => openLibrary('recent')} />
          <SourceButton active={view === 'reader' && libraryMode === 'offline'} icon="feed" label="Offline articles" count={0} onClick={() => openLibrary('offline')} />
          <SourceButton active={view === 'briefings'} icon="reader" label="Briefings" count={0} onClick={openBriefings} />
          <SourceButton active={view === 'pulse'} icon="topics" label="Pulse" count={0} onClick={openTopics} />
          <div className="nav-rule" />
          {mobileLayout && navigation && unreadOnly && navigation.unread === 0 && visibleFolders.length === 0 && visibleUncategorized.length === 0 && <div className="sources-empty">
            <p>All caught up</p>
            <button onClick={() => changeUnreadOnly(false)}>Show all feeds</button>
          </div>}
          {sidebarFolders.map(folder => {
            if (!folder) return visibleUncategorized.length > 0 && <div className="folder" key="__uncategorized__">
              <button className="folder-row" onClick={() => setExpandedFolders(current => {
                const next = new Set(current)
                if (next.has('__uncategorized__')) next.delete('__uncategorized__')
                else next.add('__uncategorized__')
                return next
              })}>
                <span className="folder-toggle"><Icon name="chevron" className={expandedFolders.has('__uncategorized__') ? 'rotated' : ''} /></span>
                <span className="source-label">Uncategorized</span>
                {visibleUncategorized.reduce((sum, feed) => sum + feed.unread, 0) > 0 && <span className="source-count">{visibleUncategorized.reduce((sum, feed) => sum + feed.unread, 0)}</span>}
              </button>
              {expandedFolders.has('__uncategorized__') && <div className="feed-list">
                {visibleUncategorized.map(feed => <FeedRowButton key={feed.id} feed={feed} active={!query && stream.id === feed.id} onOpen={() => openStream({ kind: 'feed', id: feed.id, title: feed.title })} onContext={(left, top) => openFeedContext(feed, left, top)} />)}
              </div>}
            </div>
            const expanded = expandedFolders.has(folder.id)
            return <div className="folder" key={folder.id}>
              <FolderRowButton
                folder={folder}
                active={!query && stream.id === folder.id}
                expanded={expanded}
                onOpen={() => openStream({ kind: 'category', id: folder.id, title: folder.title })}
                onToggle={event => {
                  event.stopPropagation()
                  setExpandedFolders(current => {
                    const next = new Set(current)
                    if (next.has(folder.id)) next.delete(folder.id)
                    else next.add(folder.id)
                    return next
                  })
                }}
                onContext={(left, top) => openFolderContext(folder, left, top)}
              />
              {expanded && <div className="feed-list">
                {folder.feeds.map(feed => <FeedRowButton key={feed.id} feed={feed} active={!query && stream.id === feed.id} onOpen={() => openStream({ kind: 'feed', id: feed.id, title: feed.title })} onContext={(left, top) => openFeedContext(feed, left, top)} />)}
              </div>}
            </div>
          })}
          </div>
        </nav>
        <footer className="sidebar-footer">
          <button onClick={() => { setSettingsFeedId(''); setOverlays({ ...closedOverlays, settings: true }) }}><Icon name="settings" /> Settings</button>
          <button onClick={() => setTheme(current => toggledTheme(current, systemDark))} aria-label={darkThemeActive ? 'Use light mode' : 'Use dark mode'} title={darkThemeActive ? 'Use light mode' : 'Use dark mode'}><Icon name={darkThemeActive ? 'sun' : 'moon'} /></button>
        </footer>
      </aside>

      {view === 'reader' ? <><section className="story-pane panel">
        <div className="story-toolbar">
          <button className="mobile-back icon-button" onClick={() => changeMobilePane('sources')} aria-label="Back to sources"><Icon name="back" /></button>
          <div className="stream-title"><h1>{query ? 'Search' : libraryMode === 'recent' ? 'Continue reading' : libraryMode === 'offline' ? 'Offline articles' : stream.title}</h1><span>{visibleStreamTotal === null ? entries.length : `${visibleStreamTotal} unread`}</span></div>
          <button className={`icon-button ${refreshing ? 'spinning' : ''}`} onClick={() => void refresh()} aria-label="Refresh"><Icon name="refresh" /></button>
          <button className="icon-button" disabled={!online || libraryMode !== 'stream'} onClick={() => void markAllRead()} aria-label={query ? "Mark search results read" : "Mark stream read"}><Icon name="check" /></button>
        </div>
        <div className="reader-status" role="status">{!online ? 'Offline. Saved articles are available below.' : syncError ? `Sync needs attention: ${syncError}` : lastSync ? `Last synced ${relativeDate(lastSync)}` : 'Waiting for synchronization'}{syncError && online && <button onClick={() => void refresh()}>Retry</button>}</div>
        {query && <div className="search-controls">
          <label>Search in<select aria-label="Search scope" value={searchStream.id} onChange={event => {
            const id = event.target.value
            const folder = navigation?.folders.find(item => item.id === id)
            const feed = uniqueFeeds(navigation).find(item => item.id === id)
            setSearchStream(id === 'starred' ? starredStream : folder ? { kind: 'category', id, title: folder.title } : feed ? { kind: 'feed', id, title: feed.title } : allStream)
          }}><option value="all">All feeds</option><option value="starred">Starred</option>{navigation?.folders.map(folder => <option key={folder.id} value={folder.id}>{folder.title}</option>)}{uniqueFeeds(navigation).map(feed => <option key={feed.id} value={feed.id}>{feed.title}</option>)}</select></label>
          <label>State<select value={searchUnread ? 'unread' : 'all'} onChange={event => setSearchUnread(event.target.value === 'unread')}><option value="all">Entire archive</option><option value="unread">Unread only</option></select></label>
          <label>From<input type="date" value={after} onChange={event => setAfter(event.target.value)} /></label><label>Through<input type="date" value={before} onChange={event => setBefore(event.target.value)} /></label>
          <button onClick={() => { setQuery(''); setAfter(''); setBefore('') }}>Clear search</button>
        </div>}
        {libraryMode === 'offline' && <div className="reader-status">Copies stay on this device. Videos need a connection. <button onClick={() => { if (window.confirm('Remove all offline articles and their saved images from this device?')) void clearOffline().then(() => loadEntries()) }}>Clear offline copies</button></div>}
        <div className="filter-row">
          {mobileLayout || starredView || libraryMode !== 'stream'
            ? <span className="story-filter-label">{libraryMode === 'stream' && streamUnreadOnly ? 'Unread' : 'All'}</span>
            : <ArticleFilter unreadOnly={query ? searchUnread : unreadOnly} onChange={query ? setSearchUnread : changeUnreadOnly} />}
          {!query && libraryMode === 'stream' && <select className="story-order" aria-label="Article order" title="Remember order for this feed or folder" value={entryOrder} disabled={loading || savingOrder} onChange={event => void changeEntryOrder(event.target.value as 'newest' | 'oldest')}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>}
          <span>{loading
            ? 'Loading'
            : entries.length
              ? visibleStreamTotal === null ? `${entries.length} loaded` : `${entries.length} of ${visibleStreamTotal} loaded`
              : 'No articles'}</span>
        </div>
        <div className={`story-list ${pullDistance > 0 ? 'pulling pull-active' : ''} ${refreshing ? 'pull-active' : ''}`} ref={listRef} tabIndex={0} aria-label="Articles" onTouchStart={beginStoryGesture} onTouchMove={continueStoryGesture} onTouchEnd={releaseStoryGesture} onTouchCancel={releaseStoryGesture} style={{ '--pull-distance': `${pullDistance || (refreshing ? 44 : 0)}px` } as React.CSSProperties}>
          <div className={`pull-refresh-indicator ${shouldReleaseToRefresh(pullDistance) ? 'ready' : ''} ${refreshing ? 'refreshing' : ''}`}><Icon name="back" /><span>{refreshing ? 'Refreshing' : shouldReleaseToRefresh(pullDistance) ? 'Release to refresh' : 'Pull to refresh'}</span></div>
          <div className="story-list-content">
            {loading && <StorySkeleton />}
            {!loading && entries.length > 0 && previousFolder && <div className="stream-boundary" ref={streamStartRef}>
              <span>Beginning</span>
            </div>}
            {!loading && entries.map(entry => <StoryRow
              key={entry.id}
              ref={element => {
                if (element) storyRowRefs.current.set(entry.id, element)
                else storyRowRefs.current.delete(entry.id)
              }}
              entry={entry}
              active={entry.id === selectedId}
              onOpen={() => openEntry(entry)}
              onContext={(left, top) => openEntryContext(entry, left, top)}
            />)}
            {listError && <div className="list-error" role="alert"><p>{listError}</p><button onClick={() => void loadEntries()}>Try again</button></div>}
            {!listError && !loading && !entries.length && <EmptyList query={query} libraryMode={libraryMode} unreadOnly={streamUnreadOnly} onShowAll={() => changeUnreadOnly(false)} />}
            {!loading && <div className={`load-more-marker${!continuation && !listError ? ' stream-boundary' : ''}`} ref={loadMoreRef}>
              {loadingMore ? 'Loading more' : continuation || listError ? '' : <>
                <span>End</span>
              </>}
            </div>}
          </div>
        </div>
      </section>

      <main className="reader-pane panel">
        {selected ? <ArticleView
          ref={articleRef}
          entry={selected}
          feedIconUrl={feedIcons.get(selected.feedId) || ''}
          onBack={closeEntry}
          collectionTitle={pulseContext?.title || ''}
          actionError={actionError?.id === selected.id ? actionError.message : ''}
          onRetryAction={() => { if (actionError?.id === selected.id) void setEntryState(selected, actionError.operation) }}
          fullTextError={fullTextError?.id === selected.id ? fullTextError.message : ''}
          backLabel={pulseContext ? 'Back to collection' : 'Back to stories'}
          readwiseBusy={readwiseBusy}
          readwiseConfigured={status.readwiseConfigured}
          online={online}
          fullMode={fullMode}
          onFullMode={mode => { setFullMode(mode); setFullTextMode(selected.feedId, mode); automaticFullTextAttempts.current.delete(selected.id) }}
          onFeedText={() => { const feed = feedVersions.current.get(selected.id); if (feed) { automaticFullTextAttempts.current.add(selected.id); updateEntry(selected.id, articleContent(feed)) } else void api.entry(selected.id).then(result => { if (result.entry) { automaticFullTextAttempts.current.add(selected.id); updateEntry(selected.id, articleContent(result.entry)) } }).catch(error => notify(error.message)) }}
          onRefreshText={() => void fetchFullText(selected, false, true)}
          onOffline={() => { setOfflineBusy(true); void saveOffline(selected).then(() => notify('Saved for offline reading on this device')).catch(error => notify(error.message)).finally(() => setOfflineBusy(false)) }}
          offlineBusy={offlineBusy}
          onRemoveOffline={libraryMode === 'offline' ? () => void removeOffline(selected.id).then(() => { setSelectedId(''); void loadEntries() }) : undefined}
          onPrevious={() => void move(-1)} onNext={() => void move(1)}
          onToggleRead={() => void setEntryState(selected, selected.read ? 'unread' : 'read')}
          onToggleStar={() => void setEntryState(selected, selected.starred ? 'unstar' : 'star')}
          onReadwise={() => void saveReadwise()}
          onCopyUrl={() => void copyArticleUrl(selected)}
          onFullText={() => { const full = fullVersions.current.get(selected.id); if (full) updateEntry(selected.id, articleContent(full)); else void fetchFullText() }}
          onReport={() => setReportEntry(selected)}
          discussionConfigured={status.discussionConfigured}
          selectionActionsConfigured={status.discussionConfigured || status.kirbyConfigured}
          onDiscuss={() => setDiscussionTarget({ entry: selected, quote: '' })}
          fullTextBusy={fetchingFullTextId === selected.id}
          onAppearance={() => setOverlays({ ...closedOverlays, appearance: true })}
          onScroll={handleArticleScroll}
          boundaryStore={articleBoundaryStore}
          navigationBusy={articleNavigationBusy}
          transition={articleTransition}
          onTouchEnd={releaseArticleGesture}
          previousAvailable={previousArticleAvailable}
          nextAvailable={nextArticleAvailable}
          previousTitle={previousArticleTitle}
          nextTitle={nextArticleTitle}
          onSelectionContext={setSelectionContext}
        /> : <ReaderEmpty onCommand={() => setOverlays({ ...closedOverlays, command: true })} />}
      </main></> : view === 'briefings'
        ? <BriefingLibrary onBack={openSources} />
        : <TopicsLibrary initialCollection={linkedCollection} feedIcons={feedIcons} refreshKey={topicsRefreshKey} onBack={openSources} onOpenEntry={(id, context) => void openTopicEntry(id, context)} onMarkRead={markTopicRead} notify={notify} />}

      <nav className="mobile-tabs" aria-label="Mobile navigation">
        <button className={view === 'reader' && mobilePane === 'sources' ? 'active' : ''} onClick={openSources}><Icon name="folder" /><span>Sources</span></button>
        <button className={view !== 'reader' || mobilePane === 'stories' ? 'active' : ''} onClick={() => view === 'briefings' ? openBriefings() : view === 'pulse' ? openTopics() : changeMobilePane('stories')}><Icon name={view === 'briefings' ? 'reader' : view === 'pulse' ? 'topics' : 'feed'} /><span>{view === 'briefings' ? 'Briefings' : view === 'pulse' ? 'Pulse' : 'Stories'}</span></button>
        <button className={mobilePane === 'article' ? 'active' : ''} disabled={!selected} onClick={() => selected && changeMobilePane('article')}><Icon name="bookmark" /><span>Reading</span></button>
      </nav>

      {bulkPreview && <Modal title="Mark search results read" onClose={() => !bulkBusy && setBulkPreview(null)}><p>{bulkPreview.label}: {bulkPreview.count} unread articles will be marked read.</p><button disabled={bulkBusy || !bulkPreview.count} onClick={() => {
        setBulkBusy(true)
        void api.confirmRead(bulkPreview.token).then(async result => { setBulkPreview(null); await Promise.all([loadEntries(), loadNavigation()]); notify(`Marked ${result.count} articles read`, { label: 'Undo', run: () => void api.undo(result.undoToken).then(() => Promise.all([loadEntries(), loadNavigation()])).catch(error => notify(error.message)) }) }).catch(error => notify(error.message)).finally(() => setBulkBusy(false))
      }}>{bulkBusy ? 'Marking read...' : `Mark ${bulkPreview.count} read`}</button><button disabled={bulkBusy} onClick={() => setBulkPreview(null)}>Cancel</button></Modal>}
      {overlays.command && <CommandPalette commands={commands} onClose={() => setOverlays(closedOverlays)} />}
      {overlays.help && <ShortcutHelp onClose={() => setOverlays(closedOverlays)} />}
      {folderContext && <FolderContextMenu state={folderContext} onClose={() => setFolderContext(null)} onOpen={() => openStream({ kind: 'category', id: folderContext.folder.id, title: folderContext.folder.title })} onMarkRead={() => void markFolderRead(folderContext.folder)} />}
      {feedContext && <FeedContextMenu state={feedContext} onClose={() => setFeedContext(null)} onOpen={() => openStream({ kind: 'feed', id: feedContext.feed.id, title: feedContext.feed.title })} onMarkRead={() => void markFeedRead(feedContext.feed)} onManage={() => manageFeed(feedContext.feed)} onUnsubscribe={() => void unsubscribeFeed(feedContext.feed)} onCopy={() => void navigator.clipboard.writeText(feedContext.feed.url).then(() => { setFeedContext(null); notify('Feed URL copied') })} />}
      {entryContext && <EntryContextMenu key={entryContext.entry.id} state={entryContext} relativeAvailable={libraryMode === 'stream' && online} onClose={() => setEntryContext(null)} onOpen={() => { setEntryContext(null); openEntry(entryContext.entry) }} onCopyUrl={() => { void copyArticleUrl(entryContext.entry); setEntryContext(null) }} onToggleRead={() => { const entry = entryContext.entry; setEntryContext(null); void setEntryState(entry, entry.read ? 'unread' : 'read') }} onToggleStar={() => { const entry = entryContext.entry; setEntryContext(null); void setEntryState(entry, entry.starred ? 'unstar' : 'star') }} onReport={() => { setReportEntry(entryContext.entry); setEntryContext(null) }} onMarkAbove={() => void markRelativeRead(entryContext.entry, 'above')} onMarkBelow={() => void markRelativeRead(entryContext.entry, 'below')} onUnsubscribe={() => void unsubscribeFeed({ id: entryContext.entry.feedId, title: entryContext.entry.feedTitle })} />}
      {selectionContext && (status.kirbyConfigured || status.discussionConfigured) && <SelectionContextMenu state={selectionContext} kirbyConfigured={status.kirbyConfigured} discussionConfigured={status.discussionConfigured} onClose={() => setSelectionContext(null)} onCreate={() => void createKirbyNote(selectionContext.quote)} onDiscuss={() => { if (!status.discussionConfigured) return notify('Article discussion is not configured'); if (selected) setDiscussionTarget({ entry: selected, quote: selectionContext.quote }); setSelectionContext(null) }} />}
      {discussionTarget && <ArticleDiscussion key={discussionTarget.entry.id} entry={discussionTarget.entry} initialQuote={discussionTarget.quote} onClose={() => setDiscussionTarget(null)} />}
      {overlays.settings && <Settings section={settingsSection} setSection={setSettingsSection} initialFeedId={settingsFeedId} navigation={navigation} onChanged={loadNavigation} onFiltersChanged={reloadFilteredLibrary} notify={notify} onConnectionsChanged={loadStatus} autoRead={autoRead} setAutoRead={value => { setAutoRead(value); localStorage.setItem('paper-auto-read', value ? 'automatic' : 'manual') }} onOpenEntry={id => { setOverlays(closedOverlays); void openTopicEntry(id) }} onClose={() => setOverlays(closedOverlays)} />}
      {overlays.appearance && <AppearancePopover theme={theme} setTheme={setTheme} readerFont={readerFont} setReaderFont={setReaderFont} readerSize={readerSize} setReaderSize={setReaderSize} readerSpacing={readerSpacing} setReaderSpacing={setReaderSpacing} readerWidth={readerWidth} setReaderWidth={setReaderWidth} onClose={() => setOverlays(closedOverlays)} />}
      {reportEntry && <ReportProblemModal entry={reportEntry} onClose={() => setReportEntry(null)} onSaved={() => { setReportEntry(null); notify('Problem reported') }} />}
      {toast && <div className="toast" role="status"><span>{toast.message}</span>{toast.action && <button onClick={() => { toast.action?.(); setToast(null) }}>{toast.actionLabel}</button>}</div>}
    </div>
  )
}

function SourceButton({ active, icon, label, count, onClick }: { active: boolean; icon: 'feed' | 'star' | 'reader' | 'topics'; label: string; count: number; onClick: () => void }) {
  return <button className={`source-row ${active ? 'active' : ''}`} onClick={onClick}><Icon name={icon} /><span className="source-label">{label}</span>{count > 0 && <span className="source-count">{count}</span>}</button>
}

function ArticleFilter({ unreadOnly, onChange }: { unreadOnly: boolean; onChange: (unread: boolean) => void }) {
  return <div className="segmented" role="group" aria-label="Article filter">
    <button className={unreadOnly ? 'active' : ''} aria-pressed={unreadOnly} onClick={() => onChange(true)}>Unread</button>
    <button className={!unreadOnly ? 'active' : ''} aria-pressed={!unreadOnly} onClick={() => onChange(false)}>All</button>
  </div>
}

function FolderRowButton({ folder, active, expanded, onOpen, onToggle, onContext }: {
  folder: Folder
  active: boolean
  expanded: boolean
  onOpen: () => void
  onToggle: (event: React.MouseEvent<HTMLButtonElement>) => void
  onContext: (left: number, top: number) => void
}) {
  const pressTimer = useRef<number | undefined>(undefined)
  const pressOrigin = useRef({ x: 0, y: 0 })
  const suppressClick = useRef(false)

  const cancelPress = () => {
    window.clearTimeout(pressTimer.current)
    pressTimer.current = undefined
  }

  useEffect(() => cancelPress, [])

  const beginPress = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'mouse') return
    cancelPress()
    suppressClick.current = false
    const { clientX, clientY } = event
    pressOrigin.current = { x: clientX, y: clientY }
    pressTimer.current = window.setTimeout(() => {
      suppressClick.current = true
      navigator.vibrate?.(12)
      onContext(clientX, clientY)
    }, 450)
  }

  const movePress = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (Math.hypot(event.clientX - pressOrigin.current.x, event.clientY - pressOrigin.current.y) > 8) cancelPress()
  }

  const openContextMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    cancelPress()
    onContext(event.clientX, event.clientY)
  }

  return <div className="folder-row-wrapper"><button className="folder-expand" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${folder.title}`} aria-expanded={expanded} onClick={onToggle}><Icon name="chevron" className={expanded ? 'rotated' : ''} /></button><button
    className={`folder-row ${active ? 'active' : ''}`}
    onPointerDown={beginPress}
    onPointerMove={movePress}
    onPointerUp={cancelPress}
    onPointerCancel={cancelPress}
    onContextMenu={openContextMenu}
    onClick={event => {
      if (suppressClick.current) {
        event.preventDefault()
        event.stopPropagation()
        suppressClick.current = false
        return
      }
      onOpen()
    }}
  >
    <span className="source-label">{folder.title}</span>
    {folder.unread > 0 && <span className="source-count">{folder.unread}</span>}
  </button><button className="row-options" aria-label={`Options for ${folder.title}`} onClick={event => { const box = event.currentTarget.getBoundingClientRect(); onContext(box.left, box.bottom) }}>⋯</button></div>
}

function FeedRowButton({ feed, active, onOpen, onContext }: {
  feed: Feed
  active: boolean
  onOpen: () => void
  onContext: (left: number, top: number) => void
}) {
  const pressTimer = useRef<number | undefined>(undefined)
  const pressOrigin = useRef({ x: 0, y: 0 })
  const suppressClick = useRef(false)

  const cancelPress = () => {
    window.clearTimeout(pressTimer.current)
    pressTimer.current = undefined
  }

  useEffect(() => cancelPress, [])

  const beginPress = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'mouse') return
    cancelPress()
    suppressClick.current = false
    const { clientX, clientY } = event
    pressOrigin.current = { x: clientX, y: clientY }
    pressTimer.current = window.setTimeout(() => {
      suppressClick.current = true
      navigator.vibrate?.(12)
      onContext(clientX, clientY)
    }, 450)
  }

  const movePress = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (Math.hypot(event.clientX - pressOrigin.current.x, event.clientY - pressOrigin.current.y) > 8) cancelPress()
  }

  const openContextMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    cancelPress()
    onContext(event.clientX, event.clientY)
  }

  return <div className="feed-row-wrapper"><button
    className={`feed-row ${active ? 'active' : ''}`}
    onPointerDown={beginPress}
    onPointerMove={movePress}
    onPointerUp={cancelPress}
    onPointerCancel={cancelPress}
    onContextMenu={openContextMenu}
    onClick={event => {
      if (suppressClick.current) {
        event.preventDefault()
        event.stopPropagation()
        suppressClick.current = false
        return
      }
      onOpen()
    }}
  >
    <FeedMark title={feed.title} url={feed.siteUrl || feed.url} iconUrl={feed.iconUrl} />
    <span className="source-label">{feed.title}</span>
    {feed.unread > 0 && <span className="source-count">{feed.unread}</span>}
  </button><button className="row-options" aria-label={`Options for ${feed.title}`} onClick={event => { const box = event.currentTarget.getBoundingClientRect(); onContext(box.left, box.bottom) }}>⋯</button></div>
}

function FolderContextMenu({ state, onClose, onOpen, onMarkRead }: {
  state: FolderContextState
  onClose: () => void
  onOpen: () => void
  onMarkRead: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useMenuFocus(ref)

  useEffect(() => {
    const closePointer = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) onClose() }
    const closeKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    const closeScroll = () => onClose()
    window.addEventListener('pointerdown', closePointer)
    window.addEventListener('keydown', closeKey)
    window.addEventListener('resize', closeScroll)
    window.addEventListener('scroll', closeScroll, true)
    return () => {
      window.removeEventListener('pointerdown', closePointer)
      window.removeEventListener('keydown', closeKey)
      window.removeEventListener('resize', closeScroll)
      window.removeEventListener('scroll', closeScroll, true)
    }
  }, [onClose])

  return <div ref={ref} className="feed-context-menu" role="menu" aria-label={`${state.folder.title} options`} style={{ left: state.left, top: state.top }}>
    <strong>{state.folder.title}</strong>
    <button role="menuitem" onClick={onOpen}><Icon name="folder" /> Open folder</button>
    <button role="menuitem" disabled={state.folder.unread === 0} onClick={onMarkRead}><Icon name="check" /> {state.folder.unread > 0 ? 'Mark folder read' : 'All read'}</button>
  </div>
}

function FeedContextMenu({ state, onClose, onOpen, onMarkRead, onManage, onUnsubscribe, onCopy }: {
  state: FeedContextState
  onClose: () => void
  onOpen: () => void
  onMarkRead: () => void
  onManage: () => void
  onUnsubscribe: () => void
  onCopy: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useMenuFocus(ref)
  const [confirmRemove, setConfirmRemove] = useState(false)

  useEffect(() => {
    const closePointer = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) onClose() }
    const closeKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    const closeScroll = () => onClose()
    window.addEventListener('pointerdown', closePointer)
    window.addEventListener('keydown', closeKey)
    window.addEventListener('resize', closeScroll)
    window.addEventListener('scroll', closeScroll, true)
    return () => {
      window.removeEventListener('pointerdown', closePointer)
      window.removeEventListener('keydown', closeKey)
      window.removeEventListener('resize', closeScroll)
      window.removeEventListener('scroll', closeScroll, true)
    }
  }, [onClose])

  return <div ref={ref} className="feed-context-menu" role="menu" aria-label={`${state.feed.title} options`} style={{ left: state.left, top: state.top }}>
    <strong>{state.feed.title}</strong>
    <button role="menuitem" onClick={onOpen}><Icon name="feed" /> Open feed</button>
    <button role="menuitem" disabled={state.feed.unread === 0} onClick={onMarkRead}><Icon name="check" /> Mark feed read</button>
    <button role="menuitem" onClick={onManage}><Icon name="settings" /> Edit feed</button>
    {state.feed.siteUrl && <a role="menuitem" href={state.feed.siteUrl} target="_blank" rel="noopener noreferrer" onClick={onClose}><Icon name="external" /> Open website</a>}
    <button role="menuitem" onClick={onCopy}><Icon name="bookmark" /> Copy feed URL</button>
    <button role="menuitem" className={`danger ${confirmRemove ? 'confirming' : ''}`} onClick={() => confirmRemove ? onUnsubscribe() : setConfirmRemove(true)}><Icon name="close" /> {confirmRemove ? 'Confirm unsubscribe' : 'Unsubscribe'}</button>
  </div>
}

function EntryContextMenu({ state, relativeAvailable, onClose, onOpen, onCopyUrl, onToggleRead, onToggleStar, onReport, onMarkAbove, onMarkBelow, onUnsubscribe }: {
  state: EntryContextState
  relativeAvailable: boolean
  onClose: () => void
  onOpen: () => void
  onCopyUrl: () => void
  onToggleRead: () => void
  onToggleStar: () => void
  onReport: () => void
  onMarkAbove: () => void
  onMarkBelow: () => void
  onUnsubscribe: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useMenuFocus(ref)
  const [confirmRemove, setConfirmRemove] = useState(false)

  useEffect(() => {
    const closePointer = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) onClose() }
    const closeKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    const closeScroll = () => onClose()
    window.addEventListener('pointerdown', closePointer)
    window.addEventListener('keydown', closeKey)
    window.addEventListener('resize', closeScroll)
    window.addEventListener('scroll', closeScroll, true)
    return () => {
      window.removeEventListener('pointerdown', closePointer)
      window.removeEventListener('keydown', closeKey)
      window.removeEventListener('resize', closeScroll)
      window.removeEventListener('scroll', closeScroll, true)
    }
  }, [onClose])

  return <div ref={ref} className="feed-context-menu entry-context-menu" role="menu" aria-label={`${state.entry.title} options`} style={{ left: state.left, top: state.top }}>
    <strong>{state.entry.title}</strong>
    <button role="menuitem" onClick={onOpen}><Icon name="reader" /> Open article</button>
    <button role="menuitem" onClick={onCopyUrl}><Icon name="copy" /> Copy article URL</button>
    <button role="menuitem" onClick={onToggleRead}><Icon name={state.entry.read ? 'archive' : 'check'} /> {state.entry.read ? 'Mark unread' : 'Mark read'}</button>
    <button role="menuitem" onClick={onToggleStar}><Icon name="star" className={state.entry.starred ? 'filled' : ''} /> {state.entry.starred ? 'Remove star' : 'Star article'}</button>
    <button role="menuitem" onClick={onReport}><Icon name="report" /> Report a problem</button>
    <span className="context-menu-rule" />
    <button role="menuitem" disabled={!relativeAvailable} onClick={onMarkAbove}><Icon name="check" /> Mark all above read</button>
    <button role="menuitem" disabled={!relativeAvailable} onClick={onMarkBelow}><Icon name="check" /> Mark all below read</button>
    <span className="context-menu-rule" />
    <button role="menuitem" className={`danger entry-unsubscribe ${confirmRemove ? 'confirming' : ''}`} disabled={!state.entry.feedId.startsWith('feed/')} onClick={() => confirmRemove ? onUnsubscribe() : setConfirmRemove(true)}>
      <Icon name="close" /><span>{confirmRemove ? 'Confirm unsubscribe' : 'Unsubscribe from feed'}<small title={state.entry.feedTitle}>{state.entry.feedTitle}</small></span>
    </button>
  </div>
}

function SelectionContextMenu({ state, onClose, onCreate, onDiscuss, kirbyConfigured, discussionConfigured }: {
  kirbyConfigured: boolean
  discussionConfigured: boolean
  state: SelectionContextState
  onClose: () => void
  onCreate: () => void
  onDiscuss: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useMenuFocus(ref)

  useEffect(() => {
    const closePointer = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) onClose() }
    const closeKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    const closeScroll = () => onClose()
    window.addEventListener('pointerdown', closePointer)
    window.addEventListener('keydown', closeKey)
    window.addEventListener('resize', closeScroll)
    window.addEventListener('scroll', closeScroll, true)
    return () => {
      window.removeEventListener('pointerdown', closePointer)
      window.removeEventListener('keydown', closeKey)
      window.removeEventListener('resize', closeScroll)
      window.removeEventListener('scroll', closeScroll, true)
    }
  }, [onClose])

  return <div ref={ref} className="feed-context-menu selection-context-menu" role="menu" aria-label="Selected text options" style={{ left: state.left, top: state.top }}>
    {discussionConfigured && <button role="menuitem" onClick={onDiscuss}><Icon name="reader" /> Ask about this</button>}
    {kirbyConfigured && <button role="menuitem" onClick={onCreate}><Icon name="plus" /> Create note in Kirby</button>}
  </div>
}

function BriefingLibrary({ onBack }: { onBack: () => void }) {
  const [briefings, setBriefings] = useState<BriefingSummary[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [detail, setDetail] = useState<BriefingDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [feedbackPending, setFeedbackPending] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [detailLoading, setDetailLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError('')
    api.briefings().then(items => {
      if (cancelled) return
      setBriefings(items)
      if (!window.matchMedia('(max-width: 1040px)').matches) setSelectedId(items[0]?.id || '')
    }).catch(reason => { if (!cancelled) setError(reason.message) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [retry])

  useEffect(() => {
    if (!selectedId) return setDetail(null)
    let cancelled = false
    setDetail(null); setDetailLoading(true); setError('')
    api.briefing(selectedId).then(item => { if (!cancelled) setDetail(item) }).catch(reason => { if (!cancelled) setError(reason.message) }).finally(() => { if (!cancelled) setDetailLoading(false) })
    return () => { cancelled = true }
  }, [selectedId, retry])

  const sendFeedback = async (feedback: 'useful' | 'too_broad' | 'missed') => {
    if (!detail || feedbackPending) return
    setFeedbackPending(true)
    try {
      await api.briefingFeedback(detail.id, feedback)
      setDetail(current => current ? { ...current, feedback } : current)
      setBriefings(current => current.map(item => item.id === detail.id ? { ...item, feedback } : item))
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save feedback') } finally {
      setFeedbackPending(false)
    }
  }

  return <section className={`briefing-library panel ${selectedId ? 'has-selection' : ''}`}>
    <div className="briefing-list">
      <header><button className="briefing-library-back mobile-back icon-button" onClick={onBack} aria-label="Back to sources"><Icon name="back" /></button><h1>Briefings</h1><span>{briefings.length}</span></header>
      {error && <p className="form-error" role="alert">{error} <button onClick={() => setRetry(value => value + 1)}>Retry</button></p>}
      {loading && <p className="briefing-empty">Loading briefings</p>}
      {!error && !loading && !briefings.length && <div className="briefing-empty"><h2>No briefings yet</h2><p>The morning and evening editions and folder digests will appear here after they are generated.</p></div>}
      {briefings.map(item => <button key={item.id} className={selectedId === item.id ? 'active' : ''} onClick={() => setSelectedId(item.id)}>
        <span className="briefing-kind">{item.kind}</span>
        <strong>{briefingTitle(item.subject)}</strong>
        <span className={`briefing-status status-${item.status}`}>{briefingStatus(item)}</span>
        <time>{formatDate(item.createdAt)}</time>
      </button>)}
    </div>
    <div className="briefing-preview">
      {detailLoading ? <p role="status">Loading briefing...</p> : detail ? <>
        <div className="briefing-preview-bar"><button className="briefing-back icon-button" onClick={() => setSelectedId('')} aria-label="Back to briefings"><Icon name="back" /></button><div className="briefing-preview-title"><strong>{briefingTitle(detail.subject)}</strong><span>{detail.entryCount} represented {detail.entryCount === 1 ? 'entry' : 'entries'} · {briefingStatus(detail)}</span></div><div className="briefing-feedback" aria-label="Briefing feedback"><span>Was this useful?</span><button className={detail.feedback === 'useful' ? 'active' : ''} disabled={feedbackPending} onClick={() => sendFeedback('useful')}>Yes</button><button className={detail.feedback === 'too_broad' ? 'active' : ''} disabled={feedbackPending} onClick={() => sendFeedback('too_broad')}>Too much</button><button className={detail.feedback === 'missed' ? 'active' : ''} disabled={feedbackPending} onClick={() => sendFeedback('missed')}>Missed</button></div></div>
        <iframe title={detail.subject} srcDoc={detail.html} sandbox="allow-forms allow-popups allow-popups-to-escape-sandbox" />
      </> : <div className="briefing-empty"><h2>Select a briefing</h2><p>Its email layout will appear here.</p></div>}
    </div>
  </section>
}

function briefingTitle(subject: string): string {
  return subject.replace(/^(?:Paper (?:morning|evening)(?: briefing)?|(?:Morning|Evening) Paper Briefing) \| /i, '')
}

function briefingStatus(item: BriefingSummary): string {
  if (item.kind === 'digest') return 'Daily digest'
  if (item.acknowledgedAt || item.status === 'acknowledged') return 'Read and acknowledged'
  if (item.deliveredAt || item.status === 'delivered') return 'Delivered'
  return 'Generated, not delivered'
}

function FeedMark({ title, url, iconUrl = '' }: { title: string; url: string; iconUrl?: string }) {
  const [iconFailed, setIconFailed] = useState(false)
  useEffect(() => setIconFailed(false), [iconUrl])
  const trimmedTitle = title.trim()
  let letter = (trimmedTitle.startsWith('@') ? trimmedTitle.charAt(1) : trimmedTitle.charAt(0)).toUpperCase() || '•'
  let hue = 210
  try { hue = [...new URL(url).hostname].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360 } catch { letter = title.charAt(0) }
  const showIcon = Boolean(iconUrl && !iconFailed)
  return <span className={`feed-mark ${showIcon ? 'has-icon' : ''}`} style={{ '--feed-hue': hue } as React.CSSProperties}>
    {showIcon ? <img src={iconUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setIconFailed(true)} /> : letter}
  </span>
}

const StoryRow = forwardRef<HTMLElement, { entry: Entry; active: boolean; onOpen: () => void; onContext: (left: number, top: number) => void }>(function StoryRow({ entry, active, onOpen, onContext }, ref) {
  const [thumbnailReady, setThumbnailReady] = useState(false)
  const pressTimer = useRef<number | undefined>(undefined)
  const pressOrigin = useRef({ x: 0, y: 0 })
  const suppressClick = useRef(false)

  const cancelPress = () => {
    window.clearTimeout(pressTimer.current)
    pressTimer.current = undefined
  }

  useEffect(() => cancelPress, [])
  useEffect(() => {
    setThumbnailReady(false)
    if (!entry.thumbnailUrl) return
    let cancelled = false
    const image = new Image()
    image.onload = () => { if (!cancelled) setThumbnailReady(true) }
    image.onerror = () => { if (!cancelled) setThumbnailReady(false) }
    image.src = entry.thumbnailUrl
    return () => { cancelled = true }
  }, [entry.thumbnailUrl])
  const showThumbnail = Boolean(entry.thumbnailUrl && thumbnailReady)
  return <article
    ref={ref}
    tabIndex={0} role="button" aria-label={entry.displayTitle || entry.title}
    onKeyDown={event => { if (event.target !== event.currentTarget) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); onOpen() } }}
    className={`story-row kind-${entry.kind} ${showThumbnail ? '' : 'no-thumbnail'} ${active ? 'active' : ''} ${entry.read ? 'read' : ''}`}
    onPointerDown={event => {
      if (event.pointerType === 'mouse') return
      cancelPress()
      suppressClick.current = false
      const { clientX, clientY } = event
      pressOrigin.current = { x: clientX, y: clientY }
      pressTimer.current = window.setTimeout(() => {
        suppressClick.current = true
        navigator.vibrate?.(12)
        onContext(clientX, clientY)
      }, 450)
    }}
    onPointerMove={event => {
      if (Math.hypot(event.clientX - pressOrigin.current.x, event.clientY - pressOrigin.current.y) > 8) cancelPress()
    }}
    onPointerUp={cancelPress}
    onPointerCancel={cancelPress}
    onContextMenu={event => {
      event.preventDefault()
      event.stopPropagation()
      cancelPress()
      onContext(event.clientX, event.clientY)
    }}
    onClick={event => {
      if (suppressClick.current) {
        event.preventDefault()
        event.stopPropagation()
        suppressClick.current = false
        return
      }
      onOpen()
    }}
  >
    {showThumbnail && <img className="story-thumb" src={entry.thumbnailUrl} alt="" onError={() => setThumbnailReady(false)} />}
    <button className="row-options" aria-label={`Options for ${entry.title}`} onClick={event => { event.stopPropagation(); const box = event.currentTarget.getBoundingClientRect(); onContext(box.left, box.bottom) }}>⋯</button>
    <div className="story-copy">
      <div className="story-source"><span>{entry.feedTitle}</span><time>{relativeTime(entry.timestamp)}</time></div>
      <h2 title={entry.displayTitle ? `Original: ${entry.title}` : undefined}>{entry.displayTitle || entry.title}</h2>
      {(entry.searchExcerpt || entry.excerpt) && <p>{entry.searchExcerpt || entry.excerpt}</p>}
      <div className="story-meta"><span>{entry.readingMinutes} min</span>{entry.readingPosition !== undefined && <span>{Math.round(entry.readingPosition * 100)}% read</span>}{entry.readwiseSavedAt && <span>Readwise</span>}{entry.starred && <Icon name="star" className="filled" />}</div>
    </div>
  </article>
})

const ArticleView = forwardRef<HTMLElement, {
  entry: Entry
  feedIconUrl: string
  onBack: () => void
  backLabel: string
  collectionTitle: string
  actionError: string
  onRetryAction: () => void
  fullTextError: string
  readwiseBusy: boolean
  readwiseConfigured: boolean
  online: boolean
  fullMode: FullTextMode
  onFullMode: (mode: FullTextMode) => void
  onFeedText: () => void
  onRefreshText: () => void
  onOffline: () => void
  offlineBusy: boolean
  onRemoveOffline?: () => void
  onPrevious: () => void
  onNext: () => void
  onToggleRead: () => void
  onToggleStar: () => void
  onReadwise: () => void
  onCopyUrl: () => void
  onFullText: () => void
  onReport: () => void
  onDiscuss: () => void
  discussionConfigured: boolean
  selectionActionsConfigured: boolean
  fullTextBusy: boolean
  onAppearance: () => void
  onScroll: (event: React.UIEvent<HTMLDivElement>) => void
  boundaryStore: ArticleBoundaryStore
  navigationBusy: boolean
  transition: ArticleTransition
  onTouchEnd: (cancelled?: boolean) => void
  previousAvailable: boolean
  nextAvailable: boolean
  previousTitle: string
  nextTitle: string
  onSelectionContext: (state: SelectionContextState | null) => void
}>(function ArticleView({ entry, feedIconUrl, onBack, backLabel, collectionTitle, actionError, onRetryAction, fullTextError, readwiseBusy, readwiseConfigured, online, fullMode, onFullMode, onFeedText, onRefreshText, onOffline, offlineBusy, onRemoveOffline, onPrevious, onNext, onToggleRead, onToggleStar, onReadwise, onCopyUrl, onFullText, onReport, onDiscuss, discussionConfigured, selectionActionsConfigured, fullTextBusy, onAppearance, onScroll, boundaryStore, navigationBusy, transition, onTouchEnd, previousAvailable, nextAvailable, previousTitle, nextTitle, onSelectionContext }, ref) {
  const content = useRef<HTMLDivElement>(null)
  const [hasSelection, setHasSelection] = useState(false)
  useEffect(() => {
    const update = () => setHasSelection(Boolean(content.current && selectedTextWithin(content.current)))
    document.addEventListener('selectionchange', update)
    return () => document.removeEventListener('selectionchange', update)
  }, [])
  const selectedPassage = () => {
    const quote = content.current ? selectedTextWithin(content.current) : ''
    if (quote) onSelectionContext({ quote, left: Math.max(8, Math.min(24, window.innerWidth - 240)), top: Math.min(160, window.innerHeight - 130) })
  }
  const openSelectionContext = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!selectionActionsConfigured) return
    const quote = selectedTextWithin(event.currentTarget)
    if (!quote) return
    event.preventDefault()
    event.stopPropagation()
    onSelectionContext({
      quote,
      left: Math.max(8, Math.min(event.clientX, window.innerWidth - 224)),
      top: Math.max(8, Math.min(event.clientY, window.innerHeight - 100)),
    })
  }

  return <article className={`article-view kind-${entry.kind}`} tabIndex={0} ref={ref}>
    <div className="reader-toolbar">
      <button className="reader-back-button" onClick={onBack} aria-label={backLabel} title={backLabel}><Icon name="back" /></button>
      <div className="reader-actions">
        <button className={entry.starred ? 'active' : ''} onClick={onToggleStar} disabled={!online} aria-label={entry.starred ? 'Remove star' : 'Star article'} title={entry.starred ? 'Remove star' : 'Star article'}><Icon name="star" className={entry.starred ? 'filled' : ''} /><span>{entry.starred ? 'Starred' : 'Star'}</span></button>
        <button onClick={onToggleRead} disabled={!online} aria-label={entry.read ? 'Mark unread' : 'Mark read'} title={entry.read ? 'Mark unread' : 'Mark read'}><Icon name={entry.read ? 'archive' : 'check'} /><span>{entry.read ? 'Mark unread' : 'Mark read'}</span></button>
        {readwiseConfigured && <button onClick={onReadwise} disabled={!online || readwiseBusy || Boolean(entry.readwiseSavedAt)} aria-label={entry.readwiseSavedAt ? "Saved to Readwise" : "Save to Readwise"} title={entry.readwiseSavedAt ? "Saved to Readwise" : "Save to Readwise"}><Icon name="bookmark" /><span>{entry.readwiseSavedAt ? "Saved" : readwiseBusy ? "Saving..." : "Readwise"}</span></button>}
        {entry.kind === 'article' && <button className={entry.fullText ? 'active' : ''} onClick={onFullText} disabled={fullTextBusy || !online} aria-label={fullTextBusy ? 'Fetching full article' : entry.fullText ? 'Showing full article' : 'Fetch full article'} title={entry.fullText ? 'Showing full article' : 'Fetch full article'}><Icon name="reader" /><span>{fullTextBusy ? 'Fetching...' : entry.fullText ? 'Full text' : 'Full article'}</span></button>}
        <a href={entry.url} target="_blank" rel="noopener noreferrer" aria-label="Open original" title="Open original"><Icon name="external" /><span>Original</span></a>
        <button onClick={onCopyUrl} aria-label="Copy article URL" title="Copy article URL"><Icon name="copy" /><span>Copy URL</span></button>
        <button onClick={onReport} aria-label="Report a problem" title="Report a problem"><Icon name="report" /><span>Report</span></button>
        <button disabled={!discussionConfigured || !online} onClick={onDiscuss} aria-label="Discuss article" title={discussionConfigured ? 'Discuss article' : 'Discussion is not configured'}><Icon name="reader" /><span>Discuss</span></button>
      </div>
      <button className="type-button" onClick={onAppearance} aria-label="Appearance">Aa</button>
    </div>
    {!online && <div className="offline-banner" role="status">Offline. Read and star changes need a connection.</div>}
    {actionError && <div className="article-error" role="alert">{actionError} <button disabled={!online} onClick={onRetryAction}>Retry change</button></div>}
    {fullTextError && <div className="article-error" role="alert">{fullTextError} <button disabled={fullTextBusy || !online} onClick={onRefreshText}>Retry full article</button></div>}
    <div className="article-options">
      {collectionTitle && <button className="collection-return" title="Back to collection" onClick={onBack}>{collectionTitle}</button>}
      <button disabled={!previousAvailable || navigationBusy} onClick={onPrevious}>Previous</button><button disabled={!nextAvailable || navigationBusy} onClick={onNext}>Next</button>
      <details><summary>Article options</summary><div className="article-options-menu">
        {entry.kind === 'article' && <><button disabled={!entry.fullText || !online} onClick={onFeedText}>Show feed version</button><button disabled={fullTextBusy || !online} onClick={onRefreshText}>Refresh full article</button><label>Full text for this feed<select value={fullMode} onChange={event => onFullMode(event.target.value as FullTextMode)}><option value="auto">Auto</option><option value="always">Always</option><option value="never">Never automatically</option></select></label></>}
        <button disabled={offlineBusy} onClick={onOffline}>{offlineBusy ? 'Saving offline...' : 'Save offline'}</button>
        {onRemoveOffline && <button onClick={onRemoveOffline}>Remove offline copy</button>}
      </div></details>
      {hasSelection && <button onPointerDown={event => event.preventDefault()} onClick={selectedPassage}>Use selected text</button>}
    </div>
    {navigationBusy && <div className="article-navigation-status" role="status">Loading article...</div>}
    <div ref={content} className="article-scroll" onScroll={onScroll} onTouchEndCapture={() => onTouchEnd(false)} onTouchCancelCapture={() => onTouchEnd(true)} onContextMenu={openSelectionContext}>
      <ArticleEdgeZone direction="previous" title={previousTitle} available={previousAvailable} store={boundaryStore} />
      <div key={entry.id} className={`article-document ${transition ? `article-transition-${transition}` : ''}`}>
        {entry.kind !== 'article' ? <SocialArticle entry={entry} feedIconUrl={feedIconUrl} /> : <StandardArticle entry={entry} feedIconUrl={feedIconUrl} />}
      </div>
      <ArticleEdgeZone direction="next" title={nextTitle} available={nextAvailable} store={boundaryStore} />
    </div>
  </article>
})

function ArticleEdgeZone({ direction, title, available, store }: {
  direction: ArticleBoundaryDirection
  title: string
  available: boolean
  store: ArticleBoundaryStore
}) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const active = state?.direction === direction
  const progress = active ? state.progress : 0
  return <div
    className={`article-edge-zone ${direction} ${active ? 'active' : ''} ${active && state?.ready ? 'ready' : ''} ${available ? '' : 'unavailable'}`}
    style={{ '--edge-progress': progress } as React.CSSProperties}
    aria-hidden="true"
  >
    <Icon name="back" />
    <span><small>{available ? active && state?.ready ? 'Release to open' : direction === 'next' ? 'Next article' : 'Previous article' : direction === 'next' ? 'End' : 'Beginning'}</small><strong>{title}</strong></span>
  </div>
}

function selectedTextWithin(root: HTMLElement): string {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return ''
  if (!root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return ''
  return selection.toString().replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim()
}

function StandardArticle({ entry, feedIconUrl }: { entry: Entry; feedIconUrl: string }) {
  return <div className="article-column">
    <ArticleHeader entry={entry} feedIconUrl={feedIconUrl} />
    <ArticleLeadImage entry={entry} />
    <ArticleBody html={entry.contentHtml} />
  </div>
}

function ArticleLeadImage({ entry }: { entry: Entry }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [entry.id, entry.thumbnailUrl])
  if (failed || !shouldShowArticleLeadImage(entry.thumbnailUrl, entry.contentHtml)) return null
  return <figure className="article-lead-image"><img src={entry.thumbnailUrl} alt="" onError={() => setFailed(true)} /></figure>
}

function SocialArticle({ entry, feedIconUrl }: { entry: Entry; feedIconUrl: string }) {
  const [thread, setThread] = useState<XThreadPost[] | null>(null)
  useEffect(() => {
    let cancelled = false
    setThread(null)
    if (entry.kind !== 'x') return () => { cancelled = true }
    void api.xThread(entry.url)
      .then(result => {
        if (!cancelled && result.posts.length > 0) setThread(result.posts)
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [entry.id, entry.kind, entry.url])
  const contentHtml = useMemo(() => entry.kind === 'x' ? formatXPostHtml(entry.contentHtml)
    : entry.kind === 'instagram' ? formatInstagramHtml(entry.contentHtml)
    : entry.kind === 'threads' ? formatThreadsHtml(entry.contentHtml)
    : entry.kind === 'youtube' ? formatYoutubeHtml(entry.contentHtml)
    : entry.contentHtml, [entry.contentHtml, entry.kind])
  const videoId = entry.kind === 'youtube' ? youtubeVideoId(entry.url) : ''
  const identity = socialIdentity(entry)
  if (entry.kind === 'x') return <div className="social-column">
    <p className="social-network">X post</p>
    <div className={`x-conversation ${thread?.length ? 'has-thread' : ''}`}>
      <article className="x-root-post">
        <div className="social-author"><FeedMark title={identity.name} url={entry.feedUrl || entry.url} iconUrl={feedIconUrl} /><div><strong>{identity.name}</strong>{identity.meta && <span>{identity.meta}</span>}</div></div>
        <ArticleBody html={contentHtml} className="social-content" />
        <a className="social-original" href={entry.url} target="_blank" rel="noopener noreferrer">View original <Icon name="external" /></a>
      </article>
      {thread && thread.length > 0 && <section className="x-thread" aria-label={`Thread with ${thread.length + 1} posts`}>
        <div className="x-thread-heading"><strong>Thread</strong><span>{thread.length + 1} posts</span></div>
        {thread.map((post, index) => <article key={post.id}>
          <header>
            <FeedMark title={post.author || identity.name} url={entry.feedUrl || entry.url} iconUrl={feedIconUrl} />
            <span className="x-thread-author"><strong>{post.author || identity.name}</strong>{identity.meta && <span>{identity.meta}</span>}</span>
            <small>{index + 2} of {thread.length + 1}</small>
          </header>
          <ArticleBody html={formatXPostHtml(post.contentHtml)} className="social-content" />
          <a href={post.url} target="_blank" rel="noopener noreferrer">Open this post <Icon name="external" /></a>
        </article>)}
      </section>}
    </div>
  </div>
  return <div className="social-column">
    <p className="social-network">{socialNetworkName(entry.kind)}</p>
    <div className={`social-card network-${entry.kind}`}>
      <div className="social-author"><FeedMark title={identity.name} url={entry.feedUrl || entry.url} iconUrl={feedIconUrl} /><div><strong>{identity.name}</strong>{identity.meta && <span>{identity.meta}</span>}</div></div>
      {entry.kind === 'youtube' && <h1>{entry.title}</h1>}
      {videoId && <div className="youtube-frame"><iframe src={`https://www.youtube-nocookie.com/embed/${videoId}`} title={entry.title} loading="lazy" allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" allowFullScreen /></div>}
      <ArticleBody html={contentHtml} className="social-content" />
      <a className="social-original" href={entry.url} target="_blank" rel="noopener noreferrer">View original <Icon name="external" /></a>
    </div>
  </div>
}

function socialIdentity(entry: Entry): { name: string; meta: string } {
  if (entry.kind === 'youtube') return { name: entry.author || entry.feedTitle, meta: 'YouTube' }
  if (entry.kind === 'threads') {
    const handle = entry.title.match(/^@([^:]+):/)?.[1] || entry.feedTitle.match(/@([^\s)]+)/)?.[1] || ''
    return { name: entry.author || handle || entry.feedTitle, meta: handle ? `@${handle} · Threads` : 'Threads' }
  }
  if (entry.kind === 'x') {
    const author = entry.author.match(/^(.+?)\s*\(@([^)]+)\)\s*$/)
    const handle = author?.[2] || xHandle(entry.url)
    const name = author?.[1] || entry.author || entry.feedTitle.replace(/^Twitter\s+@?/i, '')
    return { name, meta: handle ? `@${handle}` : entry.feedTitle !== name ? entry.feedTitle : '' }
  }
  return { name: entry.feedTitle, meta: entry.author && entry.author !== entry.feedTitle ? entry.author : '' }
}

function xHandle(value: string): string {
  try {
    const url = new URL(value)
    if (!['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com'].includes(url.hostname.toLowerCase())) return ''
    return url.pathname.split('/').filter(Boolean)[0] || ''
  } catch { return '' }
}

function socialNetworkName(kind: Entry['kind']): string {
  const names: Record<Entry['kind'], string> = {
    article: 'Post', x: 'X post', instagram: 'Instagram', threads: 'Threads post', bluesky: 'Bluesky post', mastodon: 'Mastodon post', youtube: 'YouTube',
  }
  return names[kind]
}

function youtubeVideoId(value: string): string {
  try {
    const url = new URL(value)
    if (url.hostname.endsWith('youtu.be')) return url.pathname.split('/').filter(Boolean)[0] || ''
    if (url.pathname.startsWith('/shorts/')) return url.pathname.split('/')[2] || ''
    return url.searchParams.get('v') || ''
  } catch { return '' }
}

function ArticleBody({ html, className = '' }: { html: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const renderedHtml = useRef('')

  useLayoutEffect(() => {
    const root = ref.current
    if (!root || renderedHtml.current === html) return
    root.innerHTML = html
    renderedHtml.current = html
  }, [html])

  useEffect(() => {
    const root = ref.current
    if (!root) return
    const onImageError = (event: Event) => {
      if (event.target instanceof HTMLImageElement) removeBrokenArticleImage(event.target)
    }
    root.addEventListener('error', onImageError, true)
    return () => root.removeEventListener('error', onImageError, true)
  }, [])

  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    const removeAlreadyBrokenImages = () => {
      for (const image of root.querySelectorAll('img')) {
        if (image.complete && image.naturalWidth === 0) removeBrokenArticleImage(image)
      }
    }
    removeAlreadyBrokenImages()
    const frame = window.requestAnimationFrame(removeAlreadyBrokenImages)
    return () => window.cancelAnimationFrame(frame)
  }, [html])

  return <div ref={ref} className={`article-content ${className}`.trim()} />
}

function ArticleHeader({ entry, feedIconUrl }: { entry: Entry; feedIconUrl: string }) {
  return <header className="article-header">
    <p className="article-kicker">{formatDate(entry.publishedAt)} · {entry.readingMinutes} min read</p>
    <h1>{entry.displayTitle || entry.title}</h1>
    {entry.displayTitle && <details className="original-headline" key={entry.id}>
      <summary>Original headline <span>AI-edited title</span></summary>
      <p>{entry.title}</p>
    </details>}
    <div className="article-byline"><FeedMark title={entry.feedTitle} url={entry.feedUrl || entry.url} iconUrl={feedIconUrl} /><div><strong>{entry.feedTitle}</strong>{authorLine(entry.author) && <span>{authorLine(entry.author)}</span>}</div></div>
  </header>
}

function ReaderEmpty({ onCommand }: { onCommand: () => void }) {
  return <div className="reader-empty"><span className="empty-rule" /><h2>Select an article</h2><p>Choose a story from the list, or use J and K.</p><button onClick={onCommand}>Open commands</button></div>
}

function EmptyList({ unreadOnly, onShowAll, query = '', libraryMode = 'stream' }: { unreadOnly: boolean; onShowAll: () => void; query?: string; libraryMode?: string }) {
  if (query) return <div className="list-empty"><h2>No results</h2><p>Try fewer words, a wider date range, or the entire archive.</p></div>
  if (libraryMode !== 'stream') return <div className="list-empty"><h2>{libraryMode === 'recent' ? 'No recent reading yet' : 'No offline articles yet'}</h2><p>{libraryMode === 'recent' ? 'Articles you open will appear here with their reading position.' : 'Open an article and choose Save offline to keep a copy on this device.'}</p></div>
  return <div className="list-empty"><Icon name="check" /><h2>{unreadOnly ? 'You are caught up' : 'No articles here'}</h2><p>{unreadOnly ? 'This stream has no unread articles.' : 'FreshRSS returned no articles for this stream.'}</p>{unreadOnly && <button onClick={onShowAll}>Show all articles</button>}</div>
}

function StorySkeleton() {
  return <>{Array.from({ length: 7 }, (_, index) => <div className="story-row skeleton" key={index}><span className="skeleton-image"/><div><span/><span/><span/></div></div>)}</>
}

function Modal({ title, onClose, children, className = '' }: { title: string; onClose: () => void; children: React.ReactNode; className?: string }) {
  const dialog = useRef<HTMLElement>(null)
  useDialogFocus(dialog)
  useEffect(() => {
    const close = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [onClose])
  return <div className={`modal-backdrop ${className ? `${className}-backdrop` : ''}`} onMouseDown={event => event.target === event.currentTarget && onClose()}><section ref={dialog} tabIndex={-1} className={`modal ${className}`} role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close"><Icon name="close" /></button></header>{children}</section></div>
}

function ReportProblemModal({ entry, onClose, onSaved }: {
  entry: Entry
  onClose: () => void
  onSaved: () => void
}) {
  const [issue, setIssue] = useState<ArticleReport['issue']>(entry.kind === 'article' ? 'content' : 'social')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await api.reportArticle(entry.id, issue, note.trim(), {
        location: window.location.href,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        theme: document.documentElement.dataset.theme || '',
        userAgent: navigator.userAgent.slice(0, 500),
        fullText: entry.fullText,
      })
      onSaved()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Paper could not save this report')
    } finally {
      setBusy(false)
    }
  }

  return <Modal title="Report a problem" onClose={onClose} className="report-modal">
    <form className="report-form" onSubmit={submit}>
      <p className="report-entry-title">{entry.title}</p>
      <label><span>What is wrong?</span><select autoFocus value={issue} onChange={event => setIssue(event.target.value as ArticleReport['issue'])}>
        <option value="content">Missing or broken content</option>
        <option value="media">Image or video problem</option>
        <option value="metadata">Title, author, or feed metadata</option>
        <option value="social">Social post rendering</option>
        <option value="other">Something else</option>
      </select></label>
      <label><span>Note</span><textarea rows={4} value={note} onChange={event => setNote(event.target.value)} placeholder="What did you see?" /></label>
      {error && <p className="form-error">{error}</p>}
      <div className="report-form-actions"><button type="button" onClick={onClose}>Cancel</button><button type="submit" disabled={busy}>{busy ? 'Saving...' : 'Save report'}</button></div>
    </form>
  </Modal>
}

function CommandPalette({ commands, onClose }: { commands: Array<{ label: string; hint: string; run: () => void }>; onClose: () => void }) {
  const [filter, setFilter] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const matches = commands.filter(command => command.label.toLowerCase().includes(filter.toLowerCase()))

  useEffect(() => setSelectedIndex(0), [filter])
  useEffect(() => itemRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' }), [selectedIndex])

  const runCommand = (command: { run: () => void }) => {
    onClose()
    command.run()
  }

  const moveSelection = (direction: 1 | -1) => {
    if (!matches.length) return
    setSelectedIndex(current => (current + direction + matches.length) % matches.length)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const vimDirection = filter === '' && (event.key === 'j' || event.key === 'k')
    if (event.key === 'ArrowDown' || (vimDirection && event.key === 'j')) {
      event.preventDefault()
      moveSelection(1)
    } else if (event.key === 'ArrowUp' || (vimDirection && event.key === 'k')) {
      event.preventDefault()
      moveSelection(-1)
    } else if (event.key === 'Enter' && matches[selectedIndex]) {
      event.preventDefault()
      runCommand(matches[selectedIndex])
    }
  }

  return <Modal title="Commands" onClose={onClose} className="command-modal">
    <div className="command-search"><Icon name="search" /><input autoFocus value={filter} onChange={event => setFilter(event.target.value)} onKeyDown={onKeyDown} placeholder="Type a command" aria-controls="command-list" aria-activedescendant={matches[selectedIndex] ? `paper-command-${selectedIndex}` : undefined} /></div>
    <div className="command-list" id="command-list" role="listbox">{matches.map((command, index) => <button id={`paper-command-${index}`} role="option" aria-selected={index === selectedIndex} ref={element => { itemRefs.current[index] = element }} className={index === selectedIndex ? 'active' : ''} key={command.label} onMouseEnter={() => setSelectedIndex(index)} onClick={() => runCommand(command)}><span>{command.label}</span>{command.hint && <kbd>{command.hint}</kbd>}</button>)}</div>
  </Modal>
}

function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const shortcuts = [
    ['j / ↓', 'Next article'], ['k / ↑', 'Previous article'], ['Ctrl K', 'Open commands'], ['Enter', 'Open selected article'], ['o', 'Open original'], ['b', 'Open original in a background tab'], ['q', 'Save to Readwise'], ['f', 'Fetch full article'], ['m', 'Toggle read'], ['s', 'Toggle star'], ['Shift A', 'Mark this stream read'], ['r', 'Refresh'], ['u / Esc', 'Close article'], ['[', 'Toggle sidebar'], [',', 'Open settings'], ['?', 'Show shortcuts'],
  ]
  return <Modal title="Keyboard shortcuts" onClose={onClose} className="help-modal"><dl>{shortcuts.map(([key, label]) => <div key={key}><dt>{key}</dt><dd>{label}</dd></div>)}</dl></Modal>
}

function Settings({ section, setSection, initialFeedId, navigation, onChanged, onFiltersChanged, notify, onConnectionsChanged, autoRead, setAutoRead, onOpenEntry, onClose }: {
  section: SettingsSection
  setSection: (value: SettingsSection) => void
  initialFeedId: string
  navigation: NavigationPayload | null
  onChanged: () => Promise<NavigationPayload>
  onFiltersChanged: () => Promise<unknown>
  notify: (message: string) => void
  autoRead: boolean
  setAutoRead: (value: boolean) => void
  onConnectionsChanged: () => Promise<void>
  onOpenEntry: (id: string) => void
  onClose: () => void
}) {
  const content = section === 'feeds'
    ? <FeedManager initialFeedId={initialFeedId} navigation={navigation} onChanged={onChanged} notify={notify} />
    : section === 'filters'
      ? <FiltersSettings feeds={uniqueFeeds(navigation)} onChanged={onFiltersChanged} notify={notify} />
      : section === 'reports'
        ? <ReportsSettings onOpenEntry={onOpenEntry} notify={notify} />
        : section === 'activity'
          ? <ActivitySettings />
          : <div className="connections-settings">
            <h3>Reading</h3><label className="reading-preference">Mark articles read<select value={autoRead ? 'automatic' : 'manual'} onChange={event => setAutoRead(event.target.value === 'automatic')}><option value="automatic">After opening for one second</option><option value="manual">Only when I mark them read</option></select></label>
            <ConnectionSettings onChanged={onConnectionsChanged} />
          </div>
  return <Modal title="Settings" onClose={onClose} className="settings-modal">
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings sections">
        <button className={section === 'feeds' ? 'active' : ''} onClick={() => setSection('feeds')}>Feeds</button>
        <button className={section === 'filters' ? 'active' : ''} onClick={() => setSection('filters')}>Filters</button>
        <button className={section === 'reports' ? 'active' : ''} onClick={() => setSection('reports')}>Reports</button>
        <button className={section === 'activity' ? 'active' : ''} onClick={() => setSection('activity')}>Activity</button>
        <button className={section === 'connections' ? 'active' : ''} onClick={() => setSection('connections')}>Reading & connections</button>
      </nav>
      <div className="settings-content">{content}</div>
    </div>
  </Modal>
}

function AppearancePopover({ theme, setTheme, readerFont, setReaderFont, readerSize, setReaderSize, readerSpacing, setReaderSpacing, readerWidth, setReaderWidth, onClose }: {
  theme: string
  setTheme: (value: string) => void
  readerFont: ReaderFont
  setReaderFont: (value: ReaderFont) => void
  readerSize: ReaderSize
  setReaderSize: (value: ReaderSize) => void
  readerSpacing: ReaderSpacing
  setReaderSpacing: (value: ReaderSpacing) => void
  readerWidth: ReaderWidth
  setReaderWidth: (value: ReaderWidth) => void
  onClose: () => void
}) {
  const dialog = useRef<HTMLElement>(null)
  useDialogFocus(dialog)
  useEffect(() => {
    const closeEscape = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', closeEscape)
    return () => window.removeEventListener('keydown', closeEscape)
  }, [onClose])

  return <div className="appearance-layer" onMouseDown={event => event.target === event.currentTarget && onClose()}><section ref={dialog} tabIndex={-1} className="appearance-popover" role="dialog" aria-modal="true" aria-label="Appearance">
    <header><div><h2>Appearance</h2><p>Changes appear in the article behind this panel.</p></div><button className="icon-button" onClick={onClose} aria-label="Close"><Icon name="close" /></button></header>
    <div className="appearance-group">
      <h3>Theme</h3>
      <ChoiceRow values={['light', 'dark', 'system', 'e-ink']} active={theme} onChange={setTheme} />
    </div>
    <div className="appearance-group">
      <h3>Reading type</h3>
      <div className="font-choices">
        <button className={`font-choice literata ${readerFont === 'literata' ? 'active' : ''}`} onClick={() => setReaderFont('literata')}><span>Literata</span><small>Serif text for long articles.</small></button>
        <button className={`font-choice source ${readerFont === 'source' ? 'active' : ''}`} onClick={() => setReaderFont('source')}><span>Source Sans 3</span><small>A tighter sans serif option.</small></button>
      </div>
      <ReadingChoice label="Size" values={['small', 'medium', 'large']} active={readerSize} onChange={value => setReaderSize(value as ReaderSize)} />
      <ReadingChoice label="Line spacing" values={['compact', 'comfortable', 'spacious']} active={readerSpacing} onChange={value => setReaderSpacing(value as ReaderSpacing)} />
      <ReadingChoice label="Column" values={['narrow', 'standard', 'wide']} active={readerWidth} onChange={value => setReaderWidth(value as ReaderWidth)} />
    </div>
  </section></div>
}

function ChoiceRow({ values, active, onChange }: { values: string[]; active: string; onChange: (value: string) => void }) {
  return <div className="choice-row">{values.map(value => <button key={value} className={active === value ? 'active' : ''} onClick={() => onChange(value)}>{value}</button>)}</div>
}

function ReadingChoice({ label, values, active, onChange }: { label: string; values: string[]; active: string; onChange: (value: string) => void }) {
  return <div className="reading-choice"><span>{label}</span><ChoiceRow values={values} active={active} onChange={onChange} /></div>
}


function FeedManager({ initialFeedId, navigation, onChanged, notify }: {
  initialFeedId: string
  navigation: NavigationPayload | null
  onChanged: () => Promise<NavigationPayload>
  notify: (message: string) => void
}) {
  const feeds = useMemo(() => uniqueFeeds(navigation), [navigation])
  const folders = useMemo(() => (navigation?.folders || []).map(folder => folder.title), [navigation])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<FeedFilter>('all')
  const [showAdd, setShowAdd] = useState(false)
  const [selectedId, setSelectedId] = useState(initialFeedId)
  const [title, setTitle] = useState('')
  const [folder, setFolder] = useState('')
  const [url, setUrl] = useState('')
  const [newTitle, setNewTitle] = useState('')
  const [newFolder, setNewFolder] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [confirmBulkRemove, setConfirmBulkRemove] = useState(false)
  const [bulkFolder, setBulkFolder] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false)
  const visibleFeeds = feeds.filter(feed => `${feed.title} ${feed.url} ${feed.categories.join(' ')}`.toLowerCase().includes(query.toLowerCase()) && feedMatchesFilter(feed, filter))
  const attentionFeeds = visibleFeeds.filter(feed => feed.broken)
  const normalGroups = groupFeeds(visibleFeeds.filter(feed => !feed.broken), folders)
  const displayFeeds = [...attentionFeeds, ...normalGroups.flatMap(group => group.feeds)]
  const selected = displayFeeds.find(feed => feed.id === selectedId) || displayFeeds[0] || null

  useEffect(() => {
    if (!initialFeedId) return
    setSelectedId(initialFeedId)
    setMobileDetailOpen(true)
  }, [initialFeedId])

  useEffect(() => {
    if (!selected) return
    if (selectedId !== selected.id) setSelectedId(selected.id)
    setTitle(selected.title)
    setFolder(selected.categories[0] || '')
    setConfirmRemove(false)
    setError('')
  }, [selected?.id, selected?.title, selected?.categories.join('|')])

  useEffect(() => {
    setSelectedIds(new Set())
    setConfirmBulkRemove(false)
  }, [filter, query])

  const add = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true); setError('')
    try {
      await api.addFeed(url, newTitle, newFolder)
      await onChanged()
      setUrl(''); setNewTitle(''); setNewFolder('')
      setShowAdd(false)
      notify('Feed added')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'FreshRSS could not add this feed')
    } finally { setBusy(false) }
  }

  const save = async () => {
    if (!selected) return
    setBusy(true); setError('')
    try {
      await api.updateFeed(selected.id, title.trim(), folder.trim(), selected.categories[0] || '')
      await onChanged()
      notify('Feed updated')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'FreshRSS could not update this feed')
    } finally { setBusy(false) }
  }

  const remove = async () => {
    if (!selected) return
    if (!confirmRemove) return setConfirmRemove(true)
    setBusy(true); setError('')
    try {
      await api.removeFeed(selected.id)
      setSelectedId('')
      setMobileDetailOpen(false)
      await onChanged()
      notify('Feed unsubscribed')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'FreshRSS could not remove this feed')
    } finally { setBusy(false) }
  }

  const toggleSelection = (id: string) => {
    setSelectedIds(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setConfirmBulkRemove(false)
  }

  const toggleGroupSelection = (groupFeeds: Feed[]) => {
    setSelectedIds(current => {
      const next = new Set(current)
      const allSelected = groupFeeds.every(feed => next.has(feed.id))
      for (const feed of groupFeeds) allSelected ? next.delete(feed.id) : next.add(feed.id)
      return next
    })
    setConfirmBulkRemove(false)
  }

  const toggleGroup = (title: string) => setCollapsedGroups(current => {
    const next = new Set(current)
    if (next.has(title)) next.delete(title)
    else next.add(title)
    return next
  })

  const bulkMove = async () => {
    if (!selectedIds.size || busy) return
    setBusy(true); setError('')
    const moved: string[] = []
    try {
      for (const id of selectedIds) {
        const feed = feeds.find(item => item.id === id)
        if (!feed) continue
        await api.updateFeed(id, feed.title, bulkFolder.trim(), feed.categories[0] || '')
        moved.push(id)
      }
      notify(`Moved ${moved.length} feeds to ${bulkFolder.trim() || 'Uncategorized'}`)
    } catch (reason) { setError(`${moved.length} feeds moved. ${reason instanceof Error ? reason.message : 'Could not move the remaining feeds'}`) }
    finally {
      setSelectedIds(current => new Set([...current].filter(id => !moved.includes(id))))
      try { await onChanged() } catch { setError('Changes were saved. Refresh the feed list to update it.') }
      setBusy(false)
    }
  }

  const bulkRemove = async () => {
    if (!selectedIds.size) return
    if (!confirmBulkRemove) return setConfirmBulkRemove(true)
    setBusy(true); setError('')
    try {
      for (const id of selectedIds) { await api.removeFeed(id); setSelectedIds(current => new Set([...current].filter(item => item !== id))) }
      const count = selectedIds.size
      setSelectedIds(new Set())
      setSelectedId('')
      setMobileDetailOpen(false)
      setConfirmBulkRemove(false)
      await onChanged()
      notify(`${count} ${count === 1 ? 'feed' : 'feeds'} unsubscribed`)
    } catch (reason) {
      await onChanged().catch(() => undefined)
      setError(reason instanceof Error ? reason.message : 'FreshRSS could not remove the remaining feeds')
    } finally { setBusy(false) }
  }

  const selectFeed = (id: string) => {
    setSelectedId(id)
    setMobileDetailOpen(true)
  }

  return <div className={`feed-manager ${mobileDetailOpen ? 'mobile-details-open' : ''}`}>
    <header className="feed-manager-heading"><div><h3>Feeds</h3><p>Feeds are grouped by their FreshRSS folders. Paper only calls out feeds that FreshRSS cannot update.</p></div><button className="primary" onClick={() => setShowAdd(value => !value)}><Icon name={showAdd ? 'close' : 'plus'} />{showAdd ? 'Cancel' : 'Add feed'}</button></header>
    {showAdd && <form className="feed-add-form" onSubmit={add}>
      <label><span>Feed or website URL</span><input autoFocus type="url" required placeholder="https://example.com/feed.xml" value={url} onChange={event => setUrl(event.target.value)} /></label>
      <label><span>Title, optional</span><input value={newTitle} onChange={event => setNewTitle(event.target.value)} /></label>
      <label><span>Folder, optional</span><input list="paper-feed-folders" value={newFolder} onChange={event => setNewFolder(event.target.value)} /></label>
      <button type="submit" disabled={busy}>{busy ? 'Working...' : 'Add feed'}</button>
    </form>}
    <datalist id="paper-feed-folders">{folders.map(name => <option value={name} key={name} />)}</datalist>
    <div className="feed-manager-tools">
      <label className="feed-search"><Icon name="search" /><input placeholder="Find a feed" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="feed-filters" role="group" aria-label="Feed filter">
        {([['all', 'All'], ['attention', `Needs attention${feeds.some(feed => feed.broken) ? ` (${feeds.filter(feed => feed.broken).length})` : ''}`], ['3m', '3 to 6 months'], ['6m', '6 to 12 months'], ['1y', '1+ year']] as Array<[FeedFilter, string]>).map(([value, label]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}
      </div>
    </div>
    {selectedIds.size > 0 && <div className="feed-bulk-bar"><span>{selectedIds.size} selected</span><label>Move to<input list="paper-feed-folders" value={bulkFolder} placeholder="Uncategorized" onChange={event => setBulkFolder(event.target.value)} /></label><button disabled={busy} onClick={() => void bulkMove()}>Move selected</button><button onClick={() => { setSelectedIds(new Set()); setConfirmBulkRemove(false) }}>Clear</button><button className={confirmBulkRemove ? 'danger confirming' : 'danger'} onClick={() => void bulkRemove()} disabled={busy}>{confirmBulkRemove ? `Confirm unsubscribe ${selectedIds.size}` : `Unsubscribe ${selectedIds.size}`}</button></div>}
    <div className="feed-manager-grid">
      <section className="feed-manager-list">
        <div className="feed-group-scroll">
          {attentionFeeds.length > 0 && <FeedGroup title="Needs attention" feeds={attentionFeeds} selectedId={selected?.id || ''} selectedIds={selectedIds} onSelect={selectFeed} onToggleSelection={toggleSelection} onToggleGroupSelection={toggleGroupSelection} collapsed={collapsedGroups.has('Needs attention')} onToggleCollapsed={() => toggleGroup('Needs attention')} attention />}
          {normalGroups.map(group => <FeedGroup key={group.title} title={group.title} feeds={group.feeds} selectedId={selected?.id || ''} selectedIds={selectedIds} onSelect={selectFeed} onToggleSelection={toggleSelection} onToggleGroupSelection={toggleGroupSelection} collapsed={collapsedGroups.has(group.title)} onToggleCollapsed={() => toggleGroup(group.title)} />)}
          {!visibleFeeds.length && <div className="feed-list-empty">No feeds match this filter.</div>}
        </div>
      </section>
      <section className="feed-editor">
        {selected ? <>
          <button className="feed-editor-back" onClick={() => setMobileDetailOpen(false)}><Icon name="back" /> Back to feeds</button>
          <div className="feed-editor-heading"><FeedMark title={selected.title} url={selected.siteUrl || selected.url} iconUrl={selected.iconUrl} /><div><strong>{selected.title}</strong><span>{selected.url}</span></div></div>
          {selected.broken && <div className="feed-health-alert"><strong>FreshRSS cannot update this feed</strong><span>{selected.lastErrorAt ? `Last failed ${relativeDate(selected.lastErrorAt)}.` : 'The latest fetch failed.'}{selected.lastCheckedAt ? ` Last successful check ${relativeDate(selected.lastCheckedAt)}.` : ''}</span></div>}
          {!selected.broken && <p className="feed-last-post">{selected.lastPublishedAt ? `Last post ${formatFeedDate(selected.lastPublishedAt)}` : 'No posts have arrived yet'}</p>}
          <label><span>Title</span><input value={title} onChange={event => setTitle(event.target.value)} /></label>
          <label><span>Folder</span><input list="paper-feed-folders" placeholder="Uncategorized" value={folder} onChange={event => setFolder(event.target.value)} /></label>
          <p className="feed-editor-note">Clear the folder to move this feed to Uncategorized. Enter a new name to create a folder.</p>
          <FeedRepair key={selected.id} feed={selected} onChanged={onChanged} />
          <button className="copy-feed-url" onClick={() => void navigator.clipboard.writeText(selected.url).then(() => notify('Feed URL copied'))}>Copy feed URL</button>
          <div className="feed-editor-actions"><button className="primary" onClick={() => void save()} disabled={busy || !title.trim()}>Save changes</button><button className={confirmRemove ? 'danger confirming' : 'danger'} onClick={() => void remove()} disabled={busy}>{confirmRemove ? 'Confirm unsubscribe' : 'Unsubscribe'}</button></div>
        </> : <div className="feed-editor-empty">No feeds match this search.</div>}
        {error && <p className="form-error">{error}</p>}
      </section>
    </div>
  </div>
}

function FeedGroup({ title, feeds, selectedId, selectedIds, onSelect, onToggleSelection, onToggleGroupSelection, collapsed, onToggleCollapsed, attention = false }: {
  title: string
  feeds: Feed[]
  selectedId: string
  selectedIds: Set<string>
  onSelect: (id: string) => void
  onToggleSelection: (id: string) => void
  onToggleGroupSelection: (feeds: Feed[]) => void
  collapsed: boolean
  onToggleCollapsed: () => void
  attention?: boolean
}) {
  const allSelected = feeds.every(feed => selectedIds.has(feed.id))
  return <section className={`feed-folder-group ${attention ? 'attention' : ''}`}>
    <header className="feed-group-header">
      <button className="feed-group-collapse" onClick={onToggleCollapsed} aria-expanded={!collapsed}><Icon name="chevron" className={collapsed ? '' : 'rotated'} /><span>{title}</span><b>{feeds.length}</b></button>
      <button className="feed-group-select" onClick={() => onToggleGroupSelection(feeds)}>{allSelected ? 'Clear' : 'Select all'}</button>
    </header>
    {!collapsed && feeds.map(feed => <div key={feed.id} className={`feed-item-row ${selectedId === feed.id ? 'active' : ''}`}>
      <label className="feed-select"><input type="checkbox" checked={selectedIds.has(feed.id)} onChange={() => onToggleSelection(feed.id)} aria-label={`Select ${feed.title}`} /></label>
      <button className="feed-item-open" onClick={() => onSelect(feed.id)}>
        <FeedMark title={feed.title} url={feed.siteUrl || feed.url} iconUrl={feed.iconUrl} />
        <span><strong>{feed.title}</strong><small>{feed.broken ? `${feed.lastErrorAt ? `Failed ${relativeDate(feed.lastErrorAt)}` : 'Update failed'}${feed.lastCheckedAt ? ` · Last good check ${relativeDate(feed.lastCheckedAt)}` : ''}` : feed.lastPublishedAt ? `Last post ${formatFeedDate(feed.lastPublishedAt)}` : 'No posts yet'}</small></span>
        {feed.unread > 0 && <b>{feed.unread}</b>}
      </button>
    </div>)}
  </section>
}

function groupFeeds(feeds: Feed[], folderOrder: string[]): Array<{ title: string; feeds: Feed[] }> {
  const groups = new Map<string, Feed[]>()
  for (const feed of feeds) {
    const title = feed.categories[0] || 'Uncategorized'
    groups.set(title, [...(groups.get(title) || []), feed])
  }
  const order = new Map([...folderOrder, 'Uncategorized'].map((name, index) => [name, index]))
  return [...groups.entries()]
    .map(([title, items]) => ({ title, feeds: items.sort((a, b) => a.title.localeCompare(b.title)) }))
    .sort((a, b) => (order.get(a.title) ?? 10_000) - (order.get(b.title) ?? 10_000) || a.title.localeCompare(b.title))
}

function formatFeedDate(value: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value))
}

function relativeDate(value: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 60_000))
  if (minutes < 2) return 'just now'
  if (minutes < 60) return `${minutes} minutes ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  const days = Math.round(hours / 24)
  return `${days} ${days === 1 ? 'day' : 'days'} ago`
}

function streamUnreadCount(navigation: NavigationPayload | null, stream: StreamRef): number | null {
  if (!navigation) return null
  if (stream.kind === 'all') return navigation.unread
  if (stream.kind === 'category') return navigation.folders.find(folder => folder.id === stream.id)?.unread ?? null
  if (stream.kind === 'feed') return uniqueFeeds(navigation).find(feed => feed.id === stream.id)?.unread ?? null
  return null
}

function uniqueFeeds(navigation: NavigationPayload | null): Feed[] {
  const byId = new Map<string, Feed>()
  for (const folder of navigation?.folders || []) for (const feed of folder.feeds) byId.set(feed.id, feed)
  for (const feed of navigation?.uncategorized || []) byId.set(feed.id, feed)
  return [...byId.values()].sort((a, b) => a.title.localeCompare(b.title))
}

function relativeTime(timestamp: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function storedChoice<T extends string>(key: string, choices: readonly T[], fallback: T): T {
  const value = localStorage.getItem(key) as T | null
  return value && choices.includes(value) ? value : fallback
}
