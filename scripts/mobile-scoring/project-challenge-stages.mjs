// Both the bundled catalog and signed Mobile releases use the same public master rows.
export function projectChallengeStages(towers, stages) {
  const byTower = new Map(towers.map(tower => [tower.id, tower]));
  return stages.map(stage => {
    const tower = byTower.get(stage.liveTowerId);
    if (!tower) throw Error('Missing Challenge Live tower for stage ' + stage.number);
    return {
      id: tower.id + ':' + stage.number,
      towerId: tower.id,
      number: stage.number,
      songIds: stage.musicIds,
      clearScore: Number(stage.clearScore),
      bonusCharacterIds: stage.bonusCharacterIds ?? [],
      bonusPermil: stage.bonusCharacterScoreUpPermilUp ?? 0,
      startTime: Number(tower.startTime ?? 0),
      endTime: Number(tower.endTime ?? 0),
    };
  }).sort((a, b) => a.towerId.localeCompare(b.towerId) || a.number - b.number);
}
