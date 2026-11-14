const keepKinds={workReward:'Holowork',leaderActiveAdd:'Holomem skill',leaderActiveLevel:'Holomem skill level',miniGameReward:'Minigame'};
const keepIds={workReward:'holowork',leaderActiveAdd:'holomemSkill',leaderActiveLevel:'holomemSkillUp',miniGameReward:'minigame'};
function boardKeepTargets(data) {
  const targets=new Map([
    ['memberExp','Member EXP'],['leaderExp','Leader EXP'],['memberGold','Member Gold'],['leaderGold','Leader Gold'],
  ]);
  for(const nodes of Object.values(data.boards))for(const {kind,variant} of nodes){
    const group=keepIds[kind];
    if(group&&(!variant||/^[a-z0-9_]{1,32}$/.test(variant)))targets.set(variant?`${group}:${variant}`:group,
      variant?`${keepKinds[kind]} · ${variant.replaceAll('_',' ')}`:keepKinds[kind]);
  }
  return [...targets].map(([id,name])=>({id,name}));
}

export function buildOptimizerWorkspace({data,events,unlocks,bundledCardIds,bundledSongIds,eventArt,eventTitles,updated,gameArtwork,gameSongs=[],gameReleaseId,nextSongRelease}) {
  const names=new Map(data.cards.map(card=>[card.characterId,card.character]));
  const cardIds=new Set(data.cards.map(card=>card.id));
  const songIds=new Set(data.songs.map(song=>song.id));
  const songDetails=new Map(gameSongs.map(song=>[song.id,song]));
  const eventSongs=new Set(events.flatMap(event=>event.songIds??Object.keys(event.songs??{})));
  return {
    songs:data.songs.map(song=>({id:song.id,title:song.title,rateTarget:song.rateTarget,characterIds:song.characterIds,
      singerType:song.singerType,startTime:song.startTime,unlock:unlocks[song.id]??song.gameUnlock,
      charts:song.difficulties.map(chart=>({key:song.id+'_'+chart.type,difficulty:chart.type,difficultyLevel:chart.level,totalNotes:chart.notes,seconds:chart.seconds,
        ...(chart.gameOnly?{gameOnly:true,pcEstimate:!!chart.pcCurve}:{})}))})),
    previewSongs:gameSongs.filter(song=>!songIds.has(song.id)&&Number.isSafeInteger(song.startTime)).map(song=>({
      id:song.id,title:song.title,startTime:song.startTime,
      charts:song.charts.map(chart=>({key:chart.key,difficulty:chart.difficulty,difficultyLevel:chart.difficultyLevel,
        totalNotes:chart.totalNotes,seconds:chart.durationMicroseconds/1e6})),
    })),
    gameSongs:gameSongs.filter(song=>!songIds.has(song.id)&&eventSongs.has(song.id)).map(song=>({
      id:song.id,title:song.title,metadataOnly:true,
      charts:song.charts.map(chart=>({key:chart.key,difficulty:chart.difficulty,difficultyLevel:chart.difficultyLevel,
        totalNotes:chart.totalNotes,seconds:chart.durationMicroseconds/1e6,metadataOnly:true})),
    })),
    supportedCardIds:data.cards.map(card=>card.id),
    bundledCardIds,
    bundledSongIds,
    ...(nextSongRelease?{nextSongRelease}:{}),
    ...(gameArtwork?{gameArtwork}:{}),
    cardDetails:Object.fromEntries(data.cards.map(card=>[card.id,{name:card.name,member:card.character,characterId:card.characterId,
      rarity:card.rarity,attributeIcon:card.attributeIcon,groups:card.groups??(card.group?[card.group]:[]),
      maxLevel:card.maxLevel,maxBloom:card.maxBloom,levelLimits:card.levelLimits,cardLevelGroupId:card.cardLevelGroupId}])),
    powerUpLadder:data.powerUpLadder,
    leaders:[...names].map(([id,name])=>({id,name})).sort((a,b)=>a.name.localeCompare(b.name)),
    costumes:Object.entries(data.costumes).map(([id,costume])=>{
      const skillCard=costume.id?.replace(/^live_leader_skill-/,'');
      return {id,characterId:costume.characterId,name:costume.name,cardId:costume.cardId,
        artworkCardId:costume.cardId??(cardIds.has(skillCard)?skillCard:null),
        rarity:costume.rarity,isDefault:costume.isDefault,description:costume.description};
    }),
    events:events.map(event=>({id:event.id,name:event.gameName??updated?.eventDisplay?.[event.id]?.title??eventTitles[event.id]??event.name,
      startTime:event.startTime,endTime:event.endTime,bannerHash:updated?.eventDisplay?.[event.id]?.bannerHash,
      ...(event.gameDate?{gameDate:event.gameDate}:{}),
      songIds:event.songIds??Object.keys(event.songs??{}),scoringSongIds:Object.keys(event.songs??{}),
      art:eventArt[event.id],points:!!event.epBonus?.chapters?.length,
      ...(event.gameName&&gameReleaseId?{gameReleaseId}:{}),
      ...(event.metadataOnly?{metadataOnly:true,archiveTime:event.archiveTime,gameChapters:(event.gameChapters??[]).map(chapter=>{
        const song=songDetails.get(chapter.songId);
        return {...chapter,songTitle:song?.title,characterName:names.get(chapter.characterId),
          ...(song?{chartDifficulties:song.charts.map(chart=>({difficulty:chart.difficulty,level:chart.difficultyLevel}))}:{})};
      })}:{}),
      chapters:(event.epBonus?.chapters??[]).map(row=>({number:row.number,endTime:row.endTime,characterId:row.characterId}))})),
    boardItems:Object.entries(data.boardItems).map(([id,item])=>({id,...item})),
    boardKeepTargets:boardKeepTargets(data),
    objectives:['score','event','eventPoints','holomemLb','unitScore'],
  };
}
