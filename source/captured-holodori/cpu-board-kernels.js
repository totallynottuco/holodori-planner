// Keep the packed inputs and result conventions shared with the WebGPU kernels.
// Match one winner per 64 consecutive mixed-radix orders in the GPU sweep.
// Within a run only the first slot varies, so try it in contribution order.
export function searchTeams(cards,slots,{attribute=0,performance=0,retainAll=false,deduplicate=false}={}){
  const count=slots.reduce((n,slot)=>n*slot.length,1),teams=[],groups=new Map();
  if(!count)return {examined:0,teams};
  const power=cards.map(([,value,type,perf])=>value+(attribute&&type===attribute?Math.floor(value/10):0)+
    Math.floor((Math.imul(perf,performance)>>>0)/100));
  const width=slots[0].length,ranked=slots[0].map((_,i)=>i).sort((a,b)=>power[slots[0][b]]-power[slots[0][a]]||a-b);
  function record(code,value){
    const order=slots.map(slot=>{const id=slot[code%slot.length];code=Math.floor(code/slot.length);return id;});
    if(!deduplicate||retainAll){teams.push({order,power:value});return;}
    const sorted=order.slice().sort((a,b)=>a-b);
    const key=cards.length<=1024?sorted.reduce((n,id)=>n*1024+id,0):sorted.join(',');
    const prior=groups.get(key);
    if(prior)prior.lastOrder=order;
    else{const row={order,power:value};teams.push(row);groups.set(key,row);}
  }
  for(let batch=0;batch<count;batch+=64){
    const end=Math.min(batch+64,count);
    let best=-1,winner=-1;
    for(let start=batch;start<end;){
      const offset=start%width,stop=Math.min(width,offset+end-start);
      let code=Math.floor(start/width);
      const b=slots[1][code%slots[1].length];code=Math.floor(code/slots[1].length);
      const c=slots[2][code%slots[2].length];code=Math.floor(code/slots[2].length);
      const d=slots[3][code%slots[3].length],e=slots[4][Math.floor(code/slots[3].length)];
      const bm=cards[b][0],cm=cards[c][0],dm=cards[d][0],em=cards[e][0];
      if(bm!==cm&&bm!==dm&&bm!==em&&cm!==dm&&cm!==em&&dm!==em){
        for(let i=retainAll?offset:0;i<(retainAll?stop:width);i++){
          const pos=retainAll?i:ranked[i];
          if(pos<offset||pos>=stop)continue;
          const a=slots[0][pos],am=cards[a][0];
          if(am===bm||am===cm||am===dm||am===em)continue;
          const value=power[a]+power[b]+power[c]+power[d]+power[e],index=start-offset+pos;
          if(retainAll)record(index,value);
          else{if(value>best){best=value;winner=index;}break;}
        }
      }
      start+=stop-offset;
    }
    if(winner>=0)record(winner,best);
  }
  return {examined:count,teams};
}

export function checkBoards(moves,stock,{unlimited=false}={}){
  return Uint32Array.from(moves,([points,budget,resets,secondary,...costs])=>
    points<=budget&&resets<=stock[0]&&secondary<=stock[1]&&
    (unlimited||stock.slice(2).every((amount,i)=>costs[i]<=amount))?costs.at(-1):0);
}

export function checkTrades(trades,stock,{unlimited=false}={}){
  const materials=stock.length-1;
  return Uint32Array.from(trades,([points,budget,resets,priority,...costs])=>
    points<=budget&&resets<=stock[0]&&
    (unlimited||stock.slice(1).every((amount,i)=>costs[i]-costs[materials+i]<=amount))?priority:0);
}

export function matchConnects(weights,reserved){
  const rows=weights.length,cards=reserved.length,columns=cards+rows;
  const result=new Uint32Array(rows);
  if(!cards)return result;
  const rowPrice=new Int32Array(rows+1),columnPrice=new Int32Array(columns+1);
  const claims=new Int32Array(columns+1),previous=new Int32Array(columns+1);
  const distance=new Int32Array(columns+1),used=new Uint8Array(columns+1);
  for(let row=1;row<=rows;row++){
    claims[0]=row;
    distance.fill(0x3fffffff);
    used.fill(0);
    let column=0;
    do{
      used[column]=1;
      const owner=claims[column];
      let delta=0x3fffffff,next=0;
      for(let candidate=1;candidate<=columns;candidate++){
        if(used[candidate])continue;
        const weight=candidate<=cards&&!reserved[candidate-1]?weights[owner-1][candidate-1]:0;
        const reduced=-weight-rowPrice[owner]-columnPrice[candidate];
        if(reduced<distance[candidate]){
          distance[candidate]=reduced;
          previous[candidate]=column;
        }
        if(distance[candidate]<delta){
          delta=distance[candidate];
          next=candidate;
        }
      }
      for(let candidate=0;candidate<=columns;candidate++){
        if(used[candidate]){
          rowPrice[claims[candidate]]+=delta;
          columnPrice[candidate]-=delta;
        }else distance[candidate]-=delta;
      }
      column=next;
    }while(claims[column]);
    while(column){
      const prior=previous[column];
      claims[column]=claims[prior];
      column=prior;
    }
  }
  for(let column=1;column<=cards;column++){
    const row=claims[column];
    if(row&&!reserved[column-1]&&weights[row-1][column-1]>0)result[row-1]=column;
  }
  return result;
}
