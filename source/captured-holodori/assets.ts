import { game } from './game';
import { capturedIcons } from '../hololive/seelie-capture/icons';

const transparent = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/%3E';
const cache = new Map<string,string>();
function svg(name:keyof typeof capturedIcons) {
  const icon = capturedIcons[name];
  const color = name==='mdi-progress-check'?'#00b6ee':name==='heroicons-solid-star'?'#a78bfa':name==='heroicons-solid-view-grid'?'#f97316':'#dbe5f5';
  const attrs = Object.entries(icon.attributes).filter(([key])=>!['width','height','xmlns'].includes(key)).map(([key,value])=>`${key}="${String(value).replaceAll('currentColor',color)}"`).join(' ');
  const body = icon.elements.map(element=>`<${element.tag} ${Object.entries(element.attributes).map(([key,value])=>`${key}="${String(value).replaceAll('currentColor',color)}"`).join(' ')}/>`).join('');
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`)}`;
}
export const neutralIcons = {
  level: svg('mdi-progress-check'),
  trace: svg('heroicons-solid-star'),
  artwork: svg('heroicons-solid-view-grid'),
  ascension: svg('heroicons-solid-chevron-double-right'),
  all: svg('sidebar-inventory'),
  empty: svg('heroicons-solid-search'),
};
const extraInventoryIcons:Record<string,string>={
  construction:'/assets/achievements/groups/img_achieve_icon_quest.webp',
};
/** The original components retain their image slots and cropping behavior.
 * This function replaces the original game URL convention at its asset boundary.
 */
export function asset(value:unknown):string {
  if (typeof value !== 'string' || !value) return transparent;
  if (/^(data:|blob:|asset:)/.test(value)) return value;
  if (cache.has(value) && !value.includes('/characters/')) return cache.get(value)!;
  let pathname:string;
  try { pathname = new URL(value, globalThis.location?.href || 'http://local/').pathname; } catch { return transparent; }
  let result = value;
  const card = pathname.match(/\/characters\/([^/]+)\.(?:png|webp)$/);
  const item = pathname.match(/\/items\/([^/]+)\/([^/]+)\.(?:png|webp)$/);
  const type = pathname.match(/\/(?:types|elements)\/([^/]+)\.(?:png|webp)$/);
  const stat = pathname.match(/\/paths\/([^/]+)\.(?:png|webp)$/);
  const general = pathname.match(/\/general\/([^/]+)\.png$/);
  const inventory = pathname.match(/\/inventory-filters\/([^/]+)\.png$/);
  if(card) result = game.cardImage(decodeURIComponent(card[1]).replace(/-(?:g\d*|c)$/,'')) || transparent;
  else if(item) {
    const key = decodeURIComponent(item[2]).replace(/_0$/,'');
    if(key === 'resin') result = neutralIcons.all;
    else if(game.resourceKeys.includes(key as never)) result = game.resourceImage(key as never);
    else result = transparent;
  }
  else if(type && ['cute','pure','happy'].includes(type[1])) result = `/assets/ui/attr-${type[1]}.webp`;
  else if(stat && ['performance','technique','sense'].includes(stat[1])) result = `/assets/ui/stat-${stat[1]}.webp`;
  else if(general) result = general[1] === 'cone' ? '/assets/ui/bloom-flower.webp' : general[1] === 'relics' ? neutralIcons.artwork : general[1] === 'inventory' ? neutralIcons.all : neutralIcons[general[1] as keyof typeof neutralIcons] || transparent;
  else if(inventory) result = inventory[1] === 'bloom' ? '/assets/ui/bloom-flower.webp' : inventory[1] === 'level' ? neutralIcons.level : inventory[1] === 'training' ? neutralIcons.trace : extraInventoryIcons[inventory[1]] || neutralIcons.all;
  else if(/\/img\/stickers\/nothing_found_sticker\.png$/.test(pathname)) result = neutralIcons.empty;
  else if(/\/img\/other\/question-mark\.svg$/.test(pathname)) result = '/img/other/question-mark.svg';
  else if(/\/img\/(?:logo\.svg|icons\/|other\/question-mark|other\/plus)|\/assets\/sleep-/.test(pathname)) result = '/branding/logo.webp';
  else if(/\/img\/(?:cones|relics|enemies|farming|character-)/.test(pathname)) result = transparent;
  cache.set(value,result);
  return result;
}
export function publicAsset(key:string) {
  if(key.startsWith('flags/')) return '/img/flags/'+key.slice(6);
  if(key.startsWith('emote/')) return '/branding/logo.webp';
  return '/branding/logo.webp';
}
export function neutralSidebar(name:string):string {
  const key = name==='characters' ? 'heroicons-solid-view-grid' : name==='planner' ? 'sidebar-planner' : name==='inventory' ? 'sidebar-inventory' : 'sidebar-settings';
  return capturedIcons[key].elements.map(element=>`<${element.tag} ${Object.entries(element.attributes).map(([attribute,value])=>`${attribute}="${value}"`).join(' ')}/>`).join('');
}
