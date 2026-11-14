import {simple} from 'acorn-walk';

/** Adapt the captured ll/xl and Al/Ll input presentation, retaining editing,
 * navigation, +/- actions, validation and exact stored quantities. */
export function capturedQuantityPatches(source,ast) {
  const changes=[],bindings=new Map(),functions=new Map(),text=node=>source.slice(node.start,node.end);
  const key=node=>node?.key?.name??node?.key?.value,prop=(object,name)=>object?.properties?.find(node=>key(node)===name);
  const insert=(at,value,reason)=>changes.push({start:at,end:at,value,reason});
  const patch=(node,value,reason)=>changes.push({start:node.start,end:node.end,value,reason});
  simple(ast,{VariableDeclarator(node){if(node.id.type==='Identifier')bindings.set(node.id.name,node.init);},FunctionDeclaration(node){functions.set(node.id.name,node);}});
  for(const name of ['ll','Al']){const node=bindings.get(name);insert(node.start,'configureInventoryQuantity(','Keep original inventory editor with compact resting quantities '+name);insert(node.end,')','Close original compact quantity controller '+name);}
  let count=0;
  for(const name of ['xl','Ll'])simple(functions.get(name).body,{CallExpression(node){
    if(!['i','l'].includes(node.callee.name)||node.arguments[0]?.value!=='input')return;
    const props=node.arguments[1],value=prop(props,'value'),ref=prop(props,'ref');
    if(ref?.value.value==='addInput'){
      patch(prop(props,'type').value,'"text"','Use the selected number format for additive stock entry');
      insert(props.start+1,'inputmode:"numeric",','Keep the numeric keyboard for additive stock entry');
      return;
    }
    if(text(value?.value||node)!=='r.have'&&ref?.value.value!=='input')return;
    count++;
    insert(props.start+1,'onFocus:r.focusQuantity,onBlur:r.blurQuantity,"aria-label":s.gameItem?.name??e.$t(s.item),"data-inventory-quantity":s.item,','Keep exact quantities in the original focused inventory input');
    if(value&&text(value.value)==='r.have'){
      patch(prop(props,'type').value,'"text"','Use compact text at rest and exact numeric editing on focus');
      patch(value.value,'r.quantityText','Abbreviate the owned total without changing its saved value');
      patch(prop(props,'onInput').value,'event=>r.writeQuantity(event.target.value)','Parse localized stock entry at the captured editor boundary');
      insert(props.start+1,'inputmode:"numeric",','Keep the numeric keyboard for stock entry');
    }
    if(name==='xl')simple(prop(props,'class').value,{Literal(value){if(value.value==='text-sm text-center w-full')patch(value,'"text-sm text-center w-full px-1"','Keep compact totals inside the original 64px inventory field');}});
    insert(node.start,'E(','Use the captured quantity field and tooltip for imported stock');
    insert(node.end,',[[h,s.gameItem?.quantityTooltip??formatNumber(Number(r.have)),void 0,{arrow:true}]])','Show the exact inventory quantity in the original themed tooltip');
  }});
  if(count!==3)throw Error('Missing original inventory quantity inputs');
  for(const name of ['bl','Dl'])insert(bindings.get(name).start+1,'"type","aria-label","data-inventory-quantity",','Refresh compact/exact input properties through original Vue patch flags');
  simple(functions.get('T7').body,{CallExpression(node){
    if(node.callee.name!=='l'||node.arguments[0]?.value!=='input')return;
    const props=node.arguments[1],type=prop(props,'type');
    if(type?.value.value!=='number')return;
    patch(type.value,'"text"','Display localized extra material quantities in the original input');
    insert(props.start+1,'inputmode:"numeric",onBlur:event=>{event.target.value=r.value==null?"":formatNumber(r.value);},','Format committed extra materials');
    patch(prop(props,'value').value,'r.value==null?"":formatNumber(r.value)','Group displayed extra material quantities');
    patch(prop(props,'onInput').value,'event=>{const text=event.target.value,amount=text.trim()?parseNumber(text):0;if(Number.isFinite(amount))e.setCustomItem(s.type,s.item,s.tier,amount);}','Parse localized extra material quantities');
  }});
  return {changes};
}
