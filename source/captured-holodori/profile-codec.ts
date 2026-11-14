import { progressionManifest as manifest } from '../hololive/vendor/shared/manifest';
import { createDefaultProfile, createDefaultCardState, prepareProfile, validateGameAccountImport } from '../hololive/vendor/shared/profile';
import { isGameInventoryId, resourceKeys, type AppProfileV2, type GameAccountImportState, type SavedCardState } from '../hololive/vendor/shared/types';
import { minimumTrainingStage } from '../hololive/vendor/shared/planner';
import { defaultBoosts } from '../hololive/boosts';
import { normalizeGoals, rulesFor, type SeelieGoal } from './game';
import {readSavedLineups} from './saved-lineups';

export type NativeValues = Record<string, string>;
export type CapturedFields = Record<string, unknown>;
export const capturedFields = ['goals','inactive','notes','custom_items','customs','inventory','tasks','boosts','task_ids','saved_lineups'] as const;
export const capturedMarker = 'holodori-captured-vue-v1';
const currentCatalog = () => new Map(manifest.cards.map(card => [card.id, card]));
const clone = <T>(value:T):T => JSON.parse(JSON.stringify(value));
const json = <T>(value:string|undefined, fallback:T):T => value === undefined ? fallback : JSON.parse(value);
const day = (input:string|null|undefined) => {
  const date = input ? new Date(input) : new Date();
  if (!Number.isFinite(date.getTime())) throw Error('A saved reminder has an invalid date.');
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
};
const isoDay = (input:string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) throw Error('A reminder date is invalid.');
  const date = new Date(`${input}T00:00:00`);
  if (!Number.isFinite(date.getTime())) throw Error('A reminder date is invalid.');
  return date.toISOString();
};
const integer = (value:unknown, min:number, max:number, fallback:number) => {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw Error('Saved progress contains an invalid value.');
  return number;
};

export function freshProfile(): AppProfileV2 {
  const profile = createDefaultProfile(manifest.metadata.catalogVersion);
  profile.tasks = [];
  profile.boosts = defaultBoosts();
  profile.preferences.autoCheckUpdates = false;
  profile.preferences.theme = 'dark';
  return profile;
}
export function canonicalProfile(input:unknown):AppProfileV2 {
  const profile = prepareProfile(input, manifest).profile;
  profile.preferences.autoCheckUpdates = false;
  profile.preferences.theme = 'dark';
  // prepareProfile already migrates, repairs, and validates the entire profile.
  // The two known-valid desktop preferences do not need another full parse.
  return profile;
}

// Only immutable serialized inputs are keys. These validated objects remain
// private: projection reads them, and capturedToProfile clones before editing.
// First reads (including legacy schemas) always migrate and validate normally.
const canonicalReads = new Map<string,AppProfileV2>();
const sourceReads = new Map<string,GameAccountImportState>();
const sourceTexts = new WeakMap<GameAccountImportState,string>();
// Enough for the acknowledged and in-flight expanded capture profile while
// preventing sixteen multi-megabyte historical snapshots from accumulating.
const CACHE_TEXT_BYTES=24_000_000;
let canonicalReadBytes=0,sourceReadBytes=0;
function rememberSource(text:string,source:GameAccountImportState):void {
  if(sourceReads.has(text)){sourceReads.delete(text);sourceReadBytes-=text.length*2;}
  if(text.length*2>CACHE_TEXT_BYTES)return;
  sourceReads.set(text,source);sourceTexts.set(source,text);sourceReadBytes+=text.length*2;
  while(sourceReads.size>8||sourceReadBytes>CACHE_TEXT_BYTES){const first=sourceReads.keys().next().value!;sourceReads.delete(first);sourceReadBytes-=first.length*2;}
}
// This content interning is private to already parsed JSON storage. An object's
// toJSON/accessors can never impersonate a validated source at this boundary.
function readStoredSource(input:unknown):GameAccountImportState {
  const text=JSON.stringify(input),cached=sourceReads.get(text);
  if(cached){rememberSource(text,cached);return cached;}
  const source=validateGameAccountImport(input);rememberSource(text,source);return source;
}
function rememberCanonical(text:string,profile:AppProfileV2):void {
  if(canonicalReads.has(text)){canonicalReads.delete(text);canonicalReadBytes-=text.length*2;}
  if(text.length*2>CACHE_TEXT_BYTES)return;
  canonicalReads.set(text,profile);canonicalReadBytes+=text.length*2;
  if(profile.gameAccountImport&&!sourceTexts.has(profile.gameAccountImport))rememberSource(JSON.stringify(profile.gameAccountImport),profile.gameAccountImport);
  while(canonicalReads.size>16||canonicalReadBytes>CACHE_TEXT_BYTES){const first=canonicalReads.keys().next().value!;canonicalReads.delete(first);canonicalReadBytes-=first.length*2;}
}
function readCanonical(text:string):AppProfileV2 {
  let profile = canonicalReads.get(text);
  if(!profile){const stored=JSON.parse(text);if(stored&&typeof stored==='object'&&stored.gameAccountImport!==undefined)stored.gameAccountImport=readStoredSource(stored.gameAccountImport);profile=canonicalProfile(stored);}
  rememberCanonical(text,profile);
  return profile;
}

