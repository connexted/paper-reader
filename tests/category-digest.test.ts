import { afterEach, describe, expect, it } from 'vitest'
import { CategoryDigestService, fallbackDigest, findFolder, renderDigest, validateDigest } from '../src/server/category-digest.js'
import type { Config } from '../src/server/config.js'
import { PaperDatabase } from '../src/server/db.js'
import type { EntrySource } from '../src/server/repository.js'
import type { Entry, Folder, StreamRef } from '../src/server/types.js'

const NOW = new Date('2026-11-09T07:00:00Z')
const databases: PaperDatabase[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close?.() })

function entry(id: string, title: string, hoursAgo: number, feedTitle = 'Game Site'): Entry {
  const timestamp = NOW.getTime() - hoursAgo * 3_600_000
  return {
    id, title, url: `https://games.example/${id}`, feedId: 'feed/1', feedTitle, feedUrl: 'https://games.example/feed',
    author: '', contentHtml: `<p>${title} body text.</p>`, excerpt: `${title} excerpt`, publishedAt: new Date(timestamp).toISOString(),
    timestamp, read: false, starred: false, readingMinutes: 1, thumbnailUrl: '', kind: 'article',
  }
}

const folders: Folder[] = [
  { id: 'user/-/label/Gaming', title: 'Gaming', unread: 3, feeds: [] },
  { id: 'user/-/label/Tech', title: 'Tech', unread: 1, feeds: [] },
]

function source(items: Entry[], seen: StreamRef[] = []): EntrySource {
  return {
    navigation: async () => ({ unread: items.length, starred: 0, folders, uncategorized: [] }),
    entries: async (stream, options) => {
      seen.push(stream)
      return items.filter(item => !options?.after || item.timestamp >= options.after.getTime())
    },
    entriesPage: async () => ({ items: [], continuation: '' }),
    entry: async id => items.find(item => item.id === id) || null,
    entryIds: async () => items.map(item => item.id),
  }
}

function config(aiOn: boolean): Config {
  return {
    timeZone: 'Europe/Amsterdam',
    ai: { discussionEnabled: true, briefingsEnabled: aiOn },
    codex: { enabled: aiOn, editorModel: 'test-model' },
    openCode: { enabled: false, editorModel: 'test-model' },
  } as unknown as Config
}

function database() {
  const db = new PaperDatabase(':memory:')
  databases.push(db)
  return db
}

describe('folder lookup', () => {
  it('matches folder titles case-insensitively', () => {
    expect(findFolder(folders, 'gaming').id).toBe('user/-/label/Gaming')
  })

  it('lists available folders when the name is unknown', () => {
    expect(() => findFolder(folders, 'Sports')).toThrow(/Available folders: Gaming, Tech/)
  })
})

describe('digest validation', () => {
  const entries = new Map([entry('a', 'Game A', 1), entry('b', 'Game B', 2)].map(item => [item.id, item]))

  it('drops unknown entry ids and items without sources', () => {
    const result = validateDigest({
      intro: 'Day — summary',
      items: [
        { headline: 'Real', summary: 'Ok', entryIds: ['a', 'missing', 'a'] },
        { headline: 'Invented', summary: 'No source', entryIds: ['nope'] },
      ],
    }, entries)
    expect(result.items).toEqual([{ headline: 'Real', summary: 'Ok', entryIds: ['a'] }])
    expect(result.intro).toBe('Day, summary')
  })

  it('tolerates malformed model output', () => {
    expect(validateDigest('nonsense', entries)).toEqual({ intro: '', items: [] })
  })
})

describe('digest rendering', () => {
  it('renders a Dutch subject, escaped headlines and source links', () => {
    const a = entry('a', 'Game <A>', 1)
    const rendered = renderDigest({
      category: 'Gaming', selection: { intro: 'Intro', items: [{ headline: 'Game <A>', summary: 'Sum', entryIds: ['a'] }] },
      entries: new Map([[a.id, a]]), now: NOW, hours: 24, language: 'Dutch', timeZone: 'Europe/Amsterdam', usedAi: true,
    })
    expect(rendered.subject).toBe('Gaming dagoverzicht | maandag 9 november')
    expect(rendered.html).toContain('Game &lt;A&gt;')
    expect(rendered.html).toContain('href="https://games.example/a"')
    expect(rendered.text).toContain('https://games.example/a')
  })

  it('explains the fallback list in the chosen language', () => {
    expect(fallbackDigest([entry('a', 'A', 1)], 'English', 'disabled').intro).toMatch(/AI is off/)
    expect(fallbackDigest([entry('a', 'A', 1)], 'Dutch', 'failed').intro).toMatch(/niet gelukt/)
  })
})

describe('category digest service', () => {
  it('summarizes only the chosen folder within the time window and stores a digest', async () => {
    const db = database()
    const seen: StreamRef[] = []
    let modelInput: { articles: Array<{ id: string }> } | null = null
    const service = new CategoryDigestService(config(true), db, source([entry('a', 'Fresh', 2), entry('old', 'Stale', 30)], seen), async (_instruction, input) => {
      modelInput = input as { articles: Array<{ id: string }> }
      return { intro: 'Een rustige dag.', items: [{ headline: 'Fresh nieuws', summary: 'Samenvatting.', entryIds: ['a'] }] }
    })
    const record = await service.generate('Gaming', { now: NOW })
    expect(seen[0]).toEqual({ kind: 'category', id: 'user/-/label/Gaming', title: 'Gaming' })
    expect(modelInput!.articles.map(item => item.id)).toEqual(['a'])
    expect(record?.kind).toBe('digest')
    expect(db.getBriefing(record!.id)?.html).toContain('Fresh nieuws')
    expect(db.entryIdsForBriefing(record!.id)).toEqual(['a'])
    // Digests must not count as delivered briefings.
    expect(db.lastDeliveredCutoff()).toBeNull()
    expect(db.surfacedEntryIds().size).toBe(0)
  })

  it('falls back to a headline list when the model fails', async () => {
    const db = database()
    const service = new CategoryDigestService(config(true), db, source([entry('a', 'Fresh', 2)]), async () => { throw new Error('offline') })
    const record = await service.generate('Gaming', { now: NOW })
    expect(record?.html).toContain('niet gelukt')
    expect(record?.html).toContain('Fresh')
  })

  it('does not call the model when AI is off', async () => {
    const db = database()
    let called = false
    const service = new CategoryDigestService(config(false), db, source([entry('a', 'Fresh', 2)]), async () => { called = true; return {} })
    const record = await service.generate('Gaming', { now: NOW })
    expect(called).toBe(false)
    expect(record?.html).toContain('AI staat uit')
  })

  it('stores nothing when the folder has no new articles', async () => {
    const db = database()
    const service = new CategoryDigestService(config(true), db, source([entry('old', 'Stale', 30)]), async () => ({}))
    expect(await service.generate('Gaming', { now: NOW })).toBeNull()
    expect(db.listBriefings()).toHaveLength(0)
  })
})
