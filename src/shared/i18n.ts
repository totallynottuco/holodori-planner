const en = {
  'nav.planner': 'Planner',
  'nav.cards': 'Cards',
  'nav.inventory': 'Inventory',
  'nav.settings': 'Settings',
  'app.name': 'holodori Planner',
  'attribute.cute': 'Cute',
  'attribute.pure': 'Pure',
  'attribute.happy': 'Happy',
  'resource.lessonPoints': 'Lesson Pt',
  'resource.hologold': 'Hologold',
  'resource.hololium': 'Hololium',
  'resource.bloomStones': 'Bloom Stones',
  'resource.bloomPoints': 'Card Bloom Points',
  'resource.cuteBeads': 'Cute Beads',
  'resource.cuteCrystals': 'Cute Crystals',
  'resource.pureBeads': 'Pure Beads',
  'resource.pureCrystals': 'Pure Crystals',
  'resource.happyBeads': 'Happy Beads',
  'resource.happyCrystals': 'Happy Crystals'
} as const

export type TranslationKey = keyof typeof en
export const t = (key: TranslationKey): string => en[key]
