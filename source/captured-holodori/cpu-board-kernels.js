// Keep the packed inputs and result conventions shared with the WebGPU kernels.
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
