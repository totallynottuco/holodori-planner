import {simple} from 'acorn-walk';

/** Original Pe/hc, Xh/g_ and N8/l6 DOM, styles and controls stay intact. */
export function capturedFilterPatches(source,ast) {
  const changes=[],bindings=new Map(),functions=new Map(),text=node=>source.slice(node.start,node.end);
  const key=node=>node?.key?.name??node?.key?.value;
  const prop=(object,name)=>object?.properties?.find(node=>key(node)===name);
  const patch=(node,value,reason)=>changes.push({start:node.start,end:node.end,value,reason});
  const insert=(at,value,reason)=>changes.push({start:at,end:at,value,reason});
  simple(ast,{VariableDeclarator(node){if(node.id.type==='Identifier')bindings.set(node.id.name,node.init);},FunctionDeclaration(node){functions.set(node.id.name,node);}});
  patch(prop(prop(bindings.get('lc'),'props').value,'activeItem').value,'[String,Number,Array]','Accept multiple selected values in the original filter component');
  insert(prop(bindings.get('lc'),'props').value.end-1,'textOptions:Boolean,disabled:Boolean,','Text ownership options use the original filter button component');
  insert(bindings.get('cc').start+1,'"disabled","title",','Track ownership availability on the original filter buttons');
  simple(functions.get('hc').body,{
    Literal(node){if(typeof node.value==='string'&&node.value.startsWith('w-9 h-9 md:w-8 md:h-8 flex'))patch(node,`(s.textOptions?${JSON.stringify(node.value.replace('w-9 h-9 md:w-8 md:h-8','h-9 md:h-8 px-2')+' disabled:opacity-40 disabled:cursor-default')}:${JSON.stringify(node.value)})`,'Compact text options retain original filter sizing and selected styling');},
    LogicalExpression(node){if(text(node)==='e.$te(d) && e.$t(d)')patch(node,'(s.disabled?e.$t("ownership_unavailable"):s.icon==="eye-icon"&&d===1?e.$t("show_added_cards"):e.$te(d)&&e.$t(d))','Label the Show added control and explain unavailable ownership in captured tooltips');},
    ConditionalExpression(node){if(text(node.test)==='s.type')patch(node,`(s.textOptions?i("span",{class:"text-xs font-semibold whitespace-nowrap"},_(e.$t(d)),1):${text(node)})`,'Owned and Unowned labels inside the actual captured filter buttons');},
    CallExpression(node){
      if(node.callee.name==='l'&&node.arguments[0]?.value==='button')insert(node.arguments[1].start+1,'disabled:s.disabled,title:s.disabled?e.$t("ownership_unavailable"):undefined,','Disable unknown ownership without treating unimported cards as unowned');
    },
  });
  simple(functions.get('hc').body,{CallExpression(node){if(node.callee.name==='k'&&node.arguments[0]?.type==='ArrayExpression'&&text(node.arguments[0]).includes('"flex items-center my-2"'))insert(node.arguments[0].start+1,'Array.isArray(s.activeItem)&&"gap-0.5",','Separate adjacent multi-select filter outlines with the existing 2px spacing token');}});
  simple(functions.get('hc').body,{BinaryExpression(node){if(text(node)==='s.activeItem == d')patch(node,'cardFilters.selected(s.activeItem,d)','Use original selected styling for every selected filter icon');}});
  for(const name of ['Xh','N8']){
    const node=bindings.get(name);insert(node.start,'configureCardFilters(','Persist original multi-select card filters by profile '+name);
    insert(node.end,`,${name==='N8'})`,'Close the original multi-select filter controller '+name);
    const computed=prop(prop(node,'computed').value,'filteredCharacters').value;
    let count=0;
    simple(computed.body,{LogicalExpression(expr){
      for(const group of ['type','tier','path'])if(expr.left?.type==='UnaryExpression'&&text(expr.left)===`!this.filters.${group}`){
        const card=name==='N8'?`(this.characters[t] || this.customs[t]).${group}`:`this.characters[e].${group}`;
        patch(expr,`cardFilters.matches(${card},this.filters.${group})`,'Multi-select predicate in original '+name+' filter');count++;
      }
    }});
    if(count!==3)throw Error('Missing captured filter predicates '+name);
  }
  for(const [name,component]of [['l6','h']]){
    let added=false;
    simple(functions.get(name).body,{CallExpression(node){
      if(!added&&node.callee.name==='g'&&node.arguments[0]?.name===component&&text(node.arguments[1]).includes('a.filters.tier')){
        insert(node.end,`,g(${component},{textOptions:true,options:["owned","unowned"],onFilter:value=>r.filter("ownership",value),"active-item":r.ownershipAvailable?a.filters.ownership:[],disabled:!r.ownershipAvailable,divider:""},null,8,["active-item","disabled"])`,'Ownership choices beside rarity in the original '+name+' filter row');added=true;
      }
    }});
    if(!added)throw Error('Missing ownership filter insertion '+name);
  }
  let maxed=false;
  simple(functions.get('l6').body,{CallExpression(node){
    if(node.callee.name==='g'&&node.arguments[0]?.name==='h'&&text(node.arguments[1]).includes('options: ["toggle_favorite"]')){
      insert(node.end,',g(h,{icon:"badge-check-icon",options:["hide_maxed_cards"],onFilter:r.toggleMaxed,"is-active":a.filters.hideMaxed},null,8,["onFilter","is-active"])','Hide maxed cards with the original Characters toolbar control');
      maxed=true;
    }
  }});
  if(!maxed)throw Error('Missing Characters toolbar insertion');
  const sortProps=prop(bindings.get('P8'),'props').value;
  insert(sortProps.end-1,',"pickerOptions"','Give the original Characters sort control picker-specific options');
  let sortButton=false,sortMenu=false;
  simple(functions.get('G8').body,{CallExpression(node){
    const [tag,props,children]=node.arguments;
    if(node.callee.name==='i'&&tag?.value==='button'&&text(props).includes('a.isVisible = !a.isVisible')){
      insert(props.start+1,'type:"button","aria-label":"Sort cards","aria-expanded":a.isVisible,title:"Sort cards",','Name the original sort trigger and expose its open state');
      // The compiler treats the original trigger as static, so its expanded state must be tracked.
      insert(children.end,',8,["aria-expanded"]','Keep the original sort trigger accessibility state current');
      sortButton=true;
    }
    if(node.callee.name==='l'&&props?.name==='R8'){
      patch(props,'s.pickerOptions?{...R8,class:R8.class.replace("bg-gray-700/70","bg-gray-700")+" card-picker-sort-menu right-0 whitespace-nowrap"}:R8','Keep the picker menu aligned with an opaque Seelie surface');
      insert(children.start,`s.pickerOptions?[...s.pickerOptions.map(([label,forward,reverse])=>{
        const selected=s.modelValue===forward||s.modelValue===reverse;
        const descending=forward==="name"?s.modelValue===reverse:s.modelValue===forward;
        return i("button",{key:label,type:"button","aria-pressed":selected,"aria-description":selected?(descending?"Descending":"Ascending"):undefined,
          title:label==="Release Date"?"Uses the game's catalog order":undefined,
          class:k(["py-1.5 px-3 hover:bg-gray-500/40 w-full flex items-center gap-1",{"font-bold":selected}]),
          onClick:()=>r.selectOption(s.modelValue===forward?reverse:forward)},[
          T(label),
          i("span",{class:"ml-auto text-gray-400","aria-hidden":"true"},selected?(descending?"↓":"↑"):"",1),
        ],10,["aria-pressed","aria-description","onClick"]);
      }),i("button",{type:"button",class:"py-1.5 px-3 hover:bg-gray-600/50 w-full text-left text-red-400 font-semibold border-t border-gray-500/40",
        onClick:()=>r.selectOption("name")},"Reset")]:`,'Use compact picker sort choices with a direction indicator and reset');
      sortMenu=true;
    }
  }});
  if(!sortButton||!sortMenu)throw Error('Missing original Characters sort renderer');
  const pickerRow=new Map();
  simple(functions.get('g_').body,{CallExpression(node){
    if(node.callee.name==='i'&&['e_','t_','s_'].includes(node.arguments[1]?.name))pickerRow.set(node.arguments[1].name,node);
  }});
  const heading=pickerRow.get('e_'),types=pickerRow.get('t_'),ownership=pickerRow.get('s_');
  if(!heading||!types||!ownership)throw Error('Missing original Add Card filter rows');
  const [rarity,added,search]=ownership.arguments[2].elements;
  const [type,stat]=types.arguments[2].elements;
  changes.push({start:heading.start,end:ownership.end,reason:'Reorganize the original Add Card controls into Search and Refine',value:`
    i("div",{class:"card-picker-toolbar"},[
      ${text(search).replace('i("div", r_, [','i("div", {class:"card-picker-query"}, [g(M("search-icon"),{class:"card-picker-search-icon","aria-hidden":"true"}),').replace('type: "text",','type: "search", "aria-label": e.$t("search"),').replace('class: "absolute right-0 mr-2",','class: "absolute right-0 mr-2", type:"button", "aria-label":"Clear search",')},
      i("button",{type:"button",class:"card-picker-refine-button","aria-expanded":a.refineOpen,
        onClick:()=>{a.refineOpen=!a.refineOpen;}},[
        T("Filters"),
        i("span",{class:"card-picker-filter-count","aria-hidden":"true"},r.refineChips.length?_(" · "+r.refineChips.length):"",1),
      ],8,["aria-expanded"]),
      g(F8,{class:"card-picker-sort",modelValue:a.filters.sort,"onUpdate:modelValue":value=>{a.filters.sort=value;},
        pickerOptions:pickerSortOptions},null,8,["modelValue"]),
    ]),
    i("div",{class:"card-picker-refinements",hidden:!a.refineOpen,role:"group","aria-label":"Card filters"},[
      ${text(type)},${text(stat)},${text(rarity).replace('options: [5, 4]','options: [5, 4, 3]')},
      g(c,{textOptions:true,options:["owned","unowned"],onFilter:value=>r.filter("ownership",value),
        "active-item":r.ownershipAvailable?a.filters.ownership:[],disabled:!r.ownershipAvailable,divider:""},null,8,["active-item","disabled"]),
      ${text(added)},
    ],8,["hidden"]),
    i("div",{class:"card-picker-chips",hidden:a.refineOpen||!r.refineChips.length,role:"group","aria-label":"Active filters"},[
      (o(true),l(A,null,P(r.refineChips,chip=>i("button",{key:chip.group+chip.value,type:"button",
        "aria-label":"Remove "+chip.label,onClick:()=>r.removeRefinement(chip)},[
        T(chip.label),i("span",{"aria-hidden":"true"},"×"),
      ],8,["aria-label","onClick"])),128)),
    ],8,["hidden"])`});
  const pickerGrid=prop(bindings.get('i_'),'class').value;
  patch(pickerGrid,JSON.stringify('card-picker-grid'),'Keep the original card grid at four columns and reflow it when narrow');
  insert(bindings.get('E8').start,'configureFilterSearch(','Show a restored search using the original search field');
  insert(bindings.get('E8').end,')','Close the original saved-search controller');
  simple(functions.get('z8').body,{CallExpression(node){
    if(node.callee.name==='i'&&node.arguments[0]?.value==='button'){
      insert(node.arguments[1].start+1,'type:"button","aria-label":e.$t("search"),','Keep the original magnifier accessible');
    }
  }});
  return {changes,imports:'import {cardFilters,pickerSortOptions} from "/captured/card-filters.ts";\nimport {configureCardFilters,configureFilterSearch} from "/captured/card-filter-ui.js";\n'};
}
