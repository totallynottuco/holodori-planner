const root='/assets/chart-artwork/';
let artworkIndex;

export async function loadChartArtwork(key){
  artworkIndex??=fetch(root+'index.json').then(response=>response.ok?response.json():null).catch(()=>null);
  const layout=(await artworkIndex)?.[key];
  return layout?{layout,url:root+encodeURIComponent(key)+'.png'}:null;
}

function segmentAt(segments,value){
  return segments.findLast(row=>row[2]<=value)??segments[0];
}

export function chartMeasure(layout,seconds){
  const [beat,bpm,atSeconds]=segmentAt(layout.bpms,seconds);
  const beats=beat+(seconds-atSeconds)*bpm/60;
  const [bar,barLength,atBeat]=segmentAt(layout.bars,beats);
  return Math.min(layout.nCols*layout.sentenceLength,Math.max(0,bar+(beats-atBeat)/barLength));
}

function measureY(layout,measure,column){
  return layout.measureHeight*((column+1)*layout.sentenceLength-measure)+2*layout.timePadding;
}

function columnX(layout,column){
  return 2*layout.lanePadding+column*layout.sentenceW;
}

export function chartArtworkMeasurePoint(layout,measure,column=Math.min(layout.nCols-1,Math.floor(measure/layout.sentenceLength))){
  return {column,x:columnX(layout,column),y:measureY(layout,measure,column),width:layout.nLanes*layout.laneWidth};
}

export function chartArtworkPoint(layout,seconds){
  return chartArtworkMeasurePoint(layout,chartMeasure(layout,seconds));
}

export function chartArtworkWindows(layout,start,end){
  const left=chartMeasure(layout,start);
  const right=chartMeasure(layout,end);
  const first=Math.min(layout.nCols-1,Math.floor(left/layout.sentenceLength));
  const last=Math.min(layout.nCols-1,Math.floor(right/layout.sentenceLength));
  return Array.from({length:last-first+1},(_,index)=>first+index).flatMap(column=>{
    const from=Math.max(left,column*layout.sentenceLength);
    const to=Math.min(right,(column+1)*layout.sentenceLength);
    if(to<=from)return [];
    return [{column,x:columnX(layout,column),y:measureY(layout,to,column),
      width:layout.nLanes*layout.laneWidth,height:layout.measureHeight*(to-from)}];
  });
}

export function chartArtworkCrop(layout,start,end){
  const windows=chartArtworkWindows(layout,start,end);
  if(!windows.length)return null;

  // Keep the chart's column order and shade all context outside this skill window.
  const x=Math.max(0,windows[0].x-layout.lanePadding-24);
  const y=Math.max(0,Math.min(...windows.map(window=>window.y))-16);
  const right=Math.min(layout.totalW,windows.at(-1).x+windows.at(-1).width+16);
  const bottom=Math.min(layout.totalH,Math.max(...windows.map(window=>window.y+window.height))+16);
  const width=right-x,height=bottom-y,padding=height*.18;
  const outline=({x,y,width,height})=>`M${x} ${y}h${width}v${height}h${-width}Z`;
  return {
    artwork:{x,y,width,height},
    view:{x,y:y-padding,width,height:height+2*padding},
    shading:outline({x,y,width,height})+windows.map(outline).join(''),
  };
}

export function chartArtworkViewBox(layout,start,end,focus){
  if(focus==null&&start===0&&chartMeasure(layout,end)+.5>=(layout.nCols-1)*layout.sentenceLength)
    return [0,0,layout.totalW,layout.totalH].join(' ');
  const slices=chartArtworkWindows(layout,start,end);
  if(!slices.length)return [0,0,layout.totalW,layout.totalH].join(' ');
  const padding=layout.lanePadding;
  const x=Math.max(0,slices[0].x-padding);
  const width=Math.min(layout.totalW-x,slices.at(-1).x+slices.at(-1).width+padding-x);
  if(focus!=null){
    const point=chartArtworkPoint(layout,focus);
    const height=Math.min(layout.totalH,Math.max(layout.measureHeight*1.45,
      (chartMeasure(layout,end)-chartMeasure(layout,start))*layout.measureHeight));
    const top=Math.max(0,Math.min(layout.totalH-height,point.y-height/2));
    return [point.x-padding,top,point.width+2*padding,height].join(' ');
  }
  if(slices.length>1)return [x,0,width,layout.totalH].join(' ');
  const slice=slices[0];
  const y=Math.max(0,slice.y-padding);
  return [x,y,width,Math.min(layout.totalH-y,slice.y+slice.height+padding-y)].join(' ');
}
