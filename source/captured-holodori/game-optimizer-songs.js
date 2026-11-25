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
  const songs = new Map(reference.songs.filter(song=>
    (resources.previewSongStarts?.[song.id]??song.startTime??0)<=now).map(song=>[song.id,song]));
  const pcSupported = catalogPcNoteWeights.every((weight,index)=>resources.pack.pcNoteWeightsPermil.get(index+1)===weight);
  let changed = songs.size !== reference.songs.length;
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
    const chartCoefficients=new Map();
    for(const summary of row.charts){
      const entry=resources.denominators.get(summary.key);
      if(entry?.chartScoreCoefficientPermyriad!=null)
        chartCoefficients.set(summary.difficulty,{level:entry.difficultyLevel,notes:entry.scoringEvents,
          value:(1+song.scoreCoefficientPermil*(entry.difficultyLevel-5)/1000)*entry.chartScoreCoefficientPermyriad/10000});
    }
    const addedKinds = new Set(additions.map(chart=>chart.type));
    const official = resources.optimizerSongRules?.[row.id];
    const base = existing ?? {id:row.id,title:row.title,startTime,comboCurve,
      characterIds:song.characterIds,singerType:song.singerType.toUpperCase(),rateTarget:official?.rateTarget??false,
      ...(official?.autoGiven?{gameUnlock:{autoGiven:true,mainQuestUnlock:null,holomemUnlock:null}}:{})};
    const difficulties=[...existing?.difficulties.filter(chart=>!addedKinds.has(chart.type))??[],...additions].map(chart=>{
      const factor=chartCoefficients.get(chart.type);
      if(!factor||factor.level!==chart.level||factor.notes!==chart.notes||
        (chart.coefficient===factor.value&&(chart.pcCoefficient??factor.value)===factor.value)) return chart;
      return {...chart,coefficient:factor.value,pcCoefficient:factor.value};
    });
    if(!additions.length && difficulties.every((chart,i)=>chart===existing?.difficulties[i])) continue;
    changed = true;
    difficulties.sort((a,b)=>OPTIMIZER_CHART_DIFFICULTIES.indexOf(a.type)-OPTIMIZER_CHART_DIFFICULTIES.indexOf(b.type));
    songs.set(row.id,{...base,difficulties});
  }
  return changed?{...reference,songs:[...songs.values()]}:reference;
}
