export type StreamKind = 'all' | 'starred' | 'category' | 'feed'

export interface StreamRef {
  kind: StreamKind
  id: string
  title: string
}

export interface Feed {
  id: string
  title: string
  url: string
  siteUrl: string
  iconUrl: string
  categories: string[]
  unread: number
  lastPublishedAt: string | null
  lastCheckedAt: string | null
  lastErrorAt: string | null
  broken: boolean
}

export interface Folder {
  id: string
  title: string
  unread: number
  feeds: Feed[]
}

export interface NavigationPayload {
  unread: number
  starred: number
  folders: Folder[]
  uncategorized: Feed[]
}

export interface Entry {
  searchExcerpt?: string
  readingPosition?: number
  lastReadAt?: string
  readwiseSavedAt?: string
  displayTitle?: string
  id: string
  feedId: string
  feedTitle: string
  feedUrl: string
  title: string
  author: string
  url: string
  contentHtml: string
  excerpt: string
  publishedAt: string
  timestamp: number
  crawledAt?: number
  read: boolean
  starred: boolean
  readingMinutes: number
  thumbnailUrl: string
  kind: 'article' | 'x' | 'instagram' | 'threads' | 'bluesky' | 'mastodon' | 'youtube'
  fullText?: boolean
}

export interface EntryPage {
  order?: 'newest' | 'oldest'
  items: Entry[]
  continuation: string
}

export interface BriefingSummary {
  id: string
  kind: 'morning' | 'evening' | 'digest'
  subject: string
  status: 'generated' | 'delivered' | 'acknowledged' | string
  windowStart: string
  cutoff: string
  createdAt: string
  deliveredAt: string | null
  acknowledgedAt: string | null
  feedback: 'useful' | 'too_broad' | 'missed' | null
  entryCount: number
}

export interface BriefingDetail extends BriefingSummary {
  html: string
  text: string
}

export interface TopicSource {
  id: string
  feedId: string
  read: boolean
  publication: string
  domain: string
  title: string
  url: string
  author: string
  publishedAt: string
  timestamp: number
  thumbnailUrl: string
}

export interface Topic {
  id: string
  kind: 'event' | 'coverage'
  headline: string
  summary: string
  publicationCount: number
  articleCount: number
  firstPublishedAt: string
  lastPublishedAt: string
  imageUrl: string
  sources: TopicSource[]
}

export interface TopicsPayload {
  generatedAt: string
  windowHours: number
  minimumPublications: number
  topics: Topic[]
}

export interface ActivityRecord {
  id: number
  occurredAt: string
  kind: 'sync' | 'state' | 'feed' | 'report' | 'filter' | 'pulse'
  origin: string
  summary: string
  count: number
  details: Record<string, unknown>
}

export interface MuteFilter {
  id: string
  phrase: string
  scope: 'title' | 'content' | 'any'
  feedId: string
  feedTitle: string
  matchCount: number
  createdAt: string
}

export interface ArticleReport {
  id: string
  entryId: string
  entryTitle: string
  feedTitle: string
  issue: 'content' | 'media' | 'metadata' | 'social' | 'other'
  note: string
  snapshot: Record<string, unknown>
  status: 'open' | 'resolved'
  createdAt: string
  resolvedAt: string | null
}

export interface CoverageFeedback {
  id: string
  action: 'not_same' | 'not_useful' | 'merge'
  clusterId: string
  entryId: string
  targetClusterId: string
  createdAt: string
}

export interface FullArticle {
  url: string
  title: string
  byline: string
  excerpt: string
  contentHtml: string
  readingMinutes: number
  fetchedAt: string
  cached: boolean
}

export interface XThreadPost {
  id: string
  url: string
  author: string
  contentHtml: string
  publishedAt: string
}
