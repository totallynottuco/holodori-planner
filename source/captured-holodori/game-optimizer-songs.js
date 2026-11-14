import {decodeOptimizerChart,OPTIMIZER_CHART_DIFFICULTIES} from '../hololive/vendor/shared/optimizer-chart-pack';

const comboCurve = Array.from({length:11},(_,i)=>[i*100,i*10]);
const catalogPcNoteWeights = [1000,1000,1000,100,100,1000,1000];

export function nextGameOptimizerSongRelease(resources, now = Date.now()) {
  let next = Infinity;
  for (const time of Object.values(resources?.previewSongStarts??{})) {
    if (time > now && time < next) next = time;
  }
  return next;
}

/** Project a verified chart into the coarse scoring representation used to rank proposals. */
function compactChart(pack, summary, song, pcDenominator) {
  const mobile = decodeOptimizerChart(pack, summary.key, 'mobile');
  const pc = decodeOptimizerChart(pack, summary.key, 'pc');
  const {duration:seconds, difficultyLevel:level, total_notes:notes, eventTimesMicroseconds:times} = mobile;
  const weights = mobile.cumulativeEventWeightsPermil;
  const mobileTotal = weights.at(-1);
  const mobileCombo = mobile.cumulativeComboWeightedEventWeightsPermilSquared;
  const pcCombo = pc.cumulativeComboWeightedEventWeightsPermilSquared;
  const pcAwardedWeight = pc.cumulativeEventWeightsPermil.at(-1);
  const scoreMult = mobileCombo.at(-1)/(1000*mobileTotal);
  if (!Number.isFinite(scoreMult)) return null;
  let count = 0;
  const curve = [], pcCurve = [], countCurve = [];
  for (let second = 0; second <= Math.ceil(seconds); second++) {
    while (count < times.length && times[count] <= second*1_000_000) count++;
    curve.push(weights[count]/mobileTotal);
    pcCurve.push(pcCombo[count]/pcCombo.at(-1));
    countCurve.push(count);
  }
  return {type:summary.difficulty, level, notes, seconds, slots:mobile.special_points, curve, countCurve,
    coefficient:1+song.scoreCoefficientPermil*(level-5)/1000, scoreMult, gameOnly:true,
    ...(pcDenominator?{scoreMultPc:pcCombo.at(-1)/(1000*(pcAwardedWeight+pcDenominator.inactiveHoldRelayCount*100)),pcCurve}:{})};
}

/** Keep captured website rows for fallback and add released, verified Mobile chart proposals. */
export function overlayGameOptimizerSongs(reference, resources, now = Date.now()) {
  if (!resources?.revision) return reference;
  const songs = new Map(reference.songs.map(song=>[song.id,song]));
  const pcSupported = catalogPcNoteWeights.every((weight,index)=>resources.pack.pcNoteWeightsPermil.get(index+1)===weight);
  let changed = false;
  for (const row of resources.songs) {
    const song = resources.data.songs[row.id];
    const startTime = resources.previewSongStarts?.[row.id];
    if (!song || !Number.isSafeInteger(startTime) || startTime > now) continue;
    const group = resources.data.comboGroups[song.comboGroupId];
    if (group?.length !== comboCurve.length || !group.every(({comboCountFrom,scoreUpPermil},index)=>
      comboCountFrom===comboCurve[index][0]&&scoreUpPermil===comboCurve[index][1])) continue;
    const existing = songs.get(row.id);
    const occupied = new Set(existing?.difficulties.filter(chart=>chart.seconds>0).map(chart=>chart.type));
    const additions = row.charts.filter(chart=>!occupied.has(chart.difficulty))
      .map(chart=>compactChart(resources.pack,chart,song,pcSupported?resources.denominators.get(chart.key):null)).filter(Boolean);
    if (!additions.length) continue;
    changed = true;
    const addedKinds = new Set(additions.map(chart=>chart.type));
    const official = resources.optimizerSongRules?.[row.id];
    const base = existing ?? {id:row.id,title:row.title,startTime,comboCurve,
      characterIds:song.characterIds,singerType:song.singerType.toUpperCase(),rateTarget:official?.rateTarget??false,
      ...(official?.autoGiven?{gameUnlock:{autoGiven:true,mainQuestUnlock:null,holomemUnlock:null}}:{})};
    const difficulties=[...existing?.difficulties.filter(chart=>!addedKinds.has(chart.type))??[],...additions];
    difficulties.sort((a,b)=>OPTIMIZER_CHART_DIFFICULTIES.indexOf(a.type)-OPTIMIZER_CHART_DIFFICULTIES.indexOf(b.type));
    songs.set(row.id,{...base,difficulties});
  }
  return changed?{...reference,songs:[...songs.values()]}:reference;
}
