import { afterEach, describe, expect, it } from 'vitest'
import { CategoryDigestService, digestWindowStart, fallbackDigest, findFolder, renderDigest, validateDigest } from '../src/server/category-digest.js'
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
      entries: new Map([[a.id, a]]), now: NOW, since: new Date(NOW.getTime() - 86_400_000), language: 'Dutch', timeZone: 'Europe/Amsterdam', usedAi: true,
    })
    expect(rendered.subject).toBe('Gaming dagoverzicht | maandag 9 november')
    expect(rendered.html).toContain('Game &lt;A&gt;')
    expect(rendered.html).toContain('href="https://games.example/a"')
    expect(rendered.text).toContain('https://games.example/a')
  })

  it('labels developing stories with a link and earlier coverage', () => {
    const a = entry('a', 'Patch 2', 1)
    const stories = new Map([['s1', { id: 's1', title: 'Orion launch', scope: 'The Orion launch.', previousDigests: [],
      earlier: [{ title: 'Orion delayed', source: 'Game Site', url: 'https://games.example/old', publishedAt: '2026-11-07T10:00:00Z', development: '' }] }]])
    const rendered = renderDigest({
      category: 'Gaming', selection: { intro: '', items: [{ headline: 'Patch', summary: 'Sum', entryIds: ['a'], storyId: 's1' }] },
      entries: new Map([[a.id, a]]), now: NOW, since: new Date(NOW.getTime() - 86_400_000), language: 'Dutch', timeZone: 'Europe/Amsterdam',
      usedAi: true, stories, publicUrl: 'http://paper.test',
    })
    expect(rendered.html).toContain('Lopend verhaal')
    expect(rendered.html).toContain('href="http://paper.test/?view=pulse&amp;collection=s1"')
    expect(rendered.html).toContain('Eerder in dit verhaal')
    expect(rendered.html).toContain('href="https://games.example/old"')
    expect(rendered.text).toContain('[Lopend verhaal: Orion launch]')
  })

  it('explains the fallback list in the chosen language', () => {
    expect(fallbackDigest([entry('a', 'A', 1)], 'English', 'disabled').intro).toMatch(/AI is off/)
    expect(fallbackDigest([entry('a', 'A', 1)], 'Dutch', 'failed').intro).toMatch(/niet gelukt/)
  })
})

describe('digest window', () => {
  it('starts the first digest a fixed number of hours back', () => {
    expect(digestWindowStart('', NOW, 24, 48).toISOString()).toBe('2026-11-08T07:00:00.000Z')
  })

  it('continues from the previous cutoff, capped at the maximum', () => {
    expect(digestWindowStart('2026-11-08T20:00:00Z', NOW, 24, 48).toISOString()).toBe('2026-11-08T20:00:00.000Z')
    expect(digestWindowStart('2026-11-01T07:00:00Z', NOW, 24, 48).toISOString()).toBe('2026-11-07T07:00:00.000Z')
  })
})

describe('story validation', () => {
  it('keeps a proposed story only when a cited article belongs to it', () => {
    const entries = new Map([entry('a', 'A', 1), entry('b', 'B', 1)].map(item => [item.id, item]))
    const storyOf = new Map([['a', 's1']])
    const result = validateDigest({ intro: '', items: [
      { headline: 'One', summary: '', entryIds: ['a'], storyId: 'made-up' },
      { headline: 'Two', summary: '', entryIds: ['b'], storyId: 's1' },
    ] }, entries, storyOf)
    expect(result.items[0].storyId).toBe('s1')
    expect(result.items[1].storyId).toBeUndefined()
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

  it('continues where the previous digest ended so articles do not repeat', async () => {
    const db = database()
    const items = [entry('a', 'Morning', 20), entry('b', 'Evening', 5)]
    const service = new CategoryDigestService(config(false), db, source(items))
    await service.generate('Gaming', { now: new Date(NOW.getTime() - 10 * 3_600_000) })
    const second = await service.generate('Gaming', { now: NOW })
    expect(db.entryIdsForBriefing(second!.id)).toEqual(['b'])
    expect(await service.generate('Gaming', { now: new Date(NOW.getTime() + 60_000) })).toBeNull()
  })

  it('includes late articles by fetch time even with an older publication date', async () => {
    const db = database()
    db.setSyncValue('digest_cutoff:user/-/label/Gaming', new Date(NOW.getTime() - 3_600_000).toISOString())
    const late = { ...entry('late', 'Late', 30), crawledAt: NOW.getTime() - 600_000 }
    const service = new CategoryDigestService(config(false), db, source([late, entry('seen', 'Seen', 2)]))
    const record = await service.generate('Gaming', { now: NOW })
    expect(db.entryIdsForBriefing(record!.id)).toEqual(['late'])
  })

  it('does not move the starting point for a test run', async () => {
    const db = database()
    const service = new CategoryDigestService(config(false), db, source([entry('a', 'A', 2)]))
    await service.generate('Gaming', { now: NOW, advance: false })
    expect(db.getSyncValue('digest_cutoff:user/-/label/Gaming')).toBe('')
  })

  it('gives the model developing stories with earlier coverage', async () => {
    const db = database()
    const old = [entry('o1', 'Orion announced', 72), entry('o2', 'Orion delayed', 60), entry('o3', 'Orion preview', 50)]
    const fresh = entry('n1', 'Orion patch notes', 2)
    db.upsertEntries([...old, fresh])
    db.savePulseBatch([{ id: 'orion', headline: 'Orion launch', scope: 'The Orion launch.', entryIds: [...old, fresh].map(item => item.id) }], [], NOW.toISOString())
    let input: { articles: Array<{ id: string; storyId: string }>; stories: Array<{ id: string; earlier: Array<{ title: string }> }> } | null = null
    const service = new CategoryDigestService(config(true), db, source([...old, fresh]), async (_instruction, value) => {
      input = value as typeof input
      return { intro: '', items: [{ headline: 'Patch', summary: 'Nieuw.', entryIds: ['n1'], storyId: 'orion' }] }
    })
    const record = await service.generate('Gaming', { now: NOW })
    expect(input!.articles).toEqual([expect.objectContaining({ id: 'n1', storyId: 'orion' })])
    expect(input!.stories[0].earlier.map(item => item.title)).toEqual(['Orion preview', 'Orion delayed', 'Orion announced'])
    expect(record!.selection.news[0].collectionId).toBe('orion')
    expect(record!.html).toContain('Lopend verhaal')
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
