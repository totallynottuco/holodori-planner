import {chartArtworkMeasurePoint,chartMeasure} from './optimizer-chart-artwork.js';

const styles={
  hit:['#9fc6ff','#4378e4'],
  flick:['#ffd1ed','#d04c94'],
  hold:['#93f1e5','#268a8a'],
  relay:['#8be8da','#277876'],
  critical:['#fff0a0','#c18d24'],
};

function holdPath(parts,layout,start,end){
  const [from,lane,width]=start;
  const [to,nextLane,nextWidth]=end;
  if(to<=from)return;
  const period=layout.sentenceLength;
  const first=Math.min(layout.nCols-1,Math.floor(from/period));
  const last=Math.min(layout.nCols-1,Math.ceil(to/period)-1);
  for(let column=first;column<=last;column++){
    const a=Math.max(from,column*period),b=Math.min(to,(column+1)*period);
    const one=chartArtworkMeasurePoint(layout,a,column),two=chartArtworkMeasurePoint(layout,b,column);
    const edges=measure=>{
      const t=(measure-from)/(to-from);
      const x=lane-2+(nextLane-lane)*t;
      return [x,x+width+(nextWidth-width)*t];
    };
    const left=(point,lane)=>decimal(point.x+lane*layout.laneWidth+.75);
    const right=(point,lane)=>decimal(point.x+lane*layout.laneWidth-.75);
    const lower=edges(a),upper=edges(b);
    parts.push(`M${left(one,lower[0])},${decimal(one.y)}L${left(two,upper[0])},${decimal(two.y)}H${right(two,upper[1])}L${right(one,lower[1])},${decimal(one.y)}Z`);
  }
}

const decimal=value=>Math.round(value*100)/100;

export function renderGameChartArtwork(chart){
  const {previewGeometry,times,lanes,types}=chart?.events??{};
  if(!previewGeometry||!times?.length||lanes?.length!==times.length||types?.length!==times.length)return null;
  const {layout,holds,critical}=previewGeometry;
  const {nCols,nLanes,sentenceLength,totalW,totalH,laneWidth}=layout;
  const background=[],lanesPath=[],measureLines=[],labels=[];
  for(let column=0;column<nCols;column++){
    const top=chartArtworkMeasurePoint(layout,(column+1)*sentenceLength,column);
    const bottom=chartArtworkMeasurePoint(layout,column*sentenceLength,column);
    background.push(`<rect x="${top.x}" y="${top.y}" width="${top.width}" height="${bottom.y-top.y}" rx="2"/>`);
    for(let lane=1;lane<nLanes;lane++)lanesPath.push(`M${top.x+lane*laneWidth},${top.y}V${bottom.y}`);
    for(let bar=0;bar<sentenceLength;bar++){
      const measure=column*sentenceLength+bar;
      const point=chartArtworkMeasurePoint(layout,measure,column);
      measureLines.push(`M${point.x},${point.y}h${point.width}`);
      labels.push(`<text x="${point.x-8}" y="${point.y+5}">${measure+1}</text>`);
    }
  }
  const holdPaths=[];
  for(const hold of holds){
    for(let i=1;i<hold.length;i++){
      const before=hold[i-1],after=hold[i];
      holdPath(holdPaths,layout,[chartMeasure(layout,before[0]),before[1],before[2]],
        [chartMeasure(layout,after[0]),after[1],after[2]]);
    }
  }
  const heads={hit:[],flick:[],hold:[],relay:[],critical:[]},flicks=[];
  for(let i=0;i<times.length;i++){
    const type=types[i];
    if(type===5)continue;
    const lane=lanes[i]>>>4,width=lanes[i]&15;
    if(lane<2||width<1||lane+width>nLanes+2)continue;
    const point=chartArtworkMeasurePoint(layout,chartMeasure(layout,times[i]/1e6));
    const x=point.x+(lane-2)*laneWidth+1,noteWidth=width*laneWidth-2;
    const isFlick=type===2||type===7;
    const style=critical?.[i]?'critical':isFlick?'flick':type===1?'hit':type===4?'relay':'hold';
    const height=type===4?5:9;
    heads[style].push(`<rect x="${x}" y="${decimal(point.y-height/2)}" width="${noteWidth}" height="${height}" rx="2"/>`);
    if(isFlick){
      const center=x+noteWidth/2,y=decimal(point.y-height*.5-2);
      flicks.push(`M${center-5},${y}l5,-5 5,5`);
    }
  }
  const svg=[
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}">`,
    '<rect width="100%" height="100%" fill="#151d32"/>',
    `<g fill="#202a42">${background.join('')}</g>`,
    `<path d="${lanesPath.join('')}" stroke="#34425e" fill="none"/>`,
    `<path d="${measureLines.join('')}" stroke="#65718f" fill="none"/>`,
    `<g font-family="sans-serif" font-size="14" fill="#adbbd7" text-anchor="end">${labels.join('')}</g>`,
    `<path d="${holdPaths.join('')}" fill="#4ab8ac" fill-opacity=".55"/>`,
    ...Object.entries(styles).map(([type,[fill,stroke]])=>`<g fill="${fill}" stroke="${stroke}">${heads[type].join('')}</g>`),
    `<path d="${flicks.join('')}" fill="none" stroke="#fbdff2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    '</svg>',
  ].join('');
  const url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));
  return {layout,url,release:()=>URL.revokeObjectURL(url)};
}