/** Repair older own-app Level-only records before the original tabs read them.
 * Validate before domain normalization so malformed imports cannot be clamped
 * into apparently valid progress. Existing record IDs and extension fields stay
 * intact; only a missing counterpart receives a new numeric ID. */
function normalizedGoals(input:unknown, previous?:AppProfileV2):SeelieGoal[] {
  const catalog=currentCatalog();
  if (!Array.isArray(input)) throw Error('The captured profile has an invalid shape.');
  const goals = clone(input) as SeelieGoal[];
  for (const goal of goals) {
    if (!goal || typeof goal !== 'object') throw Error('The captured profile has an invalid goal.');
    if (goal.type !== 'character' && goal.type !== 'trace') continue;
    if (typeof goal.character !== 'string' || !catalog.has(goal.character)) throw Error('A captured goal references a card outside the Holodori catalog.');
    if (goal.type === 'character') {
      const max = rulesFor(goal.character).maxLevel;
      integer(goal.current?.level,1,max,1);
      integer(goal.goal?.level,1,max,1);
      integer(goal.current?.asc,0,4,0);
      integer(goal.goal?.asc,0,4,0);
      if (goal.current?.expIntoLevel !== undefined) integer(goal.current.expIntoLevel,0,Number.MAX_SAFE_INTEGER,0);
    } else {
      integer(goal.sp?.current,0,4,0);
      integer(goal.sp?.goal,0,4,0);
    }
  }
  const characterIds = new Set(goals.filter(goal=>goal.type==='character').map(goal=>goal.character));
  for (const trace of [...goals]) if (trace.type === 'trace' && !characterIds.has(trace.character)) {
    const before = previous?.cards[trace.character!];
    if (before) {goals.push({type:'character',character:before.cardId,current:{level:before.level,asc:before.trainingStage,expIntoLevel:before.expIntoLevel},goal:{level:before.level,asc:before.trainingStage},eidolon:before.bloomStage,favorite:!!before.favorite});characterIds.add(before.cardId);}
  }
  return normalizeGoals(goals);
}

/** Original Vue storage shape. The renderer continues to read its own fields. */
export function profileToCaptured(profile:AppProfileV2):CapturedFields {
  const catalog=currentCatalog();
  const goals:any[] = [], inactive:Record<string,boolean> = {}, notes:Record<string,string> = {};
  let goalId = 0;
  for (const state of Object.values(profile.cards)) {
    const card = catalog.get(state.cardId);
    if (!card) continue; // Retired catalog records remain in the canonical document.
    const level = state.level, currentStage = state.trainingStage;
    const targetLevel = state.goal.active ? state.goal.targetLevel : level;
    const levelStage = Math.max(currentStage, minimumTrainingStage(card,targetLevel,manifest),state.goal.active?state.goal.targetTrainingStage:currentStage);
    const goalBloom=state.goal.active?state.goal.targetBloomStage:undefined;
    goals.push({id:++goalId,type:'character',character:state.cardId,current:{level,asc:currentStage,text:String(level),expIntoLevel:state.expIntoLevel},goal:{level:targetLevel,asc:levelStage,text:String(targetLevel)},eidolon:state.bloomStage,...(goalBloom===undefined?{}:{goalBloom}),favorite:!!state.favorite});
    goals.push({id:++goalId,type:'trace',character:state.cardId,sp:{current:currentStage,goal:levelStage},bonus:{}});
    if (state.inactive || state.hidden) inactive[state.cardId] = true;
    if (state.notes) notes[state.cardId] = state.notes;
  }
  const tasks = (profile.tasks || []).map((task,index) => ({
    id:index+1, holodoriId:task.id, task:task.title, notes:task.notes,
    recurring:task.recurrenceDays ?? (task.repeat === 'weekly' ? 7 : 1),
    mode:task.recurrenceMode || 'original', next:day(task.dueAt),
  }));
  const inventory=[
    ...resourceKeys.map(key=>({type:key,item:key,tier:0,value:profile.inventory[key]})),
    ...Object.entries(profile.gameInventory??{}).map(([item,value])=>({type:item,item,tier:0,value})),
  ];
  return {goals:normalizedGoals(goals,profile),inactive,notes,custom_items:[],customs:{},inventory,tasks,task_ids:Object.fromEntries(tasks.map(task=>[String(task.id),task.holodoriId])),boosts:clone(profile.boosts || defaultBoosts()),saved_lineups:[]};
}

