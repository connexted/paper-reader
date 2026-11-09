import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { normalizeFeedContent, normalizeFeedThumbnail } from './feed-content.js'
import { isEditorialLinkedFeed } from './freshrss.js'
import { decodeHtmlText, excerpt, plainText, readingMinutes } from './text.js'
import type { BriefingSelection, Entry, Feed, Folder, NavigationPayload, StreamRef } from './types.js'
import type { Topic } from './topics.js'
import type { PulseCollection, PulseSource } from '../shared/pulse.js'
import type { Discussion } from '../shared/discussion.js'

export interface BriefingRecord {
  id: string
  kind: 'morning' | 'evening' | 'digest'
  windowStart: string
  cutoff: string
  subject: string
  html: string
  text: string
  status: string
  tokenHash: string
  selection: BriefingSelection
  createdAt: string
  deliveredAt: string | null
  acknowledgedAt: string | null
}

export interface ArticleCacheRecord {
  url: string
  title: string
  byline: string
  excerpt: string
  contentHtml: string
  readingMinutes: number
  fetchedAt: string
}

export interface HeadlineRecord {
  fingerprint: string
  displayTitle: string
  status: 'accepted' | 'unchanged' | 'rejected' | 'error'
  attempts: number
  updatedAt: number
}

export interface UndoRecord {
  token: string
  operation: 'read' | 'unread' | 'star' | 'unstar'
  entryIds: string[]
  expiresAt: string
}

export type BriefingFeedback = 'useful' | 'too_broad' | 'missed'

export interface PageOptions {
  unreadOnly?: boolean
  limit?: number
  query?: string
  continuation?: string
  includeMuted?: boolean
  after?: string
  before?: string
}

export interface LocalEntryPage {
  items: Entry[]
  continuation: string
}

export interface SyncStatus {
  enabled: boolean
  running: boolean
  backfillComplete: boolean
  backfillContinuation: string
  entryCount: number
  lastStartedAt: string | null
  lastCompletedAt: string | null
  lastError: string | null
}

export interface DatabaseStorageStatus {
  databaseBytes: number
  walBytes: number
  shmBytes: number
}

export interface SyncAuditRecord {
  completedAt: string
  remoteUnread: number
  localUnreadBefore: number
  localUnreadAfter: number
  newEntries: number
  readToUnread: number
  unreadToRead: number
  readToUnreadIds: string[]
}

export type ActivityKind = 'sync' | 'state' | 'feed' | 'report' | 'filter' | 'pulse'

export interface ActivityRecord {
  id: number
  occurredAt: string
  kind: ActivityKind
  origin: string
  summary: string
  count: number
  details: Record<string, unknown>
}

export type MuteFilterScope = 'title' | 'content' | 'any'

export interface MuteFilterRecord {
  id: string
  phrase: string
  scope: MuteFilterScope
  feedId: string
  feedTitle: string
  matchCount: number
  createdAt: string
}

export type ArticleReportIssue = 'content' | 'media' | 'metadata' | 'social' | 'other'

export interface ArticleReportRecord {
  id: string
  entryId: string
  entryTitle: string
  feedTitle: string
  issue: ArticleReportIssue
  note: string
  snapshot: Record<string, unknown>
  status: 'open' | 'resolved'
  createdAt: string
  resolvedAt: string | null
}

export type CoverageFeedbackAction = 'not_same' | 'not_useful' | 'merge'

export interface CoverageFeedbackRecord {
  id: string
  action: CoverageFeedbackAction
  clusterId: string
  entryId: string
  targetClusterId: string
  createdAt: string
}

export class PaperDatabase {
  private readonly db: DatabaseSync
  private readonly databasePath: string

  constructor(databasePath: string) {
    this.databasePath = databasePath
    fs.mkdirSync(path.dirname(databasePath), { recursive: true })
    this.db = new DatabaseSync(databasePath)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.migrate()
  }

  close() {
    this.db.close()
  }

  discussion(entryId: string): Discussion | null {
    const row = this.db.prepare('SELECT content_json FROM discussions WHERE entry_id = ?').get(entryId)
    return row ? JSON.parse(String(row.content_json)) : null
  }

  saveDiscussion(discussion: Discussion) {
    this.db.prepare('INSERT INTO discussions(entry_id, content_json) VALUES (?, ?) ON CONFLICT(entry_id) DO UPDATE SET content_json=excluded.content_json')
      .run(discussion.entryId, JSON.stringify(discussion))
  }

  deleteDiscussion(entryId: string) {
    this.db.prepare('DELETE FROM discussions WHERE entry_id = ?').run(entryId)
  }

