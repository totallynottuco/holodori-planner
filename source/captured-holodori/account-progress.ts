import {
  accountCharactersById, accountManifest, boardPointsSpent, maximumMemoryCount, maximumPlayerLevel,
  maximumStoryEpisode, minimumMemberLevelForBoardPoints,
} from '../hololive/vendor/shared/account-data';
import type {AccountState, GameAccountMemberSource} from '../hololive/vendor/shared/types';

export type AccountProgressEdit =
  | {kind:'rank'; characterId:string; value:number}
  | {kind:'use-imported-ranks'; characterIds:string[]}
  | {kind:'toggle-member'; characterId:string}
  | {kind:'quest'; chapter:number; episode:number}
  | {kind:'memory-bonus' | 'upgrade-bonus'; value:number}
  | {kind:'dream-rank' | 'memories'; value:number};

function bounded(value:number,min:number,max:number,fallback:number) {
  return Math.max(min,Math.min(max,Number.isSafeInteger(value) ? value : fallback));
}

export function accountProgressLimits(account:AccountState) {
  const {chapter,episode}=account.storyProgress;
  return {
    chapters:Math.max(chapter,accountManifest.storyChapters.at(-1)?.chapter??1),
    episodes:(target:number)=>Math.max(maximumStoryEpisode(target),target===chapter?episode:0),
    dreamRank:Math.max(maximumPlayerLevel,account.playerLevel),
    memories:Math.max(maximumMemoryCount,account.memoriesCollected,accountManifest.memoryCollectEffects.at(-1)?.memories??0),
  };
}

export function accountProgressMemoryBonus(account:AccountState) {
  if(account.memoryBonusPermil!==undefined)return account.memoryBonusPermil;
  if(account.memoriesCollected===0)return 0;
  return accountManifest.memoryCollectEffects.find(entry=>entry.memories===account.memoriesCollected)?.allParameterUpPermil;
}

export function accountProgressRank(account:AccountState,characterId:string,importedLevel?:number,nodes?:string[]) {
  const character = accountCharactersById.get(characterId);
  if (!character) return null;
  const board = account.boards[characterId];
  const unlocked=nodes??board?.unlockedNodeIds;
  const min = unlocked?.length ? minimumMemberLevelForBoardPoints(characterId,boardPointsSpent(characterId,unlocked)) : 1;
  const max = character.maximumLevel;
  const level = bounded(board?.characterLevel ?? importedLevel ?? min,min,max,min);
  return {level,min,max};
}

export function syncImportedMemberRanks(account:AccountState,imported:readonly GameAccountMemberSource[]) {
  let boards=account.boards;
  for(const {characterId,level} of imported){
    const board=boards[characterId];
    if(!board)continue;
    const rank=accountProgressRank(account,characterId,level);
    if(!rank)continue;
    const nextLevel=bounded(level,rank.min,rank.max,rank.level);
    if(nextLevel===board.characterLevel)continue;
    if(boards===account.boards)boards={...boards};
    boards[characterId]={...board,characterLevel:nextLevel};
  }
  return boards===account.boards?account:{...account,boards};
}

export function editAccountProgress(account:AccountState,imported:readonly GameAccountMemberSource[],edit:AccountProgressEdit,nodes?:string[]):AccountState {
  switch(edit.kind) {
    case 'use-imported-ranks': {
      const selected=new Set(edit.characterIds);
      return syncImportedMemberRanks(account,imported.filter(row=>selected.has(row.characterId)));
    }
    case 'rank': {
      const importedLevel = imported.find(member => member.characterId === edit.characterId)?.level;
      const rank = accountProgressRank(account,edit.characterId,importedLevel,nodes);
      if (!rank) return account;
      const level = bounded(edit.value,rank.min,rank.max,rank.level);
      if (level === rank.level) return account;
      const board = account.boards[edit.characterId] ?? {characterId:edit.characterId,unlockedNodeIds:[],connectAssignments:{}};
      return {...account,boards:{...account.boards,[edit.characterId]:{...board,characterLevel:level}}};
    }
    case 'toggle-member': {
      if (!accountCharactersById.has(edit.characterId)) return account;
      const ids = new Set(account.unlockedCharacterIds);
      if (ids.has(edit.characterId)) ids.delete(edit.characterId);
      else ids.add(edit.characterId);
      return {...account,unlockedCharacterIds:[...ids]};
    }
    case 'quest': {
      const previous = account.storyProgress;
      const limits=accountProgressLimits(account);
      const chapter = bounded(edit.chapter,1,limits.chapters,previous.chapter);
      const episode = bounded(edit.episode,chapter===1?0:1,limits.episodes(chapter),previous.episode);
      return chapter === previous.chapter && episode === previous.episode ? account :
        {...account,storyProgress:{chapter,episode}};
    }
    case 'dream-rank': {
      const playerLevel = bounded(edit.value,1,accountProgressLimits(account).dreamRank,account.playerLevel);
      return playerLevel === account.playerLevel ? account : {...account,playerLevel};
    }
    case 'memories': {
      const memoriesCollected = bounded(edit.value,0,accountProgressLimits(account).memories,account.memoriesCollected);
      if(memoriesCollected===account.memoriesCollected)return account;
      const next={...account,memoriesCollected};
      delete next.memoryBonusPermil;
      return next;
    }
    case 'memory-bonus':
    case 'upgrade-bonus': {
      if(!Number.isSafeInteger(edit.value)||edit.value<0)return account;
      const key=edit.kind==='memory-bonus'?'memoryBonusPermil':'upgradeBonusPermyriad';
      return account[key]===edit.value?account:{...account,[key]:edit.value};
    }
  }
}