/** Read only the allowed, own-game storage fields from a profile snapshot. */
export function readCaptured(values:NativeValues,id:string,base?:AppProfileV2):CapturedFields {
  let fallback:CapturedFields|undefined;
  const fields = Object.fromEntries(capturedFields.map(field=>{
    const stored=values[`${id}-${field}`];
    return [field,stored===undefined?(fallback ||= profileToCaptured(base || freshProfile()))[field]:JSON.parse(stored)];
  }));
  fields.goals = normalizedGoals(fields.goals,base);
  fields.saved_lineups = readSavedLineups(fields.saved_lineups);
  return fields;
}

/** Convert actual Vue edits back to the existing Holodori document without
 * discarding account data, partial EXP, artwork preferences, or legacy tasks. */
export function capturedToProfile(fields:CapturedFields, previous:AppProfileV2 = freshProfile()):AppProfileV2 {
  const catalog=currentCatalog();
  // Source metadata is immutable and is not an editable planner field. Reuse
  // its validated identity rather than copying megabytes of master definitions.
  const {gameAccountImport,...editable}=previous;
  const result = clone(editable) as AppProfileV2, goals = normalizedGoals(fields.goals,previous);
  if(gameAccountImport)result.gameAccountImport=gameAccountImport;
  if (!Array.isArray(fields.inventory) || !Array.isArray(fields.tasks)) throw Error('The captured profile has an invalid shape.');
  const inactive = (fields.inactive || {}) as Record<string,boolean>, notes = (fields.notes || {}) as Record<string,string>;
  const tracked = new Set<string>();
  const characterGoals = goals.filter(goal=>goal?.type==='character');
  const traces = new Map<string,any>();
  for (const goal of goals) if (goal.type==='trace' && !traces.has(goal.character!)) traces.set(goal.character!,goal);
  for (const goal of characterGoals) {
    if (!goal || goal.type !== 'character' || typeof goal.character !== 'string') continue;
    const card = catalog.get(goal.character);
    if (!card) throw Error('A captured goal references a card outside the Holodori catalog.');
    const before = result.cards[card.id] || createDefaultCardState(card.id,`${card.memberName} — ${card.cardName}`);
    const trace = traces.get(card.id);
    const level = integer(goal.current?.level,1,80,1);
    const stage = Math.max(integer(goal.current?.asc,0,4,0),integer(trace?.sp?.current,0,4,0));
    const target = integer(goal.goal?.level,level,80,level);
    const targetStage = Math.max(stage,integer(goal.goal?.asc,0,4,stage),integer(trace?.sp?.goal,0,4,stage),minimumTrainingStage(card,target,manifest));
    const bloomStage=integer(goal.eidolon,0,5,before.bloomStage) as SavedCardState['bloomStage'];
    const targetBloom=goal.goalBloom===undefined?undefined:integer(goal.goalBloom,bloomStage,5,bloomStage) as SavedCardState['bloomStage'];
    result.cards[card.id] = {...before,level,trainingStage:stage as 0|1|2|3|4,expIntoLevel:integer(goal.current?.expIntoLevel,0,Number.MAX_SAFE_INTEGER,level===before.level?before.expIntoLevel:0),bloomStage,favorite:!!goal.favorite,inactive:!!inactive[card.id],hidden:!!inactive[card.id],notes:notes[card.id] || '',goal:{active:target>level||targetStage>stage||(targetBloom??bloomStage)>bloomStage,targetLevel:target,targetTrainingStage:targetStage as 0|1|2|3|4,...(targetBloom===undefined?{}:{targetBloomStage:targetBloom})}};
    tracked.add(card.id);
  }
  // Removing a tracking entry does not delete unrelated account/ownership data.
  for (const state of Object.values(result.cards)) if (catalog.has(state.cardId) && !tracked.has(state.cardId)) state.goal.active = false;
  for (const [id,note] of Object.entries(notes)) if (catalog.has(id)) {
    const card = catalog.get(id)!;
    result.cards[id] ||= createDefaultCardState(id,`${card.memberName} — ${card.cardName}`);
    result.cards[id].notes = String(note);
  }
  const inventory = { ...result.inventory };
  const gameInventory:Record<string,number>={};
  for (const key of resourceKeys) inventory[key] = 0;
  for (const entry of fields.inventory as any[]) {
    if (!entry) continue;
    const value=integer(entry.value,0,Number.MAX_SAFE_INTEGER,0);
    if(resourceKeys.includes(entry.item)) inventory[entry.item as keyof typeof inventory]=value;
    else if(isGameInventoryId(entry.item)&&entry.type===entry.item&&entry.tier===0) gameInventory[entry.item]=value;
  }
  result.inventory = inventory;
  if(Object.keys(gameInventory).length)result.gameInventory=gameInventory;
  else delete result.gameInventory;
  const previousTasks = new Map((previous.tasks || []).map(task=>[task.id,task]));
  const taskIds = (fields.task_ids || {}) as Record<string,string>;
  result.tasks = (fields.tasks as any[]).map((task,index)=>{
    const id = taskIds[String(task.id)] || (typeof task.holodoriId==='string' ? task.holodoriId : String(task.id ?? index+1));
    const old = previousTasks.get(id);
    const dueAt = isoDay(String(task.next));
    if (old && task.task===old.title && String(task.notes || '')===old.notes && task.next===day(old.dueAt) && integer(task.recurring,1,7,1)===(old.recurrenceDays ?? (old.repeat==='weekly'?7:1)) && (task.mode || 'original')===(old.recurrenceMode || 'original')) return clone(old);
    return {...old,id,title:String(task.task || '').trim(),notes:String(task.notes || ''),category:old?.category || 'custom',repeat:integer(task.recurring,1,7,1)===7?'weekly':'daily',dueAt,doneAt:null,snoozedUntil:old?.snoozedUntil || null,recurrenceDays:integer(task.recurring,1,7,1),recurrenceMode:task.mode==='completed'?'completed':'original'};
  });
  result.boosts = clone((fields.boosts || previous.boosts || defaultBoosts()) as NonNullable<AppProfileV2['boosts']>);
  result.revision = previous.revision;
  return canonicalProfile(result);
}

