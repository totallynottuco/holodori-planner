import {simple} from 'acorn-walk';

/** Narrow adaptations of actual N8/l6, Xh/g_, e5/b5 and Hm/x8.
 * Original row wrappers, geometry, modal primitives, blocks and handlers remain.
 */
export function capturedCharacterPatches(source,ast) {
  const changes=[],bindings=new Map(),functions=new Map();
  const code=node=>source.slice(node.start,node.end);
  const key=node=>node?.key?.name??node?.key?.value;
  const prop=(object,name)=>object?.properties?.find(node=>key(node)===name);
  const patch=(start,end,value,reason)=>changes.push({start,end,value,reason});
  function landscapeImage(node,id) {
    const props=node.arguments[1],src=prop(props,'src'),classes=prop(props,'class');
    patch(src.value.start,src.value.end,`holoGame.cardImage(${id},"landscape")`,'Full horizontal Holodori card artwork in its captured presentation slot');
    patch(props.start+1,props.start+1,'width:455,height:256,loading:"lazy",decoding:"async",','Reserve the verified card aspect ratio before lazy artwork decoding');
    if(classes)patch(classes.value.start,classes.value.end,'"w-full h-auto object-contain"','Show the complete card illustration without a square portrait crop');
    else patch(props.start+1,props.start+1,'class:"w-full h-auto object-contain",','Show the complete card illustration without a square portrait crop');
  }
  simple(ast,{
    VariableDeclarator(node){if(node.id.type==='Identifier')bindings.set(node.id.name,node.init);},
    FunctionDeclaration(node){functions.set(node.id.name,node);},
  });
  function method(binding,group,name,body) {
    const target=prop(group?prop(bindings.get(binding),group)?.value:bindings.get(binding),name)?.value;
    if(!target?.body)throw Error('Missing captured character member '+binding+'.'+name);
    patch(target.body.start,target.body.end,'{'+body+'}','Holodori controller for captured '+binding+'.'+name);
  }
  method('Hm','computed','traceList','return ["sp"];');
  method('N8','methods','compareGoal',`if(e?.type==="trace")return Number(e.sp?.current??0)>=Number(e.sp?.goal??0);if(e?.type==="character")return Number(e.current?.level??1)>=Number(e.goal?.level??1)&&Number(e.current?.asc??0)>=Number(e.goal?.asc??0);return true;`);
  method('N8','computed','hasAny',`return this.filteredCharacters.some(id=>(this.filters.search.trim()||!this.hideInactive||!this.inactive[id])&&(!this.favoriteOnly||this.goals.some(goal=>goal.character===id&&goal.favorite)));`);
  simple(functions.get('S8').body,{CallExpression(node){
    if(node.arguments[0]?.value==='img'&&node.arguments[1]?.type==='ObjectExpression')
      patch(node.arguments[1].start+1,node.arguments[1].start+1,'alt:"No cards match the current filters",','Name the original empty-result slot and resolve its neutral local image');
  }});

  const expanded=functions.get('x8');
  if(!expanded)throw Error('Missing captured expanded card renderer');
  simple(expanded.body,{
    Literal(node){
      if(node.value===' E')patch(node.start,node.end,'" B"','Bloom stage in actual captured collection badge');
    },
    ConditionalExpression(node){
      if(code(node.test)==='r.traceList.length > 4')
        patch(node.start,node.end,'(r.traceList.length===1?"grid-cols-1":'+code(node)+')','One real SP cell in the original expanded grid');
      if(code(node.test)==='r.weaponGoal')
        patch(node.start,node.end,
          '(o(),l("div",p8,[i("img",{src:holoAsset(`${e.url}img/general/cone.png`),class:"h-5"}),i("span",{class:"text-sm font-semibold ml-2"},"B"+_(r.characterEidolons),1)]))',
          'Actual Bloom current stage in original expanded Bloom row; no invented equipment goal');
      if(code(node.test).includes('r.artifactGoal')&&code(node.test).includes('relics.length'))
        patch(node.start,node.end,
          '(o(),l(A,{key:0},[i("img",{src:holoAsset(`${e.url}img/general/relics.png`),class:"h-5"}),i("span",{class:"font-semibold text-sm ml-2"},_(e.$t("relics")),1)],64))',
          'Original expanded Artwork row opens artwork; no unsupported farming goal');
    },
    CallExpression(node){
      if(['i','l'].includes(node.callee.name)&&node.arguments[0]?.value==='img'&&node.arguments[1]?.type==='ObjectExpression'&&code(prop(node.arguments[1],'src')?.value||node).includes('/characters/'))
        landscapeImage(node,'s.selected');
      if(node.callee.name==='g'&&node.arguments[0]?.name==='h'&&node.arguments[1]?.type==='ObjectExpression') {
        patch(node.arguments[1].start+1,node.arguments[1].start+1,'ascensionLevels:holoGame.ascendedLevels(s.selected),','Correct per-rarity SP-cap marker on actual expanded Level chips');
        if(node.arguments[4]?.type==='ArrayExpression')
          patch(node.arguments[4].end-1,node.arguments[4].end-1,',"ascensionLevels"','Keep original optimized Ke prop updates correct on card changes');
      }
      if(['i','l'].includes(node.callee.name)&&node.arguments[0]?.value==='div'&&node.arguments[1]?.type==='ObjectExpression') {
        const onClick=prop(node.arguments[1],'onClick');
        if(onClick)for(const [sourceMode,mechanic]of [['character','level'],['trace','sp'],['cone','bloom'],['relics','artwork']]) {
          if(code(onClick.value).includes(`r.setMode("${sourceMode}")`))
            patch(node.arguments[1].start+1,node.arguments[1].start+1,`"data-character-section":"${mechanic}",`,'Identify preserved '+mechanic+' row for interaction verification');
        }
        const classes=prop(node.arguments[1],'class');
        if(classes&&code(classes.value).includes('flex flex-col rounded-lg overflow-hidden shadow-md relative h-full'))
          patch(classes.value.start,classes.value.end,'k(["flex flex-col rounded-lg overflow-hidden shadow-md relative h-full w-40",{"rounded-r-none":s.expanded}])','Keep the original card frame at a compact160px in both collection modes');
        if(node.callee.name==='i'&&classes&&code(classes.value).includes('uppercase font-semibold text-xs px-1 py-1 tracking-tight')&&code(node.arguments[2]).includes('r.character.name')) {
          const props=code(node.arguments[1]).replace(/r\.character\.tier\s*===\s*4\s*\?\s*"bg-epic-700"\s*:\s*"bg-legendary-700"/,'r.character.tier===3?"bg-rare-700":r.character.tier===4?"bg-epic-700":"bg-legendary-700"');
          const display='_(r.character.memberName||r.character.name)';
          // Reuse the original Tippy directive already resolved as v in x8.
          // The tooltip carries the full variant; the original primary slot is compact.
          patch(node.start,node.end,`E(i("div",${props},${display},3),[[v,r.character.name,void 0,{arrow:true}]])`,'Compact original member-name slot with complete variant in original tooltip');
        }
      }
    },
  });

  // Removing these source branches also removes their custom-only controls;
  // no catalog-external goal can reach the strict Holodori save boundary.
  simple(functions.get('g_').body,{
    Literal(node){
      if(node.value==='mx-1 mb-3 relative w-20 sm:w-24')patch(node.start,node.end,'"mx-1 mb-3 relative w-36"','Horizontal144px cards in the original650px picker layout');
      if(node.value==='w-20 sm:w-24 h-20 sm:h-24 rounded-xl overflow-hidden relative bg-gradient-to-br')
        patch(node.start,node.end,'"w-36 rounded-xl overflow-hidden relative bg-gradient-to-br"','Use the verified artwork ratio inside the original rounded picker frame');
    },
    CallExpression(node){
      if(['i','l'].includes(node.callee.name)&&node.arguments[0]?.value==='img'&&node.arguments[1]?.type==='ObjectExpression'&&code(prop(node.arguments[1],'src')?.value||node).includes('/characters/'))
        landscapeImage(node,'u.key');
    },
    ConditionalExpression(node){
      if(code(node.test)==='s.replacing'&&code(node).includes('"update:selected", "custom"'))
        patch(node.start,node.end,'C("",true)','Omit unsupported custom-character creation from actual picker');
    },
  });
  simple(functions.get('b5').body,{
    CallExpression(node){
      if(node.callee.name==='i'&&node.arguments[0]?.value==='p'&&node.arguments[1]?.name==='i5') {
        const value=code(node).replace('i5,','{...i5,title:r.character?.name||e.$t(a.selected)},').replace(/,\s*1,?\s*\)$/,',17)');
        patch(node.start,node.end,value,'Expose complete long card names without widening the original editor header');
      }
    },
    ConditionalExpression(node){
      const test=code(node.test);
      if(test.includes('a.editingCustom')&&test.includes('a.selected == "custom"'))
        patch(node.start,node.end,'C("",true)','Omit unsupported HSR-shaped custom-character form');
    },
  });
  return {changes};
}
