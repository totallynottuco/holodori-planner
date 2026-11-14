export type FilterValue = string | number;
export type Selection = FilterValue[] | FilterValue | null | undefined;
export const pickerSortOptions = [
  ['A-Z','name','nameDescending'],['Rarity','rarity','rarityAscending'],['Release Date','newest','oldest'],
] as const;
type PickerSort = typeof pickerSortOptions[number][1|2];
export type CardFilters = {search:string; tier:number[]; type:string[]; path:string[];ownership:string[];hideMaxed:boolean;sort:PickerSort};
export type FilterScope = 'collection' | 'picker';
const options={tier:[3,4,5],type:['cute','pure','happy'],path:['performance','technique','sense'],ownership:['owned','unowned']};

export function values(selection:Selection):FilterValue[] {
  return Array.isArray(selection)?selection:selection==null?[]:[selection];
}
export function selected(selection:Selection,value:FilterValue) {return values(selection).includes(value);}
export function toggle(selection:Selection,value:FilterValue) {
  const current=values(selection);return current.includes(value)?current.filter(item=>item!==value):[...current,value];
}
export function matches(value:FilterValue,selection:Selection) {const current=values(selection);return !current.length||current.includes(value);}
export function active(filters:CardFilters,ownershipAvailable=true) {return filters.hideMaxed||!!filters.search.trim()||['tier','type','path',...(ownershipAvailable?['ownership']:[])].some(key=>values(filters[key as keyof typeof options]).length>0);}
export function matchesOwnership(id:string,selection:Selection,owned:ReadonlySet<string>|null){return owned===null||matches(owned.has(id)?'owned':'unowned',selection);}
export function normalize(input:any):CardFilters {
  const group=(key:keyof typeof options)=>[...new Set(values(input?.[key]))].filter(value=>(options[key] as FilterValue[]).includes(value));
  const sort=pickerSortOptions.flatMap(([,forward,reverse])=>[forward,reverse]).find(id=>id===input?.sort)??'name';
  return {search:typeof input?.search==='string'?input.search:'',tier:group('tier') as number[],type:group('type') as string[],path:group('path') as string[],ownership:group('ownership') as string[],hideMaxed:input?.hideMaxed===true,sort};
}
function record(value:any):Record<string,any> {return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}
function read(storage:Storage):Record<string,any> {
  try {return record(JSON.parse(storage.getItem('card_filters')||'{}'));}catch{return {};}
}
export function load(storage:Storage,id:string,scope:FilterScope) {return normalize(record(read(storage)[id])[scope]);}
export function save(storage:Storage,id:string,scope:FilterScope,filters:CardFilters) {
  const all=read(storage),next=JSON.stringify({...all,[id]:{...record(all[id]),[scope]:normalize(filters)}});
  if(storage.getItem('card_filters')!==next)storage.setItem('card_filters',next);
}
export function removeProfileFilters(storage:Storage,id:string) {const all=read(storage);if(Object.hasOwn(all,id)){delete all[id];storage.setItem('card_filters',JSON.stringify(all));}}
export const cardFilters={selected,toggle,matches,active,matchesOwnership};
