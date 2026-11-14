import {formatNumber,formatDateTime} from './regional-formats.js';
import {ACCOUNT_RESOURCE_ITEM_IDS} from './account-import';
import {diamondInventoryIds,isGameInventoryId} from '../hololive/vendor/shared/types';

const plannerItems = new Set(Object.values(ACCOUNT_RESOURCE_ITEM_IDS));
const iconRoot = '/assets/game-inventory/icons/';
const fallbackImage = '/assets/achievements/groups/img_achieve_icon_gift.webp';
const escapeTooltip = name => name.replace(/[&<>]/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[character]));
const emptyCatalog = {items:{},images:{}};

let catalogRequest;
export function loadGameItems() {
  catalogRequest ??= fetch('/assets/game-inventory/catalog.json').then(response => {
    if (!response.ok) throw Error('Item catalog unavailable');
    return response.json();
  }).catch(() => {
    catalogRequest = undefined;
    return emptyCatalog;
  });
  return catalogRequest;
}

const parkTypes = new Set(['FACILITY','QUEST_DELIVERY','PARK_CHARACTER_QUEST','MINI_GAME_BET_COIN']);
const consumableTypes = new Set(['GACHA_TICKET','SELECTABLE_REWARD_BOX','LIVE_AUTO_PLAY','LIVE_REWARD_UP_STAMINA_RECOVER','MINI_GAME_REWARD_UP_STAMINA_RECOVER','MUSIC_RELEASE']);
const gameCategories = {1:'CARD_LEVELING',2:'PARK',999:'OTHER',1000:'HIDDEN'};
const masterCategory = value => typeof value==='string'?value.split('_TYPE_').at(-1):gameCategories[value];

export function inventoryPlacement(id,category,type) {
  if(category==='CARD_LEVELING')return {category:'training',section:type==='SKILL_TREE'||id.startsWith('item-skill_tree_')?'board':'members'};
  if(category==='PARK'||type==='FACILITY')return {category:'construction',section:'construction'};
  let section='other';
  if(type==='MARATHON_EVENT_BADGE'||id.startsWith('item-event_badge-'))section='events';
  else if(type==='CHARACTER_COIN')section='membership';
  else if(type==='EXCHANGE')section='exchange';
  else if(parkTypes.has(type)||/^item-mini[-_]game/.test(id)&&id.endsWith('coin'))section='park';
  else if(consumableTypes.has(type))section='consumables';
  return {category:'other',section};
}

function quantityDetails(quantity,compactQuantity,dates=[]) {
  const exact=quantity===null?'Quantity unavailable':formatNumber(quantity);
  const expiries=[...dates].sort(([left],[right])=>left-right)
    .map(([time,amount])=>formatNumber(amount)+' expires '+formatDateTime(time));
  return {quantity,exact,value:quantity===null?'—':compactQuantity(quantity),
    quantityTooltip:[exact,...expiries].map(escapeTooltip).join('<br>')};
}

/** The game observation seeds the catalog tiles. Local edits overlay it without
 * modifying the raw import or including a duplicate of any planner material. */
export function projectGameInventory(snapshot,catalog,compactQuantity) {
  const tables = snapshot?.referenceData?.tables;
  const reference = table => (Array.isArray(tables?.[table]) ? tables[table] : [])
    .flatMap(row => typeof row?.data?.id === 'string' ? [[row.data.id,row.data]] : []);
  const labels = new Map(reference('LangItem_Eng').map(([id,data]) => [id,data.text]));
  const items = new Map(reference('Item'));
  const stock = new Map();
  const expiries = new Map();
  const validItem=id=>isGameInventoryId(id)&&!plannerItems.has(id);
  for (const {itemId} of snapshot?.tables.ownedItems??[]) {
    if (validItem(itemId)) stock.set(itemId,null);
  }
  for (const {itemId,quantity,expiredTime} of snapshot?.tables.items??[]) {
    if (!validItem(itemId)) continue;
    const amount = BigInt(quantity);
    stock.set(itemId,(stock.get(itemId) ?? 0n) + amount);
    const time = Number(expiredTime);
    if (Number.isSafeInteger(time) && time >= 1_000_000_000_000 && time < 10_000_000_000_000) {
      const dates = expiries.get(itemId) ?? new Map();
      dates.set(time,(dates.get(time) ?? 0n) + amount);
      expiries.set(itemId,dates);
    }
  }
  const tile = (name,image,quantity,dates) => ({
    name,image,tooltip:escapeTooltip(name),...quantityDetails(quantity,compactQuantity,dates),
  });
  const ids=new Set([...Object.keys(catalog.items).filter(validItem),...stock.keys()]);
  const rows = [...ids].map(id => {
    const local = Object.hasOwn(catalog.items,id) ? catalog.items[id] : undefined;
    const item = items.get(id);
    const assetId = item?.assetId;
    const image = local?.image || (Object.hasOwn(catalog.images,assetId) ? catalog.images[assetId] : fallbackImage);
    const label = labels.get(item?.nameLangId);
    const category=masterCategory(item?.inventoryItemCategoryType)??local?.category;
    const type=typeof item?.type==='string'?item.type.split('_TYPE_').at(-1):local?.type;
    return [id,{
      ...tile(typeof label === 'string' && label ? label : local?.name || id,image,stock.has(id)?stock.get(id):0n,expiries.get(id)),
      ...inventoryPlacement(id,category,type),
      order:Number.isFinite(item?.order)?item.order:local?.order,
      hidden:category==='HIDDEN'&&!stock.has(id),
    }];
  });
  return Object.fromEntries([
    [diamondInventoryIds.free,{...tile('Free Diamonds',iconRoot+'img_resource_thumb_stonefree.webp',snapshot?snapshot.balances.free:0),category:'other'}],
    [diamondInventoryIds.paid,{...tile('Paid Diamonds',iconRoot+'img_resource_thumb_stonepaid.webp',snapshot?snapshot.balances.paid:0),category:'other'}],
    ...rows,
  ]);
}

export function applyGameInventoryEdits(base,inventory,compactQuantity) {
  const tiles={...base};
  for(const {item,type,tier,value} of inventory){
    if(!isGameInventoryId(item)||plannerItems.has(item)||type!==item||tier!==0)continue;
    const tile=tiles[item]??{name:item,tooltip:escapeTooltip(item),...inventoryPlacement(item),image:fallbackImage};
    tiles[item]={...tile,...quantityDetails(value,compactQuantity),hidden:false};
  }
  return tiles;
}

export function clearGameInventory(inventory,snapshot) {
  const ids=new Set(inventory.map(row=>row.item));
  if(snapshot){
    for(const {itemId} of snapshot.tables.items)ids.add(itemId);
    for(const {itemId} of snapshot.tables.ownedItems)ids.add(itemId);
    for(const id of Object.values(diamondInventoryIds))ids.add(id);
  }
  return [...ids].filter(id=>isGameInventoryId(id)&&!plannerItems.has(id))
    .map(item=>({item,type:item,tier:0,value:0}));
}
