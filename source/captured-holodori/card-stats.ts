import {accountManifest,resolveCardParameters,resolveAccountCardParameters} from '../hololive/vendor/shared/account-data';
import {progressionManifest as manifest} from '../hololive/vendor/shared/manifest';
import type {AppProfileV2,CardStat,GameAccountImportState,GameAccountSnapshot} from '../hololive/vendor/shared/types';
import {importedParameterProfile} from './account-import';
import {currentBoards,currentMemberRank,currentOwnedCards} from './current-account';
import {validateSavedBoard} from './saved-boards';

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
/** Project the editor values against the account's current Boards. */
export function cardStats(cardId:string,level:number,bloomStage:number,source?:GameAccountImportState,blooms:ReadonlyMap<string,number>=new Map(),profile?:AppProfileV2):CardStats|null {
  try{
    const base=resolveCardParameters(cardId,level,bloomStage);
    if(base.level!==level||base.bloomStage!==bloomStage)return null;
    const cardTotal=Object.values(base.stats).reduce((sum,value)=>sum+value,0);
    const result:CardStats={level,bloomStage,card:base.stats,cardTotal,total:null,totalPower:null,importedAt:source?.snapshot.capturedAt||null,reason:source?'boards-unavailable':'no-import'};
    let context:Pick<AppProfileV2,'cards'|'account'>|null=source?boardProfile(source.snapshot):null;
    if(profile&&(!source?.snapshot.tables.boards?.length||Object.keys(profile.boardEdits??{}).length)){
      const boards=currentBoards(profile);
      if(Object.keys(boards).length){
        try{
          for(const [id,board] of Object.entries(boards))validateSavedBoard(id,board);
          const cards={...context?.cards,...profile.cards};
          for(const owned of currentOwnedCards(profile))if(!cards[owned.cardId])
            cards[owned.cardId]={bloomStage:owned.potentialUpgradeCount} as AppProfileV2['cards'][string];
          context={cards,account:{...profile.account,boards:Object.fromEntries(Object.entries(boards).map(([id,board])=>[id,{
            characterId:id,characterLevel:currentMemberRank(profile,id),unlockedNodeIds:board.nodes,connectAssignments:board.cards,
          }]))}};
        }catch{context=null;}
      }
    }
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
