/** Yield every slot order exactly once, starting with the proposed order. */
export function* finalistOrders(order) {
  if(order.length!==5 || new Set(order).size!==5)throw Error('A finalist must contain five distinct cards.');
  const slots=[...order];
  function* place(slot){
    if(slot===slots.length){yield slots.slice();return;}
    for(let i=slot;i<slots.length;i++){
      [slots[slot],slots[i]]=[slots[i],slots[slot]];
      yield* place(slot+1);
      [slots[slot],slots[i]]=[slots[i],slots[slot]];
    }
  }
  yield* place(0);
}

/** Keep distinct leader, outfit and funded Board scenarios for each shortlisted card set. */
export function finalistSetups(ranked,limit,scenarioKey){
  const lineups=new Set(),setups=new Set();
  return ranked.filter(row=>{
    const composition=JSON.stringify([scenarioKey?.(row),row.order.slice().sort()]);
    if(!lineups.has(composition)&&lineups.size>=limit)return false;
    lineups.add(composition);
    const setup=JSON.stringify([composition,row.leaderChar,row.outfitId,row.plan?.ranks,
      row.plan?.saves??row.boards,Boolean(row.plan)]);
    if(setups.has(setup))return false;
    setups.add(setup);
    return true;
  });
}