  interruptDiscussions() {
    for (const row of this.db.prepare('SELECT entry_id, content_json FROM discussions').all()) {
      const discussion: Discussion = JSON.parse(String(row.content_json))
      let changed = false
      for (const message of discussion.messages) if (message.status === 'running') {
        message.status = 'error'; message.error = 'Paper restarted before the response finished.'; changed = true
      }
      if (changed) this.saveDiscussion(discussion)
    }
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS discussions (
        entry_id TEXT PRIMARY KEY,
        content_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS briefings (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        window_start TEXT NOT NULL,
        cutoff TEXT NOT NULL,
        subject TEXT NOT NULL,
        html TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        selection_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        acknowledged_at TEXT
      );
      CREATE TABLE IF NOT EXISTS briefing_entries (
        briefing_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        section TEXT NOT NULL,
        PRIMARY KEY (briefing_id, entry_id),
        FOREIGN KEY (briefing_id) REFERENCES briefings(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS briefing_entries_entry_idx ON briefing_entries(entry_id);
      CREATE TABLE IF NOT EXISTS briefing_feedback (
        briefing_id TEXT PRIMARY KEY,
        feedback TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (briefing_id) REFERENCES briefings(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS article_cache (
        url TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        byline TEXT NOT NULL,
        excerpt TEXT NOT NULL,
        content_html TEXT NOT NULL,
        reading_minutes INTEGER NOT NULL,
        fetched_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS undo_actions (
        token TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        entry_ids_json TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS feeds (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        site_url TEXT NOT NULL,
        icon_url TEXT NOT NULL,
        last_published_at TEXT,
        last_checked_at TEXT,
        last_error_at TEXT,
        broken INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        synced_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS folders (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        position INTEGER NOT NULL,
        synced_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS feed_folders (
        feed_id TEXT NOT NULL,
        folder_id TEXT NOT NULL,
        PRIMARY KEY (feed_id, folder_id),
        FOREIGN KEY (feed_id) REFERENCES feeds(id) ON DELETE CASCADE,
        FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        feed_id TEXT NOT NULL,
        feed_title TEXT NOT NULL,
        feed_url TEXT NOT NULL,
        title TEXT NOT NULL,
        author TEXT NOT NULL,
        url TEXT NOT NULL,
        canonical_url TEXT NOT NULL,
        source_domain TEXT NOT NULL,
        content_html TEXT NOT NULL,
        content_text TEXT NOT NULL,
        excerpt TEXT NOT NULL,
        published_at TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        crawled_at INTEGER NOT NULL DEFAULT 0,
        read INTEGER NOT NULL DEFAULT 0,
        starred INTEGER NOT NULL DEFAULT 0,
        reading_minutes INTEGER NOT NULL,
        thumbnail_url TEXT NOT NULL,
        kind TEXT NOT NULL,
        synced_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS entries_published_idx ON entries(timestamp DESC, id DESC);
      CREATE INDEX IF NOT EXISTS entries_url_idx ON entries(url);
      CREATE INDEX IF NOT EXISTS entries_canonical_url_idx ON entries(canonical_url);
      CREATE INDEX IF NOT EXISTS entries_source_published_idx ON entries(source_domain, timestamp DESC);
      CREATE TABLE IF NOT EXISTS headline_cache (
        entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL,
        display_title TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS entries_feed_published_idx ON entries(feed_id, timestamp DESC, id DESC);
      CREATE INDEX IF NOT EXISTS entries_read_published_idx ON entries(read, timestamp DESC, id DESC);
      CREATE INDEX IF NOT EXISTS entries_starred_published_idx ON entries(starred, timestamp DESC, id DESC);
      CREATE INDEX IF NOT EXISTS feed_folders_folder_idx ON feed_folders(folder_id, feed_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
        entry_id UNINDEXED,
        title,
        author,
        feed_title,
        content_text,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS entries_fts_insert AFTER INSERT ON entries BEGIN
        INSERT INTO entries_fts(entry_id, title, author, feed_title, content_text)
        VALUES (new.id, new.title, new.author, new.feed_title, new.content_text);
      END;
      CREATE TRIGGER IF NOT EXISTS entries_fts_delete AFTER DELETE ON entries BEGIN
        DELETE FROM entries_fts WHERE entry_id = old.id;
      END;
      CREATE TRIGGER IF NOT EXISTS entries_fts_update AFTER UPDATE OF title, author, feed_title, content_text ON entries BEGIN
        DELETE FROM entries_fts WHERE entry_id = old.id;
        INSERT INTO entries_fts(entry_id, title, author, feed_title, content_text)
        VALUES (new.id, new.title, new.author, new.feed_title, new.content_text);
      END;
      CREATE TABLE IF NOT EXISTS sync_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_audit (
        completed_at TEXT PRIMARY KEY,
        remote_unread INTEGER NOT NULL,
        local_unread_before INTEGER NOT NULL,
        local_unread_after INTEGER NOT NULL,
        new_entries INTEGER NOT NULL,
        read_to_unread INTEGER NOT NULL,
        unread_to_read INTEGER NOT NULL,
        read_to_unread_ids_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pulse_collections (
        id TEXT PRIMARY KEY,
        headline TEXT NOT NULL,
        scope TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pulse_memberships (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        collection_id TEXT NOT NULL REFERENCES pulse_collections(id) ON DELETE CASCADE,
        entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
        added_at TEXT NOT NULL,
        UNIQUE(collection_id, entry_id)
      );
      CREATE INDEX IF NOT EXISTS pulse_memberships_entry_idx ON pulse_memberships(entry_id);
      CREATE TABLE IF NOT EXISTS pulse_scanned (
        entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
        scanned_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pulse_visits (
        collection_id TEXT PRIMARY KEY REFERENCES pulse_collections(id) ON DELETE CASCADE,
        seen_through INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS coverage_clusters (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        headline TEXT NOT NULL,
        summary TEXT NOT NULL,
        first_published_at TEXT NOT NULL,
        last_published_at TEXT NOT NULL,
        image_url TEXT NOT NULL,
        generated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS coverage_cluster_entries (
        cluster_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (cluster_id, entry_id),
        FOREIGN KEY (cluster_id) REFERENCES coverage_clusters(id) ON DELETE CASCADE,
        FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS coverage_cluster_entries_entry_idx ON coverage_cluster_entries(entry_id, cluster_id);
      CREATE INDEX IF NOT EXISTS coverage_clusters_latest_idx ON coverage_clusters(last_published_at DESC);
      CREATE TABLE IF NOT EXISTS activity_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        origin TEXT NOT NULL,
        summary TEXT NOT NULL,
        event_count INTEGER NOT NULL DEFAULT 0,
        details_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS activity_events_time_idx ON activity_events(occurred_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS mute_filters (
        id TEXT PRIMARY KEY,
        phrase TEXT NOT NULL,
        scope TEXT NOT NULL,
        feed_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS muted_entries (
        filter_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        PRIMARY KEY (filter_id, entry_id),
        FOREIGN KEY (filter_id) REFERENCES mute_filters(id) ON DELETE CASCADE,
        FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS muted_entries_entry_idx ON muted_entries(entry_id, filter_id);
      CREATE TABLE IF NOT EXISTS article_reports (
        id TEXT PRIMARY KEY,
        entry_id TEXT NOT NULL,
        issue TEXT NOT NULL,
        note TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS article_reports_status_idx ON article_reports(status, created_at DESC);
      CREATE TABLE IF NOT EXISTS coverage_feedback (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        cluster_id TEXT NOT NULL,
        entry_id TEXT NOT NULL DEFAULT '',
        target_cluster_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS coverage_feedback_cluster_idx ON coverage_feedback(cluster_id, created_at DESC);
    `)
    this.ensureColumn('entries', 'crawled_at', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('entries', 'full_content_text', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('entries', 'first_seen_at', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('pulse_memberships', 'development', "TEXT NOT NULL DEFAULT ''")
    this.db.exec(`CREATE INDEX IF NOT EXISTS entries_first_seen_idx ON entries(first_seen_at);
      CREATE TABLE IF NOT EXISTS briefing_considered (entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE, considered_at INTEGER NOT NULL);`)

    const updateSearchTrigger = `
      CREATE TRIGGER entries_fts_update AFTER UPDATE OF title, author, feed_title, content_text, full_content_text ON entries BEGIN
        DELETE FROM entries_fts WHERE entry_id = old.id;
        INSERT INTO entries_fts(entry_id, title, author, feed_title, content_text)
        VALUES (new.id, new.title, new.author, new.feed_title, new.content_text || ' ' || new.full_content_text);
      END;
    `
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reading_progress (entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE, position REAL NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS readwise_saves (url TEXT PRIMARY KEY, saved_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS search_pages (id TEXT PRIMARY KEY, scope TEXT NOT NULL, ids_json TEXT NOT NULL, created_at INTEGER NOT NULL);
      DROP TRIGGER IF EXISTS entries_fts_insert;
      DROP TRIGGER IF EXISTS entries_fts_update;
      CREATE TRIGGER entries_fts_insert AFTER INSERT ON entries BEGIN
        INSERT INTO entries_fts(entry_id, title, author, feed_title, content_text)
        VALUES (new.id, new.title, new.author, new.feed_title, new.content_text || ' ' || new.full_content_text);
      END;
      ${updateSearchTrigger}
    `)
    if (this.getSyncValue('fulltext_search_v1') !== 'true') {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        // Replace affected search rows together instead of scanning FTS for every cached article.
        this.db.exec('DROP TRIGGER entries_fts_update')
        const update = this.db.prepare('UPDATE entries SET full_content_text = ? WHERE url = ? OR canonical_url = ?')
        for (const article of this.db.prepare('SELECT url, content_html FROM article_cache').iterate()) update.run(plainText(String(article.content_html)), article.url, normalizeUrl(String(article.url)))
        this.db.exec(`
          DELETE FROM entries_fts WHERE rowid IN (
            SELECT entries_fts.rowid FROM entries_fts JOIN entries ON entries.id = entries_fts.entry_id
            WHERE entries.full_content_text != ''
          );
          INSERT INTO entries_fts(entry_id, title, author, feed_title, content_text)
            SELECT id, title, author, feed_title, content_text || ' ' || full_content_text
            FROM entries WHERE full_content_text != '';
          ${updateSearchTrigger}
        `)
        this.setSyncValueInTransaction('fulltext_search_v1', 'true')
        this.db.exec('COMMIT')
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
    }
    this.db.exec('PRAGMA user_version = 6;')
  }

  replaceNavigation(navigation: NavigationPayload) {
    const now = new Date().toISOString()
    const feeds = uniqueFeeds(navigation)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('UPDATE feeds SET active = 0, synced_at = ?').run(now)
      const upsertFeed = this.db.prepare(`
        INSERT INTO feeds (
          id, title, url, site_url, icon_url, last_published_at, last_checked_at,
          last_error_at, broken, active, synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          url = excluded.url,
          site_url = excluded.site_url,
          icon_url = excluded.icon_url,
          last_published_at = excluded.last_published_at,
          last_checked_at = excluded.last_checked_at,
          last_error_at = excluded.last_error_at,
          broken = excluded.broken,
          active = 1,
          synced_at = excluded.synced_at
      `)
      for (const feed of feeds.values()) {
        upsertFeed.run(
          feed.id, feed.title, feed.url, feed.siteUrl, feed.iconUrl, feed.lastPublishedAt,
          feed.lastCheckedAt, feed.lastErrorAt, feed.broken ? 1 : 0, now,
        )
      }

      this.db.prepare('DELETE FROM feed_folders').run()
      this.db.prepare('DELETE FROM folders').run()
      const insertFolder = this.db.prepare('INSERT INTO folders (id, title, position, synced_at) VALUES (?, ?, ?, ?)')
      const insertMembership = this.db.prepare('INSERT OR IGNORE INTO feed_folders (feed_id, folder_id) VALUES (?, ?)')
      navigation.folders.forEach((folder, position) => {
        insertFolder.run(folder.id, folder.title, position, now)
        for (const feed of folder.feeds) insertMembership.run(feed.id, folder.id)
      })
      this.setSyncValueInTransaction('navigation_synced_at', now)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  upsertEntries(entries: Entry[]) {
    if (!entries.length) return
    const now = new Date().toISOString()
    const statement = this.db.prepare(`
      INSERT INTO entries (
        id, feed_id, feed_title, feed_url, title, author, url, canonical_url,
        source_domain, content_html, content_text, excerpt, published_at, timestamp,
        crawled_at, read, starred, reading_minutes, thumbnail_url, kind, synced_at, first_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        feed_id = excluded.feed_id,
        feed_title = excluded.feed_title,
        feed_url = excluded.feed_url,
        title = excluded.title,
        author = excluded.author,
        full_content_text = CASE WHEN entries.url = excluded.url THEN entries.full_content_text ELSE '' END,
        url = excluded.url,
        canonical_url = excluded.canonical_url,
        source_domain = excluded.source_domain,
        content_html = excluded.content_html,
        content_text = excluded.content_text,
        excerpt = excluded.excerpt,
        published_at = excluded.published_at,
        timestamp = excluded.timestamp,
        crawled_at = excluded.crawled_at,
        read = entries.read,
        starred = entries.starred,
        reading_minutes = excluded.reading_minutes,
        thumbnail_url = excluded.thumbnail_url,
        kind = excluded.kind,
        synced_at = excluded.synced_at
    `)
    const muteRules = this.db.prepare('SELECT id, phrase, scope, feed_id FROM mute_filters').all() as Array<{ id: string; phrase: string; scope: MuteFilterScope; feed_id: string }>
    const clearMuteMatches = this.db.prepare('DELETE FROM muted_entries WHERE entry_id = ?')
    const addMuteMatch = this.db.prepare('INSERT OR IGNORE INTO muted_entries (filter_id, entry_id) VALUES (?, ?)')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const entry of entries) {
        const canonicalUrl = normalizeUrl(entry.url)
        statement.run(
          entry.id, entry.feedId, entry.feedTitle, entry.feedUrl, entry.title, entry.author,
          entry.url, canonicalUrl, sourceDomain(canonicalUrl || entry.feedUrl), entry.contentHtml,
          plainText(entry.contentHtml), entry.excerpt, entry.publishedAt, entry.timestamp,
          entry.crawledAt || entry.timestamp,
          entry.read ? 1 : 0, entry.starred ? 1 : 0, entry.readingMinutes,
          entry.thumbnailUrl, entry.kind, now, Date.parse(now),
        )
        const cached = this.getArticle(entry.url)
        if (cached) this.db.prepare('UPDATE entries SET full_content_text = ? WHERE id = ?').run(plainText(cached.contentHtml), entry.id)
        clearMuteMatches.run(entry.id)
        for (const rule of muteRules) {
          if (entryMatchesMuteFilter(entry, rule)) addMuteMatch.run(rule.id, entry.id)
        }
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  reconcileEntryState(unreadIds: string[], starredIds: string[]) {
    this.db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS incoming_unread (id TEXT PRIMARY KEY) WITHOUT ROWID;
      CREATE TEMP TABLE IF NOT EXISTS incoming_starred (id TEXT PRIMARY KEY) WITHOUT ROWID;
    `)
    const addUnread = this.db.prepare('INSERT OR IGNORE INTO incoming_unread (id) VALUES (?)')
    const addStarred = this.db.prepare('INSERT OR IGNORE INTO incoming_starred (id) VALUES (?)')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM incoming_unread').run()
      this.db.prepare('DELETE FROM incoming_starred').run()
      for (const id of unreadIds) addUnread.run(id)
      for (const id of starredIds) addStarred.run(id)
      const readToUnreadRows = this.db.prepare(`SELECT id FROM entries WHERE read = 1 AND EXISTS (SELECT 1 FROM incoming_unread WHERE incoming_unread.id = entries.id)`).all() as Array<{ id: string }>
      const unreadToReadRows = this.db.prepare(`SELECT id FROM entries WHERE read = 0 AND NOT EXISTS (SELECT 1 FROM incoming_unread WHERE incoming_unread.id = entries.id)`).all() as Array<{ id: string }>
      this.db.prepare('UPDATE entries SET read = 1 WHERE read = 0 AND NOT EXISTS (SELECT 1 FROM incoming_unread WHERE incoming_unread.id = entries.id)').run()
      this.db.prepare('UPDATE entries SET read = 0 WHERE read = 1 AND EXISTS (SELECT 1 FROM incoming_unread WHERE incoming_unread.id = entries.id)').run()
      this.db.prepare('UPDATE entries SET starred = 0 WHERE starred = 1 AND NOT EXISTS (SELECT 1 FROM incoming_starred WHERE incoming_starred.id = entries.id)').run()
      this.db.prepare('UPDATE entries SET starred = 1 WHERE starred = 0 AND EXISTS (SELECT 1 FROM incoming_starred WHERE incoming_starred.id = entries.id)').run()
      this.setSyncValueInTransaction('state_synced_at', new Date().toISOString())
      this.db.exec('COMMIT')
      return {
        readToUnread: readToUnreadRows.length,
        unreadToRead: unreadToReadRows.length,
        readToUnreadIds: readToUnreadRows.slice(0, 30).map(row => row.id),
      }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  editLocalEntryState(ids: string[], operation: 'read' | 'unread' | 'star' | 'unstar') {
    if (!ids.length) return
    const column = operation === 'read' || operation === 'unread' ? 'read' : 'starred'
    const value = operation === 'read' || operation === 'star' ? 1 : 0
    const statement = this.db.prepare(`UPDATE entries SET ${column} = ? WHERE id = ?`)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const id of ids) statement.run(value, id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  pulseCandidates(after: number, before: number, scanned: boolean, limit: number): Entry[] {
    const rows = this.db.prepare(`
      SELECT entries.* FROM entries
      WHERE kind = 'article' AND (timestamp >= ? OR first_seen_at >= ?) AND timestamp <= ?
        AND ${scanned ? '' : 'NOT'} EXISTS (SELECT 1 FROM pulse_scanned WHERE entry_id = entries.id)
        AND NOT EXISTS (SELECT 1 FROM pulse_memberships WHERE entry_id = entries.id)
        AND NOT EXISTS (SELECT 1 FROM muted_entries WHERE entry_id = entries.id)
      ORDER BY timestamp DESC, id LIMIT ?
    `).all(after, after, before, limit) as Array<Record<string, string | number>>
    return rows.map(entryFromRow)
  }

  pulseRelatedCandidates(entries: Entry[], now: number, limit = 80): Entry[] {
    const stop = new Set(['with', 'from', 'this', 'that', 'have', 'your', 'about', 'after', 'will', 'more', 'what', 'when', 'news', 'says'])
    const words = [...new Set(entries.flatMap(entry => entry.title.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []))].filter(word => !stop.has(word)).slice(0, 180)
    if (!words.length) return []
    const query = words.map(word => `"${word}"`).join(' OR ')
    const rows = this.db.prepare(`SELECT entries.* FROM entries_fts JOIN entries ON entries.id = entries_fts.entry_id
      WHERE entries_fts MATCH ? AND entries.kind = 'article' AND entries.timestamp >= ? AND entries.timestamp <= ?
      AND EXISTS (SELECT 1 FROM pulse_scanned WHERE entry_id = entries.id)
      AND NOT EXISTS (SELECT 1 FROM pulse_memberships WHERE entry_id = entries.id)
      AND NOT EXISTS (SELECT 1 FROM muted_entries WHERE entry_id = entries.id)
      ORDER BY bm25(entries_fts), entries.timestamp DESC, entries.id LIMIT ?`).all(query, now - 30 * 86_400_000, now + 60_000, limit) as Array<Record<string, string | number>>
    return rows.map(entryFromRow)
  }

  briefingEntries(stream: StreamRef, options: { unreadOnly?: boolean; limit?: number; before: Date }): Entry[] {
    const cutoff = options.before.getTime()
    const clauses = ["entries.timestamp < ?", "entries.first_seen_at <= ?",
      "MAX(entries.timestamp, entries.first_seen_at) >= ?", visibleEntryClause('entries'),
      `NOT EXISTS (SELECT 1 FROM briefing_entries JOIN briefings ON briefings.id = briefing_entries.briefing_id
        WHERE briefing_entries.entry_id = entries.id AND briefings.status IN ('delivered', 'acknowledged'))`]
    const parameters: Array<string | number> = [cutoff, cutoff, cutoff - 7 * 86_400_000]
    if (options.unreadOnly) clauses.push('entries.read = 0')
    if (stream.kind === 'category') {
      clauses.push('EXISTS (SELECT 1 FROM feed_folders WHERE feed_folders.feed_id = entries.feed_id AND feed_folders.folder_id = ?)')
      parameters.push(stream.id)
    }
    const rows = this.db.prepare(`SELECT entries.* FROM entries LEFT JOIN briefing_considered ON briefing_considered.entry_id = entries.id
      WHERE ${clauses.join(' AND ')} ORDER BY COALESCE(briefing_considered.considered_at, 0), MAX(entries.timestamp, entries.first_seen_at) DESC, entries.id
      LIMIT ?`).all(...parameters, options.limit || 1000) as Array<Record<string, string | number>>
    return rows.map(entryFromRow)
  }

  recordBriefingConsidered(ids: string[], at: number) {
    const insert = this.db.prepare('INSERT OR REPLACE INTO briefing_considered(entry_id, considered_at) SELECT id, ? FROM entries WHERE id = ?')
    this.db.exec('BEGIN IMMEDIATE')
    try { for (const id of ids) insert.run(at, id); this.db.exec('COMMIT') }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  previousPulseBriefings(collectionId: string): Array<{ headline: string; summary: string; deliveredAt: string }> {
    const rows = this.db.prepare("SELECT selection_json, delivered_at FROM briefings WHERE status IN ('delivered', 'acknowledged') ORDER BY cutoff DESC LIMIT 30").all()
    return rows.flatMap(row => (JSON.parse(String(row.selection_json)) as BriefingSelection).news
      .filter(item => item.collectionId === collectionId).map(item => ({ headline: item.headline, summary: item.summary, deliveredAt: String(row.delivered_at) }))).slice(0, 3)
  }

  savePulseBatch(groups: Array<{ id: string; headline: string; scope: string; entryIds: string[]; developments?: Record<string, string> }>, scannedIds: string[], now: string) {
    const create = this.db.prepare('INSERT OR IGNORE INTO pulse_collections(id, headline, scope, created_at) VALUES (?, ?, ?, ?)')
    const attach = this.db.prepare(`INSERT OR IGNORE INTO pulse_memberships(collection_id, entry_id, added_at, development)
      SELECT ?, id, ?, ? FROM entries WHERE id = ?
      AND NOT EXISTS (SELECT 1 FROM pulse_memberships WHERE entry_id = entries.id)
      AND NOT EXISTS (SELECT 1 FROM muted_entries WHERE entry_id = entries.id)`)
    const eligible = this.db.prepare(`SELECT id, canonical_url FROM entries WHERE id = ?
      AND NOT EXISTS (SELECT 1 FROM pulse_memberships WHERE entry_id = entries.id)
      AND NOT EXISTS (SELECT 1 FROM muted_entries WHERE entry_id = entries.id)`)
    const exists = this.db.prepare('SELECT 1 FROM pulse_collections WHERE id = ?')
    const scan = this.db.prepare('INSERT OR REPLACE INTO pulse_scanned(entry_id, scanned_at) SELECT id, ? FROM entries WHERE id = ?')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const deferred = new Set<string>()
      for (const group of groups) {
        const urls = new Set<string>()
        const ids = group.entryIds.filter(id => {
          const row = eligible.get(id) as { id: string; canonical_url: string } | undefined
          if (!row || urls.has(row.canonical_url || id)) return false
          urls.add(row.canonical_url || id)
          return true
        })
        if (!exists.get(group.id) && ids.length < 3) { ids.forEach(id => deferred.add(id)); continue }
        create.run(group.id, group.headline, group.scope, now)
        for (const id of ids) attach.run(group.id, now, group.developments?.[id] || '', id)
      }
      for (const id of scannedIds) if (!deferred.has(id)) scan.run(now, id)
      this.setSyncValueInTransaction('pulse_completed_at', now)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  pulseCollections(): PulseCollection[] {
    const rows = this.db.prepare(`SELECT pulse_memberships.collection_id, pulse_memberships.sequence,
      pulse_memberships.added_at, pulse_memberships.development, entries.id, entries.feed_id,
      entries.read, entries.feed_title, entries.title, entries.url, entries.feed_url, entries.author,
      entries.published_at, entries.timestamp, entries.thumbnail_url
      FROM pulse_memberships JOIN entries ON entries.id = pulse_memberships.entry_id
      WHERE NOT EXISTS (SELECT 1 FROM muted_entries WHERE entry_id = entries.id)
      ORDER BY pulse_memberships.sequence DESC`).iterate()
    const sources = new Map<string, PulseSource[]>()
    for (const row of rows) {
      const id = String(row.collection_id)
      const members = sources.get(id) || []
      members.push({ id: String(row.id), feedId: String(row.feed_id), read: Boolean(row.read), publication: decodeHtmlText(String(row.feed_title)),
        domain: sourceDomain(String(row.url)) || sourceDomain(String(row.feed_url)), title: decodeHtmlText(String(row.title)), url: String(row.url),
        author: decodeHtmlText(String(row.author)), publishedAt: String(row.published_at), timestamp: Number(row.timestamp),
        thumbnailUrl: normalizeFeedThumbnail({ url: String(row.url), thumbnailUrl: String(row.thumbnail_url) }),
        isNew: false, sequence: Number(row.sequence), addedAt: String(row.added_at), development: String(row.development || '') })
      sources.set(id, members)
    }
    const collections = this.db.prepare(`SELECT pulse_collections.*, COALESCE(pulse_visits.seen_through, 0) AS seen_through
      FROM pulse_collections LEFT JOIN pulse_visits ON pulse_visits.collection_id = pulse_collections.id`).all()
    return collections.map(row => {
      const members = sources.get(String(row.id)) || []
      return { id: String(row.id), headline: String(row.headline), scope: String(row.scope), createdAt: String(row.created_at),
        updatedAt: members[0]?.addedAt || String(row.created_at), revision: members[0]?.sequence || 0,
        seenThrough: Number(row.seen_through), newCount: 0, unreadCount: 0, publicationCount: 0,
        articleCount: members.length, quiet: false, sources: members.map(source => ({ ...source, isNew: source.sequence > Number(row.seen_through) })) }
    })
  }

  visitPulseCollection(id: string, sequence: number): void {
    // A client sends the revision it displayed, never the current server revision.
    this.db.prepare(`INSERT INTO pulse_visits(collection_id, seen_through) VALUES (?, ?)
      ON CONFLICT(collection_id) DO UPDATE SET seen_through = MAX(seen_through, excluded.seen_through)`).run(id, sequence)
  }

  replaceCoverageIndex(topics: Topic[], generatedAt: string, windowHours: number) {
    const insertCluster = this.db.prepare(`
      INSERT INTO coverage_clusters (
        id, kind, headline, summary, first_published_at, last_published_at, image_url, generated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertEntry = this.db.prepare('INSERT INTO coverage_cluster_entries (cluster_id, entry_id, position) VALUES (?, ?, ?)')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM coverage_clusters').run()
      for (const topic of topics) {
        insertCluster.run(topic.id, topic.kind, topic.headline, topic.summary, topic.firstPublishedAt, topic.lastPublishedAt, topic.imageUrl, generatedAt)
        topic.sources.forEach((source, position) => insertEntry.run(topic.id, source.id, position))
      }
      this.setSyncValueInTransaction('coverage_generated_at', generatedAt)
      this.setSyncValueInTransaction('coverage_window_hours', String(windowHours))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  upsertCoverageClusters(topics: Topic[], generatedAt: string) {
    if (!topics.length) return
    const upsertCluster = this.db.prepare(`
      INSERT INTO coverage_clusters (
        id, kind, headline, summary, first_published_at, last_published_at, image_url, generated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        headline = excluded.headline,
        summary = excluded.summary,
        first_published_at = excluded.first_published_at,
        last_published_at = excluded.last_published_at,
        image_url = excluded.image_url,
        generated_at = excluded.generated_at
    `)
    const deleteEntries = this.db.prepare('DELETE FROM coverage_cluster_entries WHERE cluster_id = ?')
    const insertEntry = this.db.prepare('INSERT INTO coverage_cluster_entries (cluster_id, entry_id, position) VALUES (?, ?, ?)')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const topic of topics) {
        upsertCluster.run(topic.id, topic.kind, topic.headline, topic.summary, topic.firstPublishedAt, topic.lastPublishedAt, topic.imageUrl, generatedAt)
        deleteEntries.run(topic.id)
        topic.sources.forEach((source, position) => insertEntry.run(topic.id, source.id, position))
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  coverageTopics(options: { after: Date; before: Date; eligibleIds?: Set<string> }): Topic[] {
    const clusterRows = this.db.prepare('SELECT * FROM coverage_clusters ORDER BY last_published_at DESC, id').all() as Array<Record<string, string>>
    const memberRows = this.db.prepare(`
      SELECT coverage_cluster_entries.cluster_id, coverage_cluster_entries.position, entries.*
      FROM coverage_cluster_entries
      JOIN entries ON entries.id = coverage_cluster_entries.entry_id
      WHERE NOT EXISTS (SELECT 1 FROM muted_entries WHERE muted_entries.entry_id = entries.id)
      ORDER BY coverage_cluster_entries.cluster_id, coverage_cluster_entries.position
    `).all() as Array<Record<string, string | number>>
    const members = new Map<string, Entry[]>()
    for (const row of memberRows) {
      const id = String(row.cluster_id)
      const entry = entryFromRow(row)
      if (entry.timestamp < options.after.getTime() || entry.timestamp >= options.before.getTime()) continue
      if (options.eligibleIds && !options.eligibleIds.has(entry.id)) continue
      const list = members.get(id) || []
      list.push(entry)
      members.set(id, list)
    }
    return clusterRows.flatMap(row => {
      const entries = members.get(String(row.id)) || []
      if (!entries.length) return []
      const sorted = [...entries].sort((left, right) => right.timestamp - left.timestamp || left.id.localeCompare(right.id))
      const domains = [...new Set(sorted.map(entry => sourceDomain(entry.url) || sourceDomain(entry.feedUrl)).filter(Boolean))]
      if (!domains.length) return []
      const first = sorted.at(-1)!
      return [{
        id: String(row.id),
        kind: row.kind === 'coverage' ? 'coverage' as const : 'event' as const,
        headline: String(row.headline),
        summary: String(row.summary),
        publicationCount: domains.length,
        articleCount: sorted.length,
        firstPublishedAt: first.publishedAt,
        lastPublishedAt: sorted[0].publishedAt,
        imageUrl: sorted.find(entry => entry.thumbnailUrl)?.thumbnailUrl || String(row.image_url),
        sources: sorted.map(entry => ({
          id: entry.id,
          feedId: entry.feedId,
          read: entry.read,
          publication: entry.feedTitle,
          domain: sourceDomain(entry.url) || sourceDomain(entry.feedUrl),
          title: entry.title,
          url: entry.url,
          author: entry.author,
          publishedAt: entry.publishedAt,
          timestamp: entry.timestamp,
          thumbnailUrl: entry.thumbnailUrl,
        })),
      }]
    }).sort((left, right) =>
      right.publicationCount - left.publicationCount
      || Date.parse(right.lastPublishedAt) - Date.parse(left.lastPublishedAt)
      || right.articleCount - left.articleCount)
  }

  localNavigation(includeMuted = false): NavigationPayload {
    const visibleEntries = includeMuted ? '' : 'WHERE NOT EXISTS (SELECT 1 FROM muted_entries WHERE muted_entries.entry_id = entries.id)'
    const feedRows = this.db.prepare(`
      SELECT feeds.*,
        COALESCE(entry_counts.unread, 0) AS unread,
        COALESCE(entry_counts.last_published_at, feeds.last_published_at) AS effective_last_published_at
      FROM feeds
      LEFT JOIN (
        SELECT feed_id,
          SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) AS unread,
          MAX(published_at) AS last_published_at
        FROM entries ${visibleEntries} GROUP BY feed_id
      ) entry_counts ON entry_counts.feed_id = feeds.id
      WHERE feeds.active = 1
      ORDER BY feeds.title COLLATE NOCASE
    `).all() as Array<Record<string, string | number | null>>
    const membershipRows = this.db.prepare('SELECT feed_id, folder_id FROM feed_folders').all() as Array<{ feed_id: string; folder_id: string }>
    const folderRows = this.db.prepare('SELECT id, title FROM folders ORDER BY position, title COLLATE NOCASE').all() as Array<{ id: string; title: string }>
    const folderIdsByFeed = new Map<string, string[]>()
    for (const row of membershipRows) {
      const ids = folderIdsByFeed.get(row.feed_id) || []
      ids.push(row.folder_id)
      folderIdsByFeed.set(row.feed_id, ids)
    }
    const folderTitles = new Map(folderRows.map(row => [row.id, row.title]))
    const feeds = new Map(feedRows.map(row => {
      const categories = (folderIdsByFeed.get(String(row.id)) || []).map(id => folderTitles.get(id) || '').filter(Boolean)
      return [String(row.id), feedFromRow(row, categories)]
    }))
    const folders: Folder[] = folderRows.map(row => {
      const folderFeeds = membershipRows
        .filter(membership => membership.folder_id === row.id)
        .map(membership => feeds.get(membership.feed_id))
        .filter((feed): feed is Feed => Boolean(feed))
        .sort((a, b) => a.title.localeCompare(b.title))
      return { id: row.id, title: row.title, unread: folderFeeds.reduce((sum, feed) => sum + feed.unread, 0), feeds: folderFeeds }
    })
    const uncategorized = [...feeds.values()]
      .filter(feed => !(folderIdsByFeed.get(feed.id) || []).length)
      .sort((a, b) => a.title.localeCompare(b.title))
    const counts = this.db.prepare(`
      SELECT
        SUM(CASE WHEN read = 0 ${includeMuted ? '' : 'AND NOT EXISTS (SELECT 1 FROM muted_entries WHERE muted_entries.entry_id = entries.id)'} THEN 1 ELSE 0 END) AS unread,
        SUM(CASE WHEN starred = 1 THEN 1 ELSE 0 END) AS starred
      FROM entries
    `).get() as { unread: number | null; starred: number | null }
    return { unread: Number(counts.unread || 0), starred: Number(counts.starred || 0), folders, uncategorized }
  }

  private pageScope(stream: StreamRef, options: PageOptions) {
    const clauses: string[] = []
    const parameters: Array<string | number> = []
    if (stream.kind === 'starred') clauses.push('entries.starred = 1')
    if (stream.kind === 'feed') { clauses.push('entries.feed_id = ?'); parameters.push(stream.id) }
    if (stream.kind === 'category') {
      clauses.push('EXISTS (SELECT 1 FROM feed_folders WHERE feed_folders.feed_id = entries.feed_id AND feed_folders.folder_id = ?)')
      parameters.push(stream.id)
    }
    if (options.unreadOnly) clauses.push('entries.read = 0')
    if (!options.includeMuted && stream.kind !== 'starred') clauses.push(visibleEntryClause('entries'))
    for (const [value, comparison] of [[options.after, '>='], [options.before, '<']] as const) {
      if (value) {
        const timestamp = Date.parse(value)
        if (!Number.isFinite(timestamp)) throw new Error('Choose a valid date')
        clauses.push(`entries.timestamp ${comparison} ?`); parameters.push(timestamp)
      }
    }
    const search = ftsQuery(options.query || '')
    const join = search ? 'JOIN entries_fts ON entries_fts.entry_id = entries.id' : ''
    if (search) { clauses.push('entries_fts MATCH ?'); parameters.push(search) }
    return { clauses, parameters, search, join }
  }

  matchingEntryIds(stream: StreamRef, options: PageOptions = {}): string[] {
    const { clauses, parameters, join } = this.pageScope(stream, options)
    return this.db.prepare(`SELECT entries.id FROM entries ${join} ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}`)
      .all(...parameters).map(row => String(row.id))
  }

  syncEntryIds(stream: StreamRef, unreadOnly = false, limit = 80): string[] {
    const { clauses, parameters } = this.pageScope(stream, { unreadOnly, includeMuted: true })
    // FreshRSS's API orders by arrival ID, encoded as fixed-width hexadecimal.
    // Reader pages use publication dates and the user's preferred direction.
    return this.db.prepare(`SELECT entries.id FROM entries ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY entries.id DESC LIMIT ?`)
      .all(...parameters, Math.min(Math.max(limit, 1), 250)).map(row => String(row.id))
  }

  localEntriesPage(stream: StreamRef, options: PageOptions = {}): LocalEntryPage {
    const limit = Math.min(Math.max(options.limit || 80, 1), 250)
    const { clauses, parameters, search, join } = this.pageScope(stream, options)
    const ascending = this.streamOrder(stream) === 'oldest'
    const direction = ascending ? 'ASC' : 'DESC'
    const scope = crypto.createHash('sha256').update(JSON.stringify([stream.kind, stream.id, Boolean(options.unreadOnly), options.query || '', options.after || '', options.before || '', Boolean(options.includeMuted), direction])).digest('hex')
    let cursor: { scope?: string; boundary?: [number, number, string]; snapshot?: string; offset?: number } = {}
    if (options.continuation) {
      try { cursor = JSON.parse(Buffer.from(options.continuation, 'base64url').toString()) } catch { throw new Error('This list changed. Refresh to continue.') }
      if (cursor.scope !== scope) throw new Error('This list changed. Refresh to continue.')
    }
    const encode = (value: object) => Buffer.from(JSON.stringify({ scope, ...value })).toString('base64url')
    const where = () => clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    if (search) {
      // Freeze relevance ordering. Corpus changes can alter BM25 scores between requests.
      this.db.prepare('DELETE FROM search_pages WHERE created_at < ?').run(Date.now() - 3600000)
      let snapshot = cursor.snapshot
      let ids: string[]
      if (snapshot) {
        const row = this.db.prepare('SELECT ids_json FROM search_pages WHERE id = ? AND scope = ?').get(snapshot, scope)
        if (!row) throw new Error('Search expired. Search again to continue.')
        ids = JSON.parse(String(row.ids_json))
      } else {
        ids = this.db.prepare(`SELECT entries.id FROM entries ${join} ${where()} ORDER BY bm25(entries_fts), entries.timestamp ${direction}, entries.crawled_at ${direction}, entries.id ${direction}`).all(...parameters).map(row => String(row.id))
        snapshot = crypto.randomUUID()
        this.db.prepare('INSERT INTO search_pages VALUES (?, ?, ?, ?)').run(snapshot, scope, JSON.stringify(ids), Date.now())
      }
      const eligible = new Set(this.matchingEntryIds(stream, options))
      let offset = Math.max(0, cursor.offset || 0)
      const items: Entry[] = []
      while (offset < ids.length && items.length < limit) {
        const id = ids[offset++]
        if (!eligible.has(id)) continue
        const row = this.db.prepare(`SELECT entries.*, snippet(entries_fts, 4, '', '', '…', 32) AS search_excerpt FROM entries ${join} WHERE entries.id = ? AND entries_fts MATCH ?`).get(id, search)
        if (row) items.push({ ...this.decorateEntry(entryFromRow(row as Record<string, string | number>)), searchExcerpt: String(row.search_excerpt) })
      }
      return { items, continuation: ids.slice(offset).some(id => eligible.has(id)) ? encode({ snapshot, offset }) : '' }
    }
    if (cursor.boundary) {
      if (!Array.isArray(cursor.boundary) || cursor.boundary.length !== 3 || !Number.isFinite(cursor.boundary[0]) || !Number.isFinite(cursor.boundary[1]) || typeof cursor.boundary[2] !== 'string') throw new Error('Invalid article cursor')
      clauses.push(`(entries.timestamp, entries.crawled_at, entries.id) ${ascending ? '>' : '<'} (?, ?, ?)`)
      parameters.push(...cursor.boundary)
    }
    const rows = this.db.prepare(`SELECT entries.* FROM entries ${where()} ORDER BY entries.timestamp ${direction}, entries.crawled_at ${direction}, entries.id ${direction} LIMIT ?`)
      .all(...parameters, limit + 1) as Array<Record<string, string | number>>
    const last = rows[Math.min(limit, rows.length) - 1]
    return { items: rows.slice(0, limit).map(row => this.decorateEntry(entryFromRow(row))), continuation: rows.length > limit ? encode({ boundary: [Number(last.timestamp), Number(last.crawled_at), String(last.id)] }) : '' }
  }

  private decorateEntry(entry: Entry): Entry {
    const progress = this.db.prepare('SELECT position, updated_at FROM reading_progress WHERE entry_id = ?').get(entry.id)
    const saved = this.db.prepare('SELECT saved_at FROM readwise_saves WHERE url = ?').get(entry.url)
    return { ...entry, readingPosition: progress ? Number(progress.position) : undefined, lastReadAt: progress ? String(progress.updated_at) : undefined, readwiseSavedAt: saved ? String(saved.saved_at) : undefined }
  }

  saveReadingProgress(id: string, position: number) {
    if (!this.localEntry(id)) return
    this.db.prepare('INSERT INTO reading_progress VALUES (?, ?, ?) ON CONFLICT(entry_id) DO UPDATE SET position=excluded.position, updated_at=excluded.updated_at')
      .run(id, Math.max(0, Math.min(1, position)), new Date().toISOString())
  }

  recentReading(): Entry[] {
    return this.db.prepare('SELECT entries.* FROM entries JOIN reading_progress ON entry_id = entries.id ORDER BY reading_progress.updated_at DESC LIMIT 100')
      .all().map(row => this.decorateEntry(entryFromRow(row as Record<string, string | number>)))
  }

  recordReadwiseSave(url: string) {
    this.db.prepare('INSERT INTO readwise_saves VALUES (?, ?) ON CONFLICT(url) DO UPDATE SET saved_at=excluded.saved_at').run(url, new Date().toISOString())
  }

  previewMuteFilter(phrase: string, scope: MuteFilterScope, feedId = '') {
    const title = 'instr(lower(title), lower(?)) > 0'
    const content = 'instr(lower(content_text), lower(?)) > 0 OR instr(lower(excerpt), lower(?)) > 0'
    const match = scope === 'title' ? title : scope === 'content' ? content : `${title} OR ${content} OR instr(lower(feed_title), lower(?)) > 0 OR instr(lower(author), lower(?)) > 0`
    const params = Array(scope === 'title' ? 1 : scope === 'content' ? 2 : 5).fill(phrase)
    const where = `WHERE (? = '' OR feed_id = ?) AND (${match})`
    const count = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM entries ${where}`).get(feedId, feedId, ...params)?.count || 0)
    const items = this.db.prepare(`SELECT * FROM entries ${where} ORDER BY timestamp DESC LIMIT 8`).all(feedId, feedId, ...params).map(row => entryFromRow(row as Record<string, string | number>))
    return { count, items }
  }

  localEntries(stream: StreamRef, options: { unreadOnly?: boolean; limit?: number; after?: Date; before?: Date } = {}): Entry[] {
    const clauses: string[] = []
    const parameters: Array<string | number> = []
    if (stream.kind === 'starred') clauses.push('starred = 1')
    if (stream.kind === 'feed') { clauses.push('feed_id = ?'); parameters.push(stream.id) }
    if (stream.kind === 'category') {
      clauses.push('EXISTS (SELECT 1 FROM feed_folders WHERE feed_folders.feed_id = entries.feed_id AND feed_folders.folder_id = ?)')
      parameters.push(stream.id)
    }
    if (options.unreadOnly) clauses.push('read = 0')
    if (stream.kind !== 'starred') clauses.push(visibleEntryClause('entries'))
    if (options.after) { clauses.push('timestamp >= ?'); parameters.push(options.after.getTime()) }
    if (options.before) { clauses.push('timestamp < ?'); parameters.push(options.before.getTime()) }
    const limit = Math.min(Math.max(options.limit || 200, 1), 5000)
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db.prepare(`SELECT * FROM entries ${where} ORDER BY timestamp DESC, id DESC LIMIT ?`)
      .all(...parameters, limit) as Array<Record<string, string | number>>
    return rows.map(entryFromRow)
  }

  localEntry(id: string): Entry | null {
    const row = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as Record<string, string | number> | undefined
    return row ? this.decorateEntry(entryFromRow(row)) : null
  }

  *headlineCandidates(): IterableIterator<Entry> {
    const rows = this.db.prepare(`SELECT id FROM entries
      WHERE source_domain IN ('androidpolice.com', 'www.androidpolice.com', 'androidauthority.com', 'www.androidauthority.com')
      AND (timestamp > ? OR read = 0 OR starred = 1)
      ORDER BY read ASC, timestamp DESC LIMIT 1000
    `).all(Math.floor(Date.now() / 1000) - 7 * 86400)
    // Finish the ID query before yielding so background work can checkpoint WAL.
    const lookup = this.db.prepare('SELECT * FROM entries WHERE id = ?')
    for (const candidate of rows) {
      const row = lookup.get(candidate.id) as Record<string, string | number> | undefined
      if (row) yield entryFromRow(row)
    }
  }

  getHeadline(id: string): HeadlineRecord | null {
    const row = this.db.prepare('SELECT * FROM headline_cache WHERE entry_id = ?').get(id)
    return row ? {
      fingerprint: String(row.fingerprint), displayTitle: String(row.display_title),
      status: String(row.status) as HeadlineRecord['status'], attempts: Number(row.attempts), updatedAt: Number(row.updated_at),
    } : null
  }

  headlineCounts(): Record<string, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS count FROM headline_cache GROUP BY status').all() as Array<{ status: string; count: number }>
    return Object.fromEntries(rows.map(row => [row.status, Number(row.count)]))
  }

  saveHeadline(id: string, record: HeadlineRecord) {
    this.db.prepare(`INSERT INTO headline_cache (entry_id, fingerprint, display_title, status, attempts, updated_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM entries WHERE id = ?)
      ON CONFLICT(entry_id) DO UPDATE SET fingerprint=excluded.fingerprint, display_title=excluded.display_title,
      status=excluded.status, attempts=excluded.attempts, updated_at=excluded.updated_at
    `).run(id, record.fingerprint, record.displayTitle, record.status, record.attempts, record.updatedAt, id)
  }

  localEntryIds(stream: StreamRef, unreadOnly = false, includeMuted = false): string[] {
    const clauses: string[] = []
    const parameters: string[] = []
    if (stream.kind === 'starred') clauses.push('starred = 1')
    if (stream.kind === 'feed') { clauses.push('feed_id = ?'); parameters.push(stream.id) }
    if (stream.kind === 'category') {
      clauses.push('EXISTS (SELECT 1 FROM feed_folders WHERE feed_folders.feed_id = entries.feed_id AND feed_folders.folder_id = ?)')
      parameters.push(stream.id)
    }
    if (unreadOnly) clauses.push('read = 0')
    if (!includeMuted && stream.kind !== 'starred') clauses.push(visibleEntryClause('entries'))
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db.prepare(`SELECT id FROM entries ${where} ORDER BY timestamp DESC`).all(...parameters) as Array<{ id: string }>
    return rows.map(row => row.id)
  }

  localRelativeUnreadEntryIds(
    stream: StreamRef,
    anchorId: string,
    direction: 'above' | 'below',
    options: { unreadOnly?: boolean; query?: string; after?: string; before?: string } = {},
  ): string[] {
    const clauses: string[] = []
    const parameters: Array<string | number> = []
    if (stream.kind === 'starred') clauses.push('entries.starred = 1')
    if (stream.kind === 'feed') {
      clauses.push('entries.feed_id = ?')
      parameters.push(stream.id)
    }
    if (stream.kind === 'category') {
      clauses.push('EXISTS (SELECT 1 FROM feed_folders WHERE feed_folders.feed_id = entries.feed_id AND feed_folders.folder_id = ?)')
      parameters.push(stream.id)
    }
    // The clicked row may already be read but still visible in the client.
    // Keep it as the boundary; only unread candidates are changed below.
    if (options.unreadOnly) {
      clauses.push('(entries.read = 0 OR entries.id = ?)')
      parameters.push(anchorId)
    }
    if (stream.kind !== 'starred') clauses.push(visibleEntryClause('entries'))

    for (const [value, comparison] of [[options.after, '>='], [options.before, '<']] as const) {
      if (value) { const timestamp = Date.parse(value); if (!Number.isFinite(timestamp)) throw new Error('Invalid date'); clauses.push(`entries.timestamp ${comparison} ?`); parameters.push(timestamp) }
    }
    const search = ftsQuery(options.query || '')
    let join = ''
    const directionOrder = this.streamOrder(stream) === 'oldest' ? 'ASC' : 'DESC'
    let order = `entries.timestamp ${directionOrder}, entries.crawled_at ${directionOrder}, entries.id ${directionOrder}`
    if (search) {
      join = 'JOIN entries_fts ON entries_fts.entry_id = entries.id'
      clauses.push('entries_fts MATCH ?')
      parameters.push(search)
      order = `bm25(entries_fts), ${order}`
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db.prepare(`
      SELECT entries.id, entries.read FROM entries ${join} ${where}
      ORDER BY ${order}
    `).all(...parameters) as Array<{ id: string; read: number }>
    const anchorIndex = rows.findIndex(row => row.id === anchorId)
    if (anchorIndex < 0) return []
    const candidates = direction === 'above' ? rows.slice(0, anchorIndex) : rows.slice(anchorIndex + 1)
    return candidates.filter(row => !row.read).map(row => row.id)
  }

  streamOrder(stream: StreamRef): 'newest' | 'oldest' {
    return this.getSyncValue(`stream_order:${stream.kind}:${stream.id}`) === 'oldest' ? 'oldest' : 'newest'
  }

  setStreamOrder(stream: StreamRef, order: 'newest' | 'oldest') {
    this.setSyncValue(`stream_order:${stream.kind}:${stream.id}`, order)
  }

  setSyncValue(key: string, value: string) {
    this.db.prepare(`INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value)
  }

  getSyncValue(key: string): string {
    const row = this.db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as { value?: string } | undefined
    return row?.value || ''
  }

  syncStatus(enabled: boolean, running: boolean): SyncStatus {
    const count = this.entryCount()
    return {
      enabled,
      running,
      backfillComplete: this.getSyncValue('backfill_complete') === 'true',
      backfillContinuation: this.getSyncValue('backfill_continuation'),
      entryCount: count,
      lastStartedAt: this.getSyncValue('last_sync_started_at') || null,
      lastCompletedAt: this.getSyncValue('last_sync_completed_at') || null,
      lastError: this.getSyncValue('last_sync_error') || null,
    }
  }

  entryCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM entries').get() as { count: number }
    return Number(row.count || 0)
  }

  unreadCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM entries WHERE read = 0').get() as { count: number }
    return Number(row.count || 0)
  }

  recordSyncAudit(record: SyncAuditRecord) {
    this.db.prepare(`
      INSERT INTO sync_audit (
        completed_at, remote_unread, local_unread_before, local_unread_after,
        new_entries, read_to_unread, unread_to_read, read_to_unread_ids_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.completedAt,
      record.remoteUnread,
      record.localUnreadBefore,
      record.localUnreadAfter,
      record.newEntries,
      record.readToUnread,
      record.unreadToRead,
      JSON.stringify(record.readToUnreadIds),
    )
    this.db.prepare('DELETE FROM sync_audit WHERE completed_at < ?').run(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
  }

  syncAudit(limit = 100): SyncAuditRecord[] {
    const rows = this.db.prepare('SELECT * FROM sync_audit ORDER BY completed_at DESC LIMIT ?').all(Math.min(Math.max(limit, 1), 500)) as Array<Record<string, string | number>>
    return rows.map(row => ({
      completedAt: String(row.completed_at),
      remoteUnread: Number(row.remote_unread),
      localUnreadBefore: Number(row.local_unread_before),
      localUnreadAfter: Number(row.local_unread_after),
      newEntries: Number(row.new_entries),
      readToUnread: Number(row.read_to_unread),
      unreadToRead: Number(row.unread_to_read),
      readToUnreadIds: JSON.parse(String(row.read_to_unread_ids_json)) as string[],
    }))
  }

  recordActivity(input: {
    kind: ActivityKind
    origin: string
    summary: string
    count?: number
    details?: Record<string, unknown>
    occurredAt?: string
  }): number {
    const occurredAt = input.occurredAt || new Date().toISOString()
    const result = this.db.prepare(`
      INSERT INTO activity_events (occurred_at, kind, origin, summary, event_count, details_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      occurredAt,
      input.kind,
      input.origin.slice(0, 80),
      input.summary.slice(0, 500),
      Math.max(0, Math.round(input.count || 0)),
      JSON.stringify(input.details || {}),
    )
    this.db.prepare('DELETE FROM activity_events WHERE occurred_at < ?').run(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
    this.db.prepare('DELETE FROM activity_events WHERE id NOT IN (SELECT id FROM activity_events ORDER BY id DESC LIMIT 5000)').run()
    return Number(result.lastInsertRowid)
  }

  activity(limit = 100): ActivityRecord[] {
    const rows = this.db.prepare('SELECT * FROM activity_events ORDER BY occurred_at DESC, id DESC LIMIT ?')
      .all(Math.min(Math.max(limit, 1), 500)) as Array<Record<string, string | number>>
    return rows.map(row => ({
      id: Number(row.id),
      occurredAt: String(row.occurred_at),
      kind: String(row.kind) as ActivityKind,
      origin: String(row.origin),
      summary: String(row.summary),
      count: Number(row.event_count),
      details: parseObject(String(row.details_json)),
    }))
  }

  createMuteFilter(phrase: string, scope: MuteFilterScope, feedId = ''): MuteFilterRecord {
    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('INSERT INTO mute_filters (id, phrase, scope, feed_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, phrase, scope, feedId, createdAt)
      const titleMatch = 'instr(lower(entries.title), lower(?)) > 0'
      const contentMatch = 'instr(lower(entries.content_text), lower(?)) > 0 OR instr(lower(entries.excerpt), lower(?)) > 0'
      const anyMatch = `${titleMatch} OR ${contentMatch} OR instr(lower(entries.feed_title), lower(?)) > 0 OR instr(lower(entries.author), lower(?)) > 0`
      const match = scope === 'title' ? titleMatch : scope === 'content' ? contentMatch : anyMatch
      const parameters = scope === 'title' ? [phrase]
        : scope === 'content' ? [phrase, phrase]
        : [phrase, phrase, phrase, phrase, phrase]
      this.db.prepare(`
        INSERT OR IGNORE INTO muted_entries (filter_id, entry_id)
        SELECT ?, entries.id FROM entries
        WHERE (? = '' OR entries.feed_id = ?) AND (${match})
      `).run(id, feedId, feedId, ...parameters)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.muteFilters().find(filter => filter.id === id)!
  }

  muteFilters(): MuteFilterRecord[] {
    const rows = this.db.prepare(`
      SELECT mute_filters.*, COALESCE(feeds.title, '') AS feed_title, COUNT(muted_entries.entry_id) AS match_count
      FROM mute_filters
      LEFT JOIN feeds ON feeds.id = mute_filters.feed_id
      LEFT JOIN muted_entries ON muted_entries.filter_id = mute_filters.id
      GROUP BY mute_filters.id
      ORDER BY mute_filters.created_at DESC
    `).all() as Array<Record<string, string | number>>
    return rows.map(row => ({
      id: String(row.id),
      phrase: String(row.phrase),
      scope: String(row.scope) as MuteFilterScope,
      feedId: String(row.feed_id),
      feedTitle: String(row.feed_title),
      matchCount: Number(row.match_count),
      createdAt: String(row.created_at),
    }))
  }

  deleteMuteFilter(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM mute_filters WHERE id = ?').run(id).changes) > 0
  }

  createArticleReport(input: {
    entry: Entry
    issue: ArticleReportIssue
    note: string
    client: Record<string, unknown>
  }): ArticleReportRecord {
    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    const snapshot = {
      entry: {
        id: input.entry.id,
        feedId: input.entry.feedId,
        feedTitle: input.entry.feedTitle,
        feedUrl: input.entry.feedUrl,
        title: input.entry.title,
        author: input.entry.author,
        url: input.entry.url,
        excerpt: input.entry.excerpt,
        contentHtml: input.entry.contentHtml.slice(0, 100_000),
        publishedAt: input.entry.publishedAt,
        thumbnailUrl: input.entry.thumbnailUrl,
        kind: input.entry.kind,
      },
      client: input.client,
    }
    this.db.prepare(`
      INSERT INTO article_reports (id, entry_id, issue, note, snapshot_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?)
    `).run(id, input.entry.id, input.issue, input.note, JSON.stringify(snapshot), createdAt)
    return this.articleReports().find(report => report.id === id)!
  }

  articleReports(limit = 100): ArticleReportRecord[] {
    const rows = this.db.prepare(`
      SELECT article_reports.*, COALESCE(entries.title, '') AS entry_title, COALESCE(entries.feed_title, '') AS feed_title
      FROM article_reports
      LEFT JOIN entries ON entries.id = article_reports.entry_id
      ORDER BY CASE article_reports.status WHEN 'open' THEN 0 ELSE 1 END, article_reports.created_at DESC
      LIMIT ?
    `).all(Math.min(Math.max(limit, 1), 500)) as Array<Record<string, string | number | null>>
    return rows.map(row => {
      const snapshot = parseObject(String(row.snapshot_json))
      const entry = snapshot.entry && typeof snapshot.entry === 'object' && !Array.isArray(snapshot.entry)
        ? snapshot.entry as Record<string, unknown>
        : {}
      return {
        id: String(row.id),
        entryId: String(row.entry_id),
        entryTitle: String(row.entry_title || entry.title || ''),
        feedTitle: String(row.feed_title || entry.feedTitle || ''),
        issue: String(row.issue) as ArticleReportIssue,
        note: String(row.note),
        snapshot,
        status: row.status === 'resolved' ? 'resolved' : 'open',
        createdAt: String(row.created_at),
        resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
      }
    })
  }

  openArticleReportCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM article_reports WHERE status = 'open'").get() as { count: number }
    return Number(row.count)
  }

  setArticleReportStatus(id: string, status: 'open' | 'resolved'): boolean {
    const resolvedAt = status === 'resolved' ? new Date().toISOString() : null
    return Number(this.db.prepare('UPDATE article_reports SET status = ?, resolved_at = ? WHERE id = ?').run(status, resolvedAt, id).changes) > 0
  }

  createCoverageFeedback(input: {
    action: CoverageFeedbackAction
    clusterId: string
    entryId?: string
    targetClusterId?: string
  }): CoverageFeedbackRecord {
    const record: CoverageFeedbackRecord = {
      id: crypto.randomUUID(),
      action: input.action,
      clusterId: input.clusterId,
      entryId: input.entryId || '',
      targetClusterId: input.targetClusterId || '',
      createdAt: new Date().toISOString(),
    }
    this.db.prepare(`
      INSERT INTO coverage_feedback (id, action, cluster_id, entry_id, target_cluster_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(record.id, record.action, record.clusterId, record.entryId, record.targetClusterId, record.createdAt)
    return record
  }

  coverageFeedback(): CoverageFeedbackRecord[] {
    const rows = this.db.prepare('SELECT * FROM coverage_feedback ORDER BY created_at, rowid').all() as Array<Record<string, string>>
    return rows.map(row => ({
      id: String(row.id),
      action: String(row.action) as CoverageFeedbackAction,
      clusterId: String(row.cluster_id),
      entryId: String(row.entry_id),
      targetClusterId: String(row.target_cluster_id),
      createdAt: String(row.created_at),
    }))
  }

  deleteCoverageFeedback(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM coverage_feedback WHERE id = ?').run(id).changes) > 0
  }

  storageStatus(): DatabaseStorageStatus {
    return {
      databaseBytes: fileSize(this.databasePath),
      walBytes: fileSize(`${this.databasePath}-wal`),
      shmBytes: fileSize(`${this.databasePath}-shm`),
    }
  }

  checkpointWalIfLarge(maxWalBytes = 64 * 1024 * 1024): boolean {
    if (fileSize(`${this.databasePath}-wal`) <= maxWalBytes) return false
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    return true
  }

  private setSyncValueInTransaction(key: string, value: string) {
    this.db.prepare(`INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value)
  }

  private ensureColumn(table: string, column: string, definition: string) {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (!rows.some(row => row.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }

  cachedEntryIds(): string[] {
    return (this.db.prepare(`
      SELECT DISTINCT entries.id
      FROM entries JOIN article_cache ON article_cache.url = entries.url
      ORDER BY entries.id
    `).all() as Array<{ id: string }>).map(row => row.id)
  }

  recentEntryIds(limit = 1000): string[] {
    return (this.db.prepare('SELECT id FROM entries ORDER BY crawled_at DESC, id DESC LIMIT ?').all(limit) as Array<{ id: string }>).map(row => row.id)
  }

  clearArticleCache() {
    this.db.prepare('DELETE FROM article_cache').run()
    this.db.prepare("UPDATE entries SET full_content_text = '' WHERE full_content_text != ''").run()
  }

  getArticle(url: string): ArticleCacheRecord | null {
    try { const key = new URL(url); key.hash = ''; url = key.href } catch { return null }
    const row = this.db.prepare('SELECT * FROM article_cache WHERE url = ?').get(url) as Record<string, string | number> | undefined
    if (!row) return null
    return {
      url: String(row.url),
      title: String(row.title),
      byline: String(row.byline),
      excerpt: String(row.excerpt),
      contentHtml: String(row.content_html),
      readingMinutes: Number(row.reading_minutes),
      fetchedAt: String(row.fetched_at),
    }
  }

  cacheArticle(article: ArticleCacheRecord) {
    this.db.prepare(`
      INSERT INTO article_cache (url, title, byline, excerpt, content_html, reading_minutes, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET
        title = excluded.title,
        byline = excluded.byline,
        excerpt = excluded.excerpt,
        content_html = excluded.content_html,
        reading_minutes = excluded.reading_minutes,
        fetched_at = excluded.fetched_at
    `).run(
      article.url,
      article.title,
      article.byline,
      article.excerpt,
      article.contentHtml,
      article.readingMinutes,
      article.fetchedAt,
    )
    this.db.prepare('UPDATE entries SET full_content_text = ? WHERE url = ? OR canonical_url = ?').run(plainText(article.contentHtml), article.url, normalizeUrl(article.url))
  }

  createUndo(record: UndoRecord) {
    this.db.prepare('DELETE FROM undo_actions WHERE expires_at <= ?').run(new Date().toISOString())
    this.db.prepare('INSERT INTO undo_actions (token, operation, entry_ids_json, expires_at) VALUES (?, ?, ?, ?)')
      .run(record.token, record.operation, JSON.stringify(record.entryIds), record.expiresAt)
  }

  getUndo(token: string): UndoRecord | null {
    const row = this.db.prepare('SELECT * FROM undo_actions WHERE token = ?').get(token) as Record<string, string> | undefined
    if (!row || Date.parse(row.expires_at) <= Date.now()) {
      if (row) this.deleteUndo(token)
      return null
    }
    return {
      token: String(row.token),
      operation: row.operation as UndoRecord['operation'],
      entryIds: JSON.parse(row.entry_ids_json) as string[],
      expiresAt: String(row.expires_at),
    }
  }

  deleteUndo(token: string) {
    this.db.prepare('DELETE FROM undo_actions WHERE token = ?').run(token)
  }

  lastDeliveredCutoff(): string | null {
    const row = this.db.prepare(`
      SELECT cutoff FROM briefings WHERE status IN ('delivered', 'acknowledged')
      ORDER BY cutoff DESC LIMIT 1
    `).get() as { cutoff?: string } | undefined
    return row?.cutoff || null
  }

  surfacedEntryIds(): Set<string> {
    const rows = this.db.prepare(`
      SELECT DISTINCT entry_id FROM briefing_entries
      JOIN briefings ON briefings.id = briefing_entries.briefing_id
      WHERE briefings.status IN ('delivered', 'acknowledged')
    `).all() as Array<{ entry_id: string }>
    return new Set(rows.map(row => row.entry_id))
  }

  recentGeneratedBriefing(kind: 'morning' | 'evening', since: Date): BriefingRecord | null {
    const row = this.db.prepare(`
      SELECT id FROM briefings
      WHERE kind = ? AND status = 'generated' AND created_at >= ?
      ORDER BY created_at DESC LIMIT 1
    `).get(kind, since.toISOString()) as { id?: string } | undefined
    return row?.id ? this.getBriefing(row.id) : null
  }

  createBriefing(record: BriefingRecord, entries: Array<{ id: string; section: string }>) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`
        INSERT INTO briefings (
          id, kind, window_start, cutoff, subject, html, text, status, token_hash,
          selection_json, created_at, delivered_at, acknowledged_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id,
        record.kind,
        record.windowStart,
        record.cutoff,
        record.subject,
        record.html,
        record.text,
        record.status,
        record.tokenHash,
        JSON.stringify(record.selection),
        record.createdAt,
        record.deliveredAt,
        record.acknowledgedAt,
      )
      const insert = this.db.prepare('INSERT OR IGNORE INTO briefing_entries (briefing_id, entry_id, section) VALUES (?, ?, ?)')
      for (const entry of entries) insert.run(record.id, entry.id, entry.section)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getBriefing(id: string): BriefingRecord | null {
    const row = this.db.prepare('SELECT * FROM briefings WHERE id = ?').get(id) as Record<string, string | null> | undefined
    if (!row) return null
    return {
      id: String(row.id),
      kind: row.kind as BriefingRecord['kind'],
      windowStart: String(row.window_start),
      cutoff: String(row.cutoff),
      subject: String(row.subject),
      html: String(row.html),
      text: String(row.text),
      status: String(row.status),
      tokenHash: String(row.token_hash),
      selection: JSON.parse(String(row.selection_json)) as BriefingSelection,
      createdAt: String(row.created_at),
      deliveredAt: row.delivered_at,
      acknowledgedAt: row.acknowledged_at,
    }
  }

  listBriefings(limit = 50): BriefingRecord[] {
    const rows = this.db.prepare('SELECT id FROM briefings ORDER BY created_at DESC LIMIT ?').all(Math.min(Math.max(limit, 1), 100)) as Array<{ id: string }>
    return rows.map(row => this.getBriefing(row.id)).filter((briefing): briefing is BriefingRecord => Boolean(briefing))
  }

  entryIdsForBriefing(id: string): string[] {
    const rows = this.db.prepare('SELECT entry_id FROM briefing_entries WHERE briefing_id = ?').all(id) as Array<{ entry_id: string }>
    return rows.map(row => row.entry_id)
  }

  markDelivered(id: string) {
    this.db.prepare("UPDATE briefings SET status = 'delivered', delivered_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id)
  }

  markAcknowledged(id: string) {
    this.db.prepare("UPDATE briefings SET status = 'acknowledged', acknowledged_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id)
  }

  setBriefingFeedback(id: string, feedback: BriefingFeedback) {
    this.db.prepare(`
      INSERT INTO briefing_feedback (briefing_id, feedback, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(briefing_id) DO UPDATE SET feedback = excluded.feedback, created_at = excluded.created_at
    `).run(id, feedback, new Date().toISOString())
  }

  getBriefingFeedback(id: string): BriefingFeedback | null {
    const row = this.db.prepare('SELECT feedback FROM briefing_feedback WHERE briefing_id = ?').get(id) as { feedback?: BriefingFeedback } | undefined
    return row?.feedback || null
  }

  recentBriefingFeedback(limit = 8): Array<{ kind: string; subject: string; feedback: BriefingFeedback; createdAt: string }> {
    const rows = this.db.prepare(`
      SELECT briefings.kind, briefings.subject, briefing_feedback.feedback, briefing_feedback.created_at
      FROM briefing_feedback
      JOIN briefings ON briefings.id = briefing_feedback.briefing_id
      ORDER BY briefing_feedback.created_at DESC
      LIMIT ?
    `).all(Math.min(Math.max(limit, 1), 20)) as Array<{ kind: string; subject: string; feedback: BriefingFeedback; created_at: string }>
    return rows.map(row => ({ kind: row.kind, subject: row.subject, feedback: row.feedback, createdAt: row.created_at }))
  }
}

function uniqueFeeds(navigation: NavigationPayload): Map<string, Feed> {
  const feeds = new Map<string, Feed>()
  for (const folder of navigation.folders) {
    for (const feed of folder.feeds) feeds.set(feed.id, feed)
  }
  for (const feed of navigation.uncategorized) feeds.set(feed.id, feed)
  return feeds
}

function feedFromRow(row: Record<string, string | number | null>, categories: string[]): Feed {
  return {
    id: String(row.id),
    title: decodeHtmlText(String(row.title)),
    url: String(row.url),
    siteUrl: String(row.site_url),
    iconUrl: String(row.icon_url),
    categories,
    unread: Number(row.unread || 0),
    lastPublishedAt: row.effective_last_published_at ? String(row.effective_last_published_at) : null,
    lastCheckedAt: row.last_checked_at ? String(row.last_checked_at) : null,
    lastErrorAt: row.last_error_at ? String(row.last_error_at) : null,
    broken: Boolean(row.broken),
  }
}

function entryFromRow(row: Record<string, string | number>): Entry {
  const url = String(row.url)
  const feedTitle = decodeHtmlText(String(row.feed_title))
  const storedContentHtml = String(row.content_html)
  const contentHtml = normalizeFeedContent({ contentHtml: storedContentHtml, feedTitle, url, title: decodeHtmlText(String(row.title)) })
  const contentChanged = contentHtml !== storedContentHtml.trim()
  return {
    id: String(row.id),
    feedId: String(row.feed_id),
    feedTitle,
    feedUrl: String(row.feed_url),
    title: decodeHtmlText(String(row.title)),
    author: decodeHtmlText(String(row.author)),
    url,
    contentHtml,
    excerpt: contentChanged ? excerpt(contentHtml) : decodeHtmlText(String(row.excerpt)),
    publishedAt: String(row.published_at),
    timestamp: Number(row.timestamp),
    crawledAt: Number(row.crawled_at || row.timestamp),
    read: Boolean(row.read),
    starred: Boolean(row.starred),
    readingMinutes: contentChanged ? readingMinutes(contentHtml) : Number(row.reading_minutes),
    thumbnailUrl: normalizeFeedThumbnail({ url, thumbnailUrl: String(row.thumbnail_url), contentHtml, originalContentHtml: storedContentHtml }),
    kind: isEditorialLinkedFeed(String(row.feed_url)) ? 'article' : String(row.kind) as Entry['kind'],
  }
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) url.searchParams.delete(key)
    }
    return url.toString()
  } catch {
    return value
  }
}

function sourceDomain(value: string): string {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, '') } catch { return '' }
}

function visibleEntryClause(alias: string): string {
  return `NOT EXISTS (SELECT 1 FROM muted_entries WHERE muted_entries.entry_id = ${alias}.id)`
}

function entryMatchesMuteFilter(entry: Entry, rule: { phrase: string; scope: MuteFilterScope; feed_id: string }): boolean {
  if (rule.feed_id && rule.feed_id !== entry.feedId) return false
  const phrase = rule.phrase.toLocaleLowerCase()
  if (!phrase) return false
  const title = entry.title.toLocaleLowerCase()
  const content = `${entry.excerpt}\n${plainText(entry.contentHtml)}`.toLocaleLowerCase()
  if (rule.scope === 'title') return title.includes(phrase)
  if (rule.scope === 'content') return content.includes(phrase)
  return `${title}\n${entry.feedTitle}\n${entry.author}\n${content}`.toLocaleLowerCase().includes(phrase)
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function ftsQuery(value: string): string {
  return value.trim().split(/\s+/).filter(Boolean)
    .map(term => `"${term.replace(/"/g, '""')}"*`)
    .join(' AND ')
}

function encodeOffset(offset: number): string {
  return `local:${Buffer.from(String(offset)).toString('base64url')}`
}

function decodeOffset(value: string): number {
  if (!value.startsWith('local:')) return 0
  const decoded = Number(Buffer.from(value.slice(6), 'base64url').toString('utf8'))
  return Number.isFinite(decoded) ? decoded : 0
}

function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size
  } catch {
    return 0
  }
}
