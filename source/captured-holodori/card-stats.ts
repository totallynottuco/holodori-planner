import {accountManifest,resolveCardParameters,resolveAccountCardParameters} from '../hololive/vendor/shared/account-data';
import {progressionManifest as manifest} from '../hololive/vendor/shared/manifest';
import type {AppProfileV2,CardStat,GameAccountImportState,GameAccountSnapshot} from '../hololive/vendor/shared/types';
import {importedParameterProfile} from './account-import';

export const statNames:Record<CardStat,string>={performance:'Performance',technique:'Technique',sense:'Sense'};
type Stats=Record<CardStat,number>;
export type CardStats={level:number;bloomStage:number;card:Stats;cardTotal:number;total:Stats|null;totalPower:number|null;importedAt:string|null;reason:'no-import'|'boards-unavailable'|null};
const contexts=new WeakMap<GameAccountSnapshot,{catalog:string;profile:AppProfileV2|null}>();
function boardProfile(snapshot:GameAccountSnapshot){
  const catalog=manifest.metadata.catalogVersion+':'+accountManifest.metadata.catalogVersion;
  let cached=contexts.get(snapshot);
  if(!cached||cached.catalog!==catalog){
    let profile:AppProfileV2|null=null;
    try{profile=importedParameterProfile(snapshot);}catch{/* Unknown topology remains unavailable. */}
    cached={catalog,profile};contexts.set(snapshot,cached);
  }
  return cached.profile;
}
/** Read-only projection: current Level/Bloom and local Connect Blooms, with the
 * last imported Board topology. Never writes projections into account facts. */
export function cardStats(cardId:string,level:number,bloomStage:number,source?:GameAccountImportState,blooms:ReadonlyMap<string,number>=new Map()):CardStats|null {
  try{
    const base=resolveCardParameters(cardId,level,bloomStage);
    if(base.level!==level||base.bloomStage!==bloomStage)return null;
    const cardTotal=Object.values(base.stats).reduce((sum,value)=>sum+value,0);
    const result:CardStats={level,bloomStage,card:base.stats,cardTotal,total:null,totalPower:null,importedAt:source?.snapshot.capturedAt||null,reason:source?'boards-unavailable':'no-import'};
    const context=source?boardProfile(source.snapshot):null;
    if(context){
      const cards={...context.cards};
      for(const [id,bloom]of blooms)if(cards[id]&&cards[id].bloomStage!==bloom)cards[id]={...cards[id],bloomStage:bloom as 0|1|2|3|4|5};
      const full=resolveAccountCardParameters({...context,cards},cardId,level,bloomStage);
      if(Object.values(full.accountStats).every(value=>Number.isSafeInteger(value)&&value>=0)&&Number.isSafeInteger(full.accountTotal)){
        result.total=full.accountStats;result.totalPower=full.accountTotal;result.reason=null;
      }
    }
    return result;
  }catch{return null;}
}
