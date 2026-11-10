// Usage: node dist-server/digest-cli.js <Folder> [--hours 24] [--max-hours 48] [--language Dutch] [--test]
// Each run continues where the previous digest for the folder ended. --test
// builds a digest without moving that starting point.
import { CategoryDigestService } from './category-digest.js'
import { loadConfig } from './config.js'
import { ConnectionSettings } from './connections.js'
import { PaperDatabase } from './db.js'
import { FreshRssClient } from './freshrss.js'
import { PaperRepository } from './repository.js'

const args = process.argv.slice(2)
const option = (name: string) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}
const flags = new Set(['--test'])
const category = args.find((value, index) => !value.startsWith('--') && !(args[index - 1]?.startsWith('--') && !flags.has(args[index - 1])))
if (!category) {
  console.error('Usage: digest-cli <Folder> [--hours 24] [--max-hours 48] [--language Dutch] [--test]')
  process.exit(2)
}

const config = loadConfig()
new ConnectionSettings(config)
const database = new PaperDatabase(config.databasePath)
const freshRss = new FreshRssClient(config.freshRss, config.trustedFeedOrigins)
const entries = config.sync.localReads && database.getSyncValue('backfill_complete') === 'true' ? new PaperRepository(database) : freshRss
const service = new CategoryDigestService(config, database, entries)
const result = await service.generate(category, {
  hours: Number(option('hours')) || 24,
  maxHours: Number(option('max-hours')) || 48,
  language: option('language'),
  advance: !args.includes('--test'),
})
console.log(JSON.stringify(result
  ? { id: result.id, subject: result.subject, entryCount: database.entryIdsForBriefing(result.id).length }
  : { id: null, message: `No new articles in ${category}` }))