export function hydrateValues(input:NativeValues):NativeValues {
  return hydrateWorkspace(input).values;
}

export function hydrateWorkspace(input:NativeValues):{values:NativeValues;profiles:Map<string,AppProfileV2>} {
  if (input.game_id !== 'hololive-dreams') throw Error('This data folder belongs to another app. Your files have been preserved.');
  const output = {...input};
  const profiles = new Map<string,AppProfileV2>();
  const ids = ['main',...json<string[]>(input.accounts,[])];
  for (const id of ids) {
    const profile = input[`${id}-holodori`] ? readCanonical(input[`${id}-holodori`]) : freshProfile();
    const fields = input[`${id}-renderer`] === capturedMarker ? readCaptured(input,id,profile) : profileToCaptured(profile);
    if (input[`${id}-renderer`] !== capturedMarker)
      fields.saved_lineups = readSavedLineups(json(input[`${id}-saved_lineups`],[]));
    for (const field of capturedFields) output[`${id}-${field}`] = JSON.stringify(fields[field]);
    const projected=capturedToProfile(fields,profile),text=JSON.stringify(projected);
    // Vue may edit the live profile, so copy the editable fields while sharing
    // only the validated game snapshot. It is replaced as a unit on import.
    const {gameAccountImport,...editable}=projected;
    profiles.set(id,{...clone(editable),...(gameAccountImport?{gameAccountImport}:{})});
    output[`${id}-holodori`] = text;rememberCanonical(text,projected);
    output[`${id}-renderer`] = capturedMarker;
  }
  const settings = json<any>(input.settings,{}), view = settings.view || {}, active = output.account || 'main';
  const migrated = {...settings};
  const mapping:Record<string,string> = {sidebarDensity:'sidebar_density',keepItemOpen:'planner_keep_item_open',additionalInputs:'planner_show_add_input',inventoryButtons:'inventory_buttons',inventoryCraftButton:'inventory_craft_button',showPermanentTasks:'show_permanent_tasks',showEventTasks:'show_event_tasks',showSummary:'planner_subjects_show'};
  for (const [from,to] of Object.entries(mapping)) if (migrated[to]===undefined && view[from]!==undefined) migrated[to] = view[from];
  if (view.charactersOrder?.length && !migrated.characters_order?.[active]) migrated.characters_order = {...migrated.characters_order,[active]:view.charactersOrder.join('|')};
  if (view.sort && !migrated.characters_sort_by?.[active]) migrated.characters_sort_by = {...migrated.characters_sort_by,[active]:['name','goals','custom'].includes(view.sort)?view.sort:'custom'};
  output.settings = JSON.stringify(migrated);
  for (const [key,value] of Object.entries({charactersExpandGoals:view.expanded,charactersHideInactive:view.hideInactive,charactersFavoriteOnly:view.favoritesOnly,charactersActiveFirst:view.activesFirst,tasks_sort:view.plannerSort})) if (output[key]===undefined && value!==undefined) output[key]=typeof value==='string'?value:JSON.stringify(value);
  output.storage_schema = 'localstorage-v1';
  return {values:output,profiles};
}

