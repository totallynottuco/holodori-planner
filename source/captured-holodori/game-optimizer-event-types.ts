export interface GameOptimizerEventChapter {
  number: number
  title: string
  startTime: number
  characterId: string
  songId: string
}

export interface GameOptimizerEvent {
  id: string
  name: string
  startTime?: number
  dateLabel?: string
  archiveTime?: number
  songIds: string[]
  chapters: GameOptimizerEventChapter[]
}

const epoch = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) &&
  value >= Date.UTC(2026, 0, 1) && value < Date.UTC(2100, 0, 1)
const label = (value: unknown, limit: number): value is string => typeof value === 'string' &&
  value.trim().length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value)

export function validateGameOptimizerEvents(value: unknown, songs: ReadonlySet<string>): GameOptimizerEvent[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 200) throw Error('Invalid Mobile event metadata.')
  const seen = new Set<string>()
  for (const event of value) {
    if (!event || !/^marathon_event-(?:normal|relay)-\d{3}$/.test(event.id) || seen.has(event.id) || !label(event.name, 180) ||
      !Array.isArray(event.chapters) || event.chapters.length > 20 ||
      !Array.isArray(event.songIds) || event.songIds.length !== event.chapters.length ||
      new Set(event.songIds).size !== event.songIds.length) throw Error('Invalid Mobile event metadata.')
    seen.add(event.id)
    if (event.id.startsWith('marathon_event-normal-')) {
      if (event.startTime !== undefined || event.archiveTime !== undefined || event.chapters.length ||
        typeof event.dateLabel !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(event.dateLabel) ||
        !epoch(Date.parse(event.dateLabel)) || new Date(event.dateLabel).toISOString().slice(0, 10) !== event.dateLabel)
        throw Error('Invalid Mobile event date metadata.')
      continue
    }
    if (!epoch(event.startTime) || !event.chapters.length) throw Error('Invalid Mobile event schedule metadata.')
    let last = event.startTime - 1
    for (const [index, chapter] of event.chapters.entries()) {
      if (!chapter || chapter.number !== index + 1 || !label(chapter.title, 180) || !epoch(chapter.startTime) ||
        chapter.startTime <= last || index === 0 && chapter.startTime !== event.startTime ||
        !/^chr-\d{5}$/.test(chapter.characterId) || !/^m\d{4}$/.test(chapter.songId) ||
        chapter.songId !== event.songIds[index] || !songs.has(chapter.songId)) throw Error('Invalid Mobile event chapter metadata.')
      last = chapter.startTime
    }
    if (event.archiveTime !== undefined && (!epoch(event.archiveTime) || event.archiveTime <= last))
      throw Error('Invalid Mobile event archive metadata.')
  }
  return value
}