/** A single native transaction contains both source fields and the compatible
 * canonical document. No disk writes occur while hydrating old profiles. */
export function nativePatch(values:NativeValues,pending:Record<string,string|null>,nativeValues:NativeValues):Record<string,string|null> {
  const patch = {...pending};
  const ids = ['main',...json<string[]>(values.accounts,[])];
  const oldIds = ['main',...json<string[]>(nativeValues.accounts,[])];
  for (const id of oldIds) if (!ids.includes(id)) for (const key of Object.keys(nativeValues)) if (key.startsWith(`${id}-`)) patch[key]=null;
  for (const id of ids) {
    const changed = !nativeValues[`${id}-holodori`] || Object.keys(pending).some(key=>key.startsWith(`${id}-`)&&key!==`${id}-saved_lineups`);
    if (!changed) continue;
    const previous = values[`${id}-holodori`] ? readCanonical(values[`${id}-holodori`]) : freshProfile();
    const fields = readCaptured(values,id,previous), profile = capturedToProfile(fields,previous);
    const oldRevision = nativeValues[`${id}-holodori`] ? readCanonical(nativeValues[`${id}-holodori`]).revision : 0;
    profile.revision=Math.max(previous.revision,oldRevision)+1;
    fields.task_ids=Object.fromEntries((fields.tasks as any[]).map((task,index)=>[String(task.id),profile.tasks![index].id]));
    const text=JSON.stringify(profile);patch[`${id}-holodori`] = text;rememberCanonical(text,profile);
    patch[`${id}-renderer`] = capturedMarker;
    for (const field of capturedFields) patch[`${id}-${field}`] = JSON.stringify(fields[field]);
  }
  if (pending.settings) patch.settings = JSON.stringify({...json(nativeValues.settings,{}),...JSON.parse(pending.settings)});
  patch.storage_schema='localstorage-v1';
  return patch;
}

export function parseProfileExport(text:string):{profile:AppProfileV2;captured:CapturedFields} {
  const input = JSON.parse(text);
  if (input?.game!=='hololive-dreams' || !['holodori-planner-profile-v1','holodori-planner-profile-v2'].includes(input?.format)) throw Error('This file is not a profile backup exported by this app.');
  const profile = canonicalProfile(input.profile);
  if (input.format==='holodori-planner-profile-v2' && input.captured) {
    let fallback:CapturedFields|undefined;
    const captured = Object.fromEntries(capturedFields.map(field=>[field,input.captured[field] ?? (fallback ||= profileToCaptured(profile))[field]]));
    captured.goals = normalizedGoals(captured.goals,profile);
    captured.saved_lineups = readSavedLineups(captured.saved_lineups);
    return {profile:clone(capturedToProfile(captured,profile)),captured};
  }
  const captured = profileToCaptured(profile);
  return {profile:clone(capturedToProfile(captured,profile)),captured};
}

/** Internal projection is allowed to share immutable validated import metadata.
 * Public profile/export readers return their own JSON copies. */
export function projectProfile(values:NativeValues,id:string):AppProfileV2 {
  const previous = values[`${id}-holodori`] ? readCanonical(values[`${id}-holodori`]) : freshProfile();
  const captured = readCaptured(values,id,previous);
  return capturedToProfile(captured,previous);
}
export function profileExport(values:NativeValues,id:string) {
  const previous = values[`${id}-holodori`] ? readCanonical(values[`${id}-holodori`]) : freshProfile();
  const captured = readCaptured(values,id,previous);
  return {format:'holodori-planner-profile-v2',game:'hololive-dreams',profile:clone(capturedToProfile(captured,previous)),captured};
}
