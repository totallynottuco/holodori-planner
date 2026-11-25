import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {parse} from 'acorn';
import {simple,ancestor} from 'acorn-walk';
import {build} from 'esbuild';
import {buildOptimizerWorkspace} from '../source/captured-holodori/optimizer-workspace-data.js';
import {normalizeOptimizerEvents} from '../source/captured-holodori/optimizer-events.js';
import {projectChallengeStages} from './mobile-scoring/project-challenge-stages.mjs';
import {capturedPlannerPatches} from './captured-planner-patches.mjs';
import {adaptCapturedData,adaptCapturedLazyAssets,stripGameHistoryCss} from './captured-data-boundaries.mjs';
import {capturedCharacterPatches} from './captured-character-patches.mjs';
import {capturedSettingsPatches} from './captured-settings-patches.mjs';
import {capturedFilterPatches} from './captured-filter-patches.mjs';
import {capturedQuantityPatches} from './captured-quantity-patches.mjs';

const root=path.resolve(import.meta.dirname,'..');
const archive=path.join(root,'template-backup/hsr-template-1.0.2-build3/retired-runtime');
const out=path.join(root,'hololive-dist'),stage=path.join(root,'.captured-build');
const sourcePath=path.join(archive,'source/upstream-app.js');
const source=await fs.readFile(sourcePath,'utf8');
const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'});
const metadata=JSON.parse(await fs.readFile(path.join(root,'build-info.json'),'utf8'));
const footer=JSON.parse(await fs.readFile(path.join(root,'footer-disclaimer.json'),'utf8'));
const changes=[],bindings=new Map(),functions=new Map();
const text=node=>source.slice(node.start,node.end);
const key=node=>node?.key?.name??node?.key?.value;
const prop=(object,name)=>object?.properties?.find(node=>key(node)===name);
const patch=(start,end,value,reason)=>changes.push({start,end,value,reason});
simple(ast,{VariableDeclarator(node){if(node.id.type==='Identifier')bindings.set(node.id.name,node.init);},FunctionDeclaration(node){functions.set(node.id.name,node);}});
const replaceInit=(name,value,reason)=>{const node=bindings.get(name);if(!node)throw Error('Missing captured binding '+name);patch(node.start,node.end,value,reason);};
const replaceFunction=(name,body,reason=name)=>{const node=functions.get(name);if(!node)throw Error('Missing captured function '+name);patch(node.body.start,node.body.end,'{'+body+'}',reason);};
const replaceMethod=(name,body,reason=name)=>{let count=0;simple(ast,{Property(node){if(node.method&&key(node)===name){patch(node.value.body.start,node.value.body.end,'{'+body+'}',reason);count++;}}});if(!count)throw Error('Missing captured method '+name);};
const replaceObjectMethod=(binding,group,name,body)=>{const object=bindings.get(binding),member=prop(group?prop(object,group)?.value:object,name);if(!member?.value?.body)throw Error(`Missing ${binding}.${group||''}.${name}`);patch(member.value.body.start,member.value.body.end,'{'+body+'}',`Game boundary ${binding}.${name}`);};

patch(0,0,'import {game as holoGame} from "/captured/game.js";\nimport {asset as holoAsset,publicAsset as holoPublic,neutralSidebar as holoSidebar} from "/captured/assets.js";\nimport {configureCharacterEditor,createTrainingEditor,createBloomEditor,configureGoalTabs} from "/captured/editor.js";\nfunction i(...args){if(args[0]==="img"&&args[1]?.src)args[1]={...args[1],src:holoAsset(args[1].src),decoding:"async"};return capturedI(...args);}\nfunction l(...args){if(args[0]==="img"&&args[1]?.src)args[1]={...args[1],src:holoAsset(args[1].src),decoding:"async"};return capturedL(...args);}\n','Holodori data and asset adapters; original Vue renderer retained');
for(const declaration of ast.body.filter(node=>node.type==='ImportDeclaration'))for(const specifier of declaration.specifiers){if(specifier.local.name==='i')patch(specifier.local.start,specifier.local.end,'capturedI','Original Vue image factory with game asset URL adapter');if(specifier.local.name==='l')patch(specifier.local.start,specifier.local.end,'capturedL','Original Vue block factory with game asset URL adapter');}
patch(0,0,'import {formatNumber,parseNumber,formatDate,validNumberFormat,validDateFormat} from "/captured/regional-formats.js";\n','Use saved number and date formats in original display boundaries');
const planner=capturedPlannerPatches(source,ast);changes.push(...planner.changes);patch(0,0,planner.imports,'Original energy controller adaptation');
changes.push(...capturedCharacterPatches(source,ast).changes);
changes.push(...capturedQuantityPatches(source,ast).changes);
const cardFilterPatches=capturedFilterPatches(source,ast);changes.push(...cardFilterPatches.changes);patch(0,0,cardFilterPatches.imports,'Original multi-select card filters and per-profile persistence');
simple(functions.get('Vi').body,{CallExpression(node){
  if(node.callee.name==='i'&&node.arguments[0]?.value==='img'&&node.arguments[1]?.type==='ObjectExpression'){
    const src=prop(node.arguments[1],'src');
    if(src&&text(src.value).includes('flags/${u}.svg'))patch(node.arguments[1].start+1,node.arguments[1].start+1,'loading:"lazy",','Defer hidden language-menu flags while keeping the current language flag eager');
  }
}});
const settingsPatches=capturedSettingsPatches(source,ast);changes.push(...settingsPatches.changes);patch(0,0,settingsPatches.imports,'Original Settings controller adaptation');
patch(0,0,'import {configureMaterialPlanner,configureExtraMaterials,createMaterialJarSummary,createBloomPlanSummary} from "/captured/material-ui.js";\nconst holoJarSummary=createMaterialJarSummary({h:i});\nconst holoBloomPlanSummary=createBloomPlanSummary({h:i});\n','Original Planner material controller adaptation');
patch(0,0,'import {configureInventory,createInventoryConversions,inventoryQuantity,configureInventoryQuantity,compactQuantity,inventoryCategories,isGameInventoryId,clearGameInventory} from "/captured/inventory-ui.js";\n','Original Inventory controller and Holodori conversion extension');
for(const [name,factory]of [['rb','configureMaterialPlanner'],['O7','configureExtraMaterials']]){const node=bindings.get(name);patch(node.start,node.end,`${factory}(${text(node)})`,'Original Planner controller with Holodori requirements '+name);}

// Replace game payloads at their original bindings; the application still runs
// its captured Vue options, render functions, library and store.
for(const [name,value] of Object.entries({pk:'holoGame.characters',mk:'{}',gk:'{}',yk:'holoGame.items',Us:'{}',vk:'{}',fk:'{}',bk:'[]',Js:'[]',Me:'{}',U4:'Object.fromEntries(Object.keys(holoGame.characters).map(id=>[id,holoGame.getCard(id)?.animation?2:1]))',Vs:'["sp"]'}))replaceInit(name,value,'Replace game-specific payload '+name);
const dataFunction=prop(bindings.get('$k'),'data').value;
simple(dataFunction.body,{ReturnStatement(node){if(node.argument?.type==='ObjectExpression'){
  const gameFields=new Set(['characters','cones','relics','items','farming','drops','resin','bonusTraces','newBonusTraces','maxTier','types','paths','talentTypes','tierClass','itemTierClass','customBonus']);
  for(const field of node.argument.properties)if(gameFields.has(key(field)))patch(field.value.start,field.value.end,`holoGame.data()[${JSON.stringify(key(field))}]`,'Game data field '+key(field));
}}});
for(const name of ['characterCosts','traceCosts','goalCosts','progressCosts','consumeCosts','getInventory','getCraft','getTotal','getMissing','getReplace'])replaceMethod(name,`return holoGame.${name}.apply(this,arguments);`,'Verified Holodori '+name);
replaceMethod('getType','return holoGame.getType.apply(this,arguments);');
replaceMethod('abbr','return e>999999?formatNumber(Math.round(e/1e5)/10)+"m":e>999?formatNumber(t?Math.ceil(e/100)/10:Math.ceil(e/1e3))+"k":formatNumber(Math.ceil(e));','Use regional separators in captured compact material totals');
simple(ast,{CallExpression(node){
  if(node.callee.type!=='MemberExpression'||node.callee.property.name!=='format')return;
  const pattern=node.arguments[0]?.value;
  if(pattern==='MMM D, YYYY'||pattern==='DD/MM/YYYY')patch(node.start,node.end,'formatDate(e.dayjs(y.date).toDate())','Show captured history dates in the selected date format');
}});
replaceMethod('totalCosts','return holoGame.totalCosts.call(this);','Deduplicated Holodori total material costs');
const sharedComputed=prop(bindings.get('Sk'),'computed').value;
patch(sharedComputed.start+1,sharedComputed.start+1,'materialSupply(){return holoGame.materialSupply.call(this);},','Share one jar and exchange plan across material views');
replaceMethod('coneCosts','return {};');
replaceMethod('getEstimatedRuns','return {runs:0,unobtainable:false};');
replaceMethod('getSubjectEstimatedRuns','return {runs:0,unobtainable:false};');
replaceMethod('getSubjectMissing','return Math.max(0,Number(n)-this.getTotal(e,t,s));');
replaceObjectMethod('ll','methods','crafted','return holoGame.craft.call(this,this.item);');

const addGoal=prop(prop(bindings.get('$k'),'methods')?.value,'addGoal') || prop(prop(bindings.get('Sk'),'methods')?.value,'addGoal');
if(!addGoal)throw Error('Missing original addGoal');
simple(addGoal.value.body,{VariableDeclarator(node){if(node.init?.type==='CallExpression'&&node.init.callee.name==='te')patch(node.start,node.start,'','');}});
const originalAdd=text(addGoal.value.body),addNeedle='const n = te(this.account, { goals: t });';
const addAt=source.indexOf(addNeedle,addGoal.value.body.start);
if(addAt<0||addAt>addGoal.value.body.end)throw Error('Missing original goal commit');
patch(addAt,addAt,'t=holoGame.normalizeGoals(t,e);\n','Synchronize Holodori current Level/SP before original goal commit');
const progress=source.indexOf('Gt(this.goalCosts(a), this.goalCosts(r))');
if(progress<0)throw Error('Missing captured progress cost expression');
patch(progress,progress+'Gt(this.goalCosts(a), this.goalCosts(r))'.length,'this.progressCosts(a,t)','Exact rounded Holodori conversion fees for partial progress');
const progressCommit=source.indexOf('s[n] = r;',progress);
patch(progressCommit+'s[n] = r;'.length,progressCommit+'s[n] = r;'.length,'s=holoGame.normalizeGoals(s,r);','Keep both captured Level/SP records coherent after completion');
simple(functions.get('g1').body,{ReturnStatement(node){const result=node.argument?.type==='SequenceExpression'?node.argument.expressions.at(-1):null;if(result?.name==='s')patch(result.start,result.end,'holoGame.normalizeProgress(e,s)','Carry partial EXP only while the actual current Level remains unchanged');}});

// Original picker/renderers are used by reference for both Level and SP.
const fsNode=bindings.get('fs');patch(fsNode.start,fsNode.end,`configureCharacterEditor(${text(fsNode)})`,'Configure captured Ih/qh level states');
patch(fsNode.end,fsNode.end,', holoTrainingEditor=createTrainingEditor(fs), holoBloomEditor=createBloomEditor(fs)','Reuse actual qh/OverlayPanel/Ke renderer for SP and Bloom');
const rh=bindings.get('Rh');patch(rh.start,rh.end,`configureGoalTabs(${text(rh)})`,'Adapt goal indicators to Holodori records');
patch(0,0,'import {configureCardDialog} from "/captured/editor.js";\n','Preserve the captured card Dialog focus after loading existing data');
const cardDialog=bindings.get('st');patch(cardDialog.start,cardDialog.end,`configureCardDialog(${text(cardDialog)})`,'Focus the original Dialog after its saved-card content renders');
patch(0,0,'import {createCardStats} from "/captured/card-stats-ui.js";\nconst holoCardStats=createCardStats({h:i,vnode:g,resolve:M,withDirectives:E,vShow:ve});\n','Compact card stats inside the original captured card editor');
simple(functions.get('b5').body,{CallExpression(node){if(node.callee.name==='V'&&node.arguments[0]?.name==='$'&&node.arguments[1]?.type==='ObjectExpression'){
  const original='g'+text(node).slice(1);
  patch(node.start,node.end,`l(A,{key:5},[${original},g(holoCardStats,{cardId:a.selected,goals:e.goals,account:e.account,active:r.isVisible},null,8,["cardId","goals","account","active"])],64)`,'Read-only stats disclosure follows existing Level/SP/Bloom content in the captured Dialog');
}}});
simple(functions.get('b5').body,{CallExpression(node){if(node.callee.name==='g'&&node.arguments[0]?.name==='S'&&node.arguments[1]?.type==='ObjectExpression')patch(node.arguments[1].start+1,node.arguments[1].start+1,'ref:"characterDialog",','Use the actual captured card Dialog container for focus');}});
simple(functions.get('hc').body,{CallExpression(node){if(node.callee.name==='l'&&node.arguments[0]?.value==='button'&&node.arguments[1]?.type==='ObjectExpression')patch(node.arguments[1].start+1,node.arguments[1].start+1,'"aria-label":s.icon==="eye-icon"&&d===1?e.$t("show_added_cards"):e.$te(d)?e.$t(d):typeof d==="number"?e.$t("tier")+" "+d:String(d),"aria-pressed":!!(s.isActive||cardFilters.selected(s.activeItem,d)),','Name original filter icons using their own tooltip translations');}});
const filterProps=bindings.get('cc');patch(filterProps.start+1,filterProps.start+1,'"aria-label","aria-pressed",','Update original filter accessibility state with its existing active styling');
simple(functions.get('b5').body,{CallExpression(node){
  if(!['i','l'].includes(node.callee.name)||node.arguments[0]?.value!=='button'||node.arguments[1]?.type!=='ObjectExpression')return;
  const click=prop(node.arguments[1],'onClick');if(!click)return;const handler=text(click.value);
  const label=handler.includes('a.selected = null')?'Back to cards':handler.includes('r.remove &&')?'Delete card':(handler.includes('r.isVisible = !1')||handler.includes('e.characterModal = !1'))?'Close card editor':handler.includes('r.toggleFavorite')?'Favorite card':handler.includes('r.selectCons')?(handler.includes('- 1')?'Decrease Bloom':'Increase Bloom'):null;
  if(label)patch(node.arguments[1].start+1,node.arguments[1].start+1,`"aria-label":${JSON.stringify(label)},`,'Name the original card editor icon action '+label);
}});
simple(functions.get('Kh').body,{VariableDeclarator(node){if(node.id.name==='d'&&node.init?.name==='ys')patch(node.init.start,node.init.end,'holoTrainingEditor','SP tab uses the actual captured Level component');if(node.id.name==='u'&&node.init?.name==='Ct')patch(node.init.start,node.init.end,'holoBloomEditor','Bloom tab reuses captured selector');},
  CallExpression(node){if(node.callee.name==='g'&&node.arguments[0]?.name==='u'&&node.arguments[1]?.type==='ObjectExpression')patch(node.arguments[1].start,node.arguments[1].end,'{selected:s.selected}','Bloom card identifier');if(node.callee.name==='g'&&node.arguments[0]?.name==='h')patch(node.start,node.end,'C("",true)','Artwork uses the existing captured Share artwork dialog');},
  AssignmentExpression(node){if(node.left.type==='MemberExpression'&&node.left.object.name==='a'&&node.left.property.name==='mode'&&node.right.value==='relics')patch(node.start,node.end,'e.openArtwork()','Open the actual captured artwork editor');}
});
const provider=prop(bindings.get('e5'),'provide').value;
patch(provider.body.start,provider.body.end,'{return {setMode:value=>{if(value==="relics"){this.sharing=true;return;}this.preMode=value;},openArtwork:()=>{this.sharing=true;}};}','Expose original sharing/artwork dialog to the preserved tab button');
const bloomSelect=prop(prop(bindings.get('e5'),'methods').value,'selectCons').value;
simple(bloomSelect.body,{Literal(node){if(node.value===6)patch(node.start,node.end,'5','Bloom maximum stage');}});
const chipProps=prop(bindings.get('$h'),'props').value;
patch(chipProps.end-1,chipProps.end-1,',ascensionLevels:Object','Pass card-specific SP caps to the original Level chip');
replaceObjectMethod('$h',null,'data','return {ascended:{}};');
simple(functions.get('Sh').body,{MemberExpression(node){if(text(node)==='a.ascended[s.level.level]')patch(node.start,node.end,'s.ascensionLevels?.[s.level.level]','Use rarity-specific SP upgrade marker');}});
simple(functions.get('qh').body,{
  Literal(node){if(node.value==='current_level')patch(node.start,node.end,'(s.section==="sp"?"current_sp":s.section==="bloom"?"current_bloom":"current_level")','Game-specific selector label');if(node.value==='goal_level')patch(node.start,node.end,'(s.section==="sp"?"goal_sp":s.section==="bloom"?"goal_bloom":"goal_level")','Game-specific goal label');},
  BinaryExpression(node){
    if(node.operator==='<'&&text(node.left)==='a.current.level'&&node.right.value===80)patch(node.start,node.end,'(s.section!=="bloom"&&a.current.level<(s.section==="sp"?4:holoGame.rulesFor(s.selected).maxLevel))','Use actual game cap and current-only Bloom tracking');
    if(text(node)==='JSON.stringify(a.current) !== JSON.stringify(a.goal)')patch(node.start,node.end,'(s.section!=="bloom"&&a.current&&a.goal&&(a.current.level!==a.goal.level||(s.section==="level"&&a.current.asc!==a.goal.asc)))','Compare game progress rather than presentation metadata');
  },
  LogicalExpression(node){if(node.operator==='||'&&text(node.left)==='!a.current'&&text(node.right).includes('a.current.level < 80'))patch(node.start,node.end,'(!a.current||a.current.level<(s.section==="bloom"?5:s.section==="sp"?4:holoGame.rulesFor(s.selected).maxLevel))','Use original goal controls for Level, SP and Bloom');},
  CallExpression(node){
    if(node.callee.name==='g'&&node.arguments[0]?.name==='d'&&node.arguments[1]?.type==='ObjectExpression'){
      patch(node.arguments[1].start+1,node.arguments[1].start+1,'ascensionLevels:a.ascended,','Original Level chips receive the selected card caps');
      if(node.arguments[4]?.type==='ArrayExpression')patch(node.arguments[4].start+1,node.arguments[4].start+1,'"ascensionLevels",','Refresh source chip SP markers when changing card rarity');
    }
    if(node.callee.name==='i'&&node.arguments[0]?.value==='button'&&node.arguments[1]?.type==='ObjectExpression'){
      const click=prop(node.arguments[1],'onClick');
      if(click&&/e\.\$refs\.character(?:Current|Goal)\.toggle/.test(text(click.value))){const which=text(click.value).includes('characterCurrent')?'current':'goal';patch(node.arguments[1].start+1,node.arguments[1].start+1,`"aria-label":e.$t(s.section==="sp"?"${which}_sp":s.section==="bloom"?"${which}_bloom":"${which}_level"),`,'Label source selector controls while retaining their numeric display');}
    }
    if(text(node)==='e.characterCosts(this.characterGoal)')patch(node.start,node.end,'(s.section==="sp"?e.traceCosts(this.characterGoal):s.section==="bloom"?{}:e.characterCosts(this.characterGoal))','Original inline material tiles use selected Holodori mechanic costs');
    if(['i','l'].includes(node.callee.name)&&node.arguments[0]?.value==='img'&&text(node).includes('img/general/ascension.png'))patch(node.start,node.end,'C("",true)','Remove retained ascension images from numeric Level selectors');
    if(node.callee.name==='V'&&node.arguments[0]?.name==='h'&&node.arguments[1]?.type==='ObjectExpression')patch(node.arguments[1].start+1,node.arguments[1].start+1,'skills:["sp"],','Use numeric SP progress in the original progress dialog');
  },
  ArrowFunctionExpression(node){if(text(node).startsWith('(p) =>')&&text(node).includes('p.level > a.current.level'))patch(node.body.start,node.body.end,'(!a.current||p.level>=a.current.level)','An SP unlock must never lower the planned level');}
});
simple(functions.get('Sh').body,{CallExpression(node){if(node.callee.name==='i'&&node.arguments[0]?.value==='img')patch(node.start,node.end,'C("",true)','Plain numeric options in the captured Level picker');}});
replaceObjectMethod('Rh','computed','anyTraceGoal','return !!this.traceGoal&&this.traceGoal.sp.goal>this.traceGoal.sp.current;');
replaceFunction('Ds','return ["sp"];','Holodori training skill list');
replaceFunction('E1','const n=JSON.parse(JSON.stringify(e));if(e.type==="trace"){n.sp={...e.sp,current:Math.min(t?.sp?.current??0,e.sp.goal)};n.bonus={};}else n.current=t?.current?{...t.current}:{level:1,asc:0};return n;','Holodori readiness baseline');
replaceFunction('Q4','return [{type:"character",character:t,current:{level:1,asc:0},goal:{level:holoGame.rulesFor(t).maxLevel,asc:4}},{type:"trace",character:t,sp:{current:0,goal:4},bonus:{}}];','Verified maximum Level/SP share targets');
replaceFunction('I1','return e.type==="trace"?!!e.sp&&(e.sp.current>0||e.sp.goal>0):!!e.goal&&(e.goal.level>1||e.goal.asc>0||e.current.level>1);','Configured Holodori readiness goals');
patch(functions.get('T1').body.start+1,functions.get('T1').body.start+1,'e=holoGame.readinessContext(e,t,s);','Read-only Holodori costs and stock for original readiness engine');
simple(functions.get('T1').body,{Identifier(node){if(node.name==='M1')patch(node.start,node.end,'holoGame.rulesFor(t).maxLevel','Correct card rarity level cap in shared artwork');}});

// Keep Seelie's Achievements page, search, category rail and row containers.
// The checklist fills the original page slot with Holodori groups and tiers.
patch(0,0,'const holoTierSlot={props:{content:Object},render(){return i("div",Lw,[this.content]);}};\nconst holoChecklist=Z1(()=>import("/captured/achievements-ui.js").then(({createAchievements})=>createAchievements({h:i,vnode:g,resolve:M,Search:Ys,Toggle:Ae,Rail:sw,Row:Qs,OverlayPanel:N1,headingClass:ow.class,titleClass:lw.class})));\n','Lazy Holodori achievement checklist in the captured Vue runtime');
patch(0,0,'const holoProgress=Z1(()=>import("/captured/account-progress-ui.js").then(({createAccountProgress})=>createAccountProgress({h:i,vnode:g,resolve:M,Search:Ys,OverlayPanel:N1,Dialog:le,Toggle:Ae,headingClass:ow.class,titleClass:lw.class})));\n','Lazy account progress and Board in the captured Vue shell');
patch(0,0,'const holoLeaderboards=Z1(()=>import("/captured/holomem-leaderboard-ui.js").then(({createHolomemLeaderboards})=>createHolomemLeaderboards({h:i,reactive:ea,vnode:g,resolve:M,Search:Ys,Dialog:le,headingClass:ow.class,titleClass:lw.class})));\n','Lazy Holomem Leaderboards');
patch(0,0,'const importTeamOptimizer=()=>import("/captured/team-optimizer-ui.js");\nconst prepareTeamOptimizer=async()=>{const module=await importTeamOptimizer();await module.prepareOptimizerWorkspace().catch(()=>{});};\nconst holoTeamOptimizer=()=>importTeamOptimizer().then(({createTeamOptimizer})=>createTeamOptimizer({h:i,vnode:g,resolve:M,Search:Ys,Dialog:le,Toggle:Ae,headingClass:ow.class,titleClass:lw.class}));\n','Resolve the optimizer catalog before entering its captured route');
patch(0,0,'import {holoKeepAlive} from "./vendor-8ba3b986.js";\n','Reuse the captured Vue KeepAlive component for the optimizer route');
simple(functions.get('Jo').body,{CallExpression(node){
  if(text(node)!=='g(z)')return;
  patch(node.start,node.end,'g(z,null,{default:R(({Component})=>Component?[g(holoKeepAlive,{include:"HolodoriTeamOptimizer"},{default:R(()=>[e.$route.path==="/team-optimizer"?g(Component,{key:e.account,profileKey:e.account}):Component]),_:2},1024)]:[]),_:1})','Keep the optimizer and its search worker mounted per profile across sidebar navigation');
}});
replaceInit('iw','{data(){return {isLoading:false};}}','Keep the captured Achievements page frame with offline data');
const achievementFrame=functions.get('Cw').body.body[0];
patch(achievementFrame.start,achievementFrame.end,'const f=vC;','Keep the captured page container and remove retired achievement children');
simple(functions.get('Cw').body,{Property(node){
  const render=node.value?.arguments?.[0];
  if(key(node)==='default'&&node.value?.callee?.name==='R'&&render?.body?.type==='ArrayExpression'&&text(render.body).includes('r.flatAchievements')){
    patch(render.body.start,render.body.end,'[g(holoChecklist,{account:e.account},null,8,["account"])]','Compact Checklist in the original Achievements page slot');
  }
}});
const searchProps=prop(bindings.get('zC'),'props').value;
patch(searchProps.start+1,searchProps.start+1,'label:String,clearLabel:String,','Reuse the original search across screens');
simple(functions.get('PC').body,{CallExpression(node){
  if(node.callee.name==='i'&&node.arguments[1]?.name==='LC')patch(node.start,node.end,'C("",true)','Keep original search without the source game version picker');
  if(['i','l'].includes(node.callee.name)&&['input','button'].includes(node.arguments[0]?.value)&&node.arguments[1]?.type==='ObjectExpression'){
    const input=node.arguments[0].value==='input',props=node.arguments[1];
    patch(props.start+1,props.start+1,input?'"aria-label":s.label||"Search achievements",':'type:"button","aria-label":s.clearLabel||(s.label?"Clear member search":"Clear achievement search"),','Label the captured search and clear controls by screen');
    if(input){
      const placeholder=prop(props,'placeholder').value;
      patch(placeholder.start,placeholder.end,'s.label||e.$t("search")','Use the member-search label in Progress');
    }
  }
}});
replaceInit('HC','{props:{isActive:Boolean,categoryName:String,icon:String,summary:Object},emits:["select"],computed:{done(){return this.summary?.done},total(){return this.summary?.total},percent(){return this.done==null||!this.total?0:Math.floor(this.done*100/this.total)},trashed(){return 0}}}','Original category rail reads imported tier totals');
simple(functions.get('tw').body,{ConditionalExpression(node){
  if(text(node.test).startsWith('r.filteredAchievements.length'))patch(node.test.start,node.test.end,'true','Show achievement categories and the all-categories filter scope');
},BinaryExpression(node){
  if(text(node)==='r.done == r.total')patch(node.start,node.end,'r.done!=null&&r.done===r.total','Keep All categories and unknown progress at normal contrast');
},CallExpression(node){
  const [tag,props,,flag]=node.arguments;
  if(node.callee.name==='l'&&tag?.value==='div'&&props?.type==='ObjectExpression'&&prop(props,'onClick')){
    patch(tag.start,tag.end,'"button"','Use a keyboard-accessible category button');
    patch(props.start+1,props.start+1,'type:"button","aria-pressed":s.isActive,','Expose the active achievement category');
    const click=prop(props,'onClick');
    patch(click.value.start,click.value.end,'t[0]||(t[0]=()=>e.$emit("select"))','Use the same rail activation for keyboard and pointer');
    patch(flag.start,flag.end,'10,["aria-pressed"]','Keep captured rail accessibility state reactive');
  }
  if(node.callee.name==='i'&&tag?.value==='img'){
    const src=prop(props,'src');patch(src.value.start,src.value.end,'s.icon','Use the official game category artwork');
    patch(props.start+1,props.start+1,'alt:"",','Decorative achievement category artwork');
  }
  if(node.callee.name==='i'&&props?.name==='JC'){
    patch(node.start,node.start,'(s.summary?', 'Only category progress rows have a completion meter');
    patch(node.end,node.end,':C("",false))', 'Omit the All categories meter with a valid captured Vue placeholder');
  }
  if(node.callee.name==='T'&&text(node).includes('_(r.percent)'))patch(node.arguments[0].start,node.arguments[0].end,'(r.done==null?"—":formatNumber(r.done))+" / "+formatNumber(r.total)','Unknown progress remains unknown in the captured rail');
}});
replaceInit('zw','{props:{content:Object,complete:Boolean},computed:{allDone(){return this.complete},allTrashed(){return false}}}','Original achievement row skin with read-only game status');
simple(functions.get('Pw').body,{ConditionalExpression(node){
  if(text(node.test)==='s.achievement.length > 1')patch(node.start,node.end,'g(holoTierSlot,{content:s.content},null,8,["content"])','Holodori tier disclosure in the original achievement row');
},CallExpression(node){
  if(node.callee.name==='i'&&node.arguments[1]?.name==='Ow')patch(node.start,node.end,'C("",false)','Keep group artwork in the checklist header only');
}});

// Deferred schedules and HSR-only game/online sections have no running entry.
for(const name of ['allEvents','permanentTasks','checkOldData','checkOldTraces','checkDuplicates','checkOldTasks']){
  let found=false;simple(ast,{Property(node){if(node.method&&key(node)===name){patch(node.value.body.start,node.value.body.end,name==='allEvents'||name==='permanentTasks'?'{return [];}':'{return true;}','Deferred or inapplicable game migration '+name);found=true;}}});
}
replaceInit('_k','[{path:"/",redirect:"/characters"},{path:"/characters",component:c6},{path:"/planner",component:Tb},{path:"/inventory",component:mC},{path:"/achievements",component:ww},{path:"/progress",component:holoProgress},{path:"/team-optimizer",component:holoTeamOptimizer,beforeEnter:prepareTeamOptimizer},{path:"/leaderboards",component:holoLeaderboards},{path:"/settings",component:zm},{path:"/:pathMatch(.*)*",redirect:"/characters"}]','Add Progress, Team Optimizer and Leaderboards to the captured router');
for(const name of ['Ha','ol','I4','hn','wi','k7','by'])replaceFunction(name,'return null;','Remove online-only or retired game settings component '+name);
for(const name of ['f4','Hg','dy','u4'])replaceInit(name,'{render(){return null;}}','Remove online game account/import controller '+name);
replaceInit('is','{}','Remove cloud synchronization provider');
const shellOptions=bindings.get('Ao');
const shellMixins=prop(shellOptions,'mixins').value;
patch(shellMixins.start,shellMixins.end,'[is]','Remove the retired browser companion bridge');
const shellComponents=prop(shellOptions,'components').value;
patch(shellComponents.start,shellComponents.end,'{'+shellComponents.properties
  .filter(node=>!['CompanionAnnouncement','DonateContactButton'].includes(key(node))).map(text).join(',')+'}',
  'Drop retired website components from the desktop shell');
replaceInit('Yt','{render(){return null;}}','Drop the retired membership dialog');
replaceInit('Zi','""','Remove the retired membership endpoint');
replaceInit('Hi','""','Remove the retired membership page');
replaceInit('Hs','{render(){return null;}}','Drop the retired inventory file importer');
replaceFunction('Xk','return ()=>{};','Remove inert cloud upload queue watcher while preserving local update handlers');
replaceInit('Pu','async()=>{}','Remove online session migration');
replaceInit('Ru','async()=>null','Remove online game token exchange');
replaceInit('Zk','{}','Remove online game tooltip lookup directive');
replaceInit('Lk','{}','Remove other-game tooltip service catalog');
replaceFunction('gi','return async()=>{};','No web updater in offline native app');
replaceFunction('Ht','return ke||(ke={status:se("offline"),authenticated:se(false),checkedAt:se(null),busy:se(false),failed:se(false),result:se(null),adsEnabled:se(false),isSupporter:se(false),refresh:async()=>{},connect:()=>{},disconnect:async()=>true,msSinceCheck:()=>0});','Offline supporter/ad state');
replaceMethod('driveInit','this.driveIsLoading=false;this.driveIsSignedIn=false;this.driveIsSyncing=false;this.driveIsWaiting=false;');
for(const name of ['initRamp','insertKumoAds','insertAdsense'])replaceMethod(name,'return;');
replaceMethod('prydwenUrl','return null;');
replaceMethod('prydwenTierUrl','return null;');
replaceMethod('upload','return window.__holodoriDesktop.uploadProfile(arguments[0],this);','Only own-app profile imports');
replaceMethod('deleteAccount','return window.__holodoriDesktop.deleteProfile(this);','Native-backed captured profile deletion');
replaceObjectMethod('y3','methods','download','return window.__holodoriDesktop.exportProfile(this);');
replaceFunction('Pn','return null;','Remove the retired game selector');
replaceObjectMethod('An',null,'data','return {list:{hololive:{name:"hololive Dreams",released:true}}};');
replaceInit('W5',JSON.stringify([['2026-11-09','en','features','Actual captured interface with Holodori cards, progression, materials and offline profiles.']]),'Own application history');
replaceFunction('kn',`return t==="achievements"||t==="leaderboards"?${text(prop(bindings.get('bn'),'achievements').value)}:t==="progress"?${text(prop(bindings.get('wn'),'tier').value)}:t==="team-optimizer"?'<path d="M9 18V5l12-2v13M9 18a3 2 0 1 1-6 0 3 2 0 0 1 6 0Zm12-2a3 2 0 1 1-6 0 3 2 0 0 1 6 0Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>':holoSidebar(t);`,'Use the captured sidebar artwork and a music note for Team Optimizer');
replaceInit('ss','{hololive:"#a98bf5"}','Game theme tint');
for(const property of bindings.get('ht').properties.filter(node=>String(key(node)).startsWith('VITE_')))patch(property.value.start,property.value.end,'""','Remove online service configuration');

simple(ast,{ConditionalExpression(node){
  if(/^r\.prydwen(?:Tier)?Url\s*\?/.test(text(node)))patch(node.start,node.end,'C("",true)','Remove retired card guide links');
},NewExpression(node){
  if(node.callee.name==='Notification'&&node.arguments[0]?.value==='SEELIE.me')
    patch(node.arguments[0].start,node.arguments[0].end,'"Hololive Dreams Planner"','Use the app name on reminders');
},CallExpression(node){
  if(node.callee.type==='MemberExpression'&&node.callee.property.name==='catch'&&node.callee.object.type==='CallExpression'&&node.callee.object.callee.name==='Pu')patch(node.start,node.end,'void 0','Remove online session startup side effect');
  if(['G','Z1'].includes(node.callee.name))patch(node.start,node.start,'/* @__PURE__ */','Allow unused game components to be removed');
  if(node.arguments[0]?.type==='ArrowFunctionExpression'&&node.arguments[1]?.type==='ArrayExpression'&&text(node.arguments[0]).includes('import('))patch(node.arguments[1].start,node.arguments[1].end,'[]','Bundler owns actual lazy chunk dependencies');
  if(node.callee.name==='i'&&node.arguments[1]?.name==='No')patch(node.arguments[2].start,node.arguments[2].end,JSON.stringify(`v${metadata.version} · build ${metadata.build}`),'Own build number');
  if(node.callee.name==='i'&&node.arguments[1]?.name==='Wo')patch(node.arguments[2].start,node.arguments[2].end,JSON.stringify(footer.text),'Hololive disclaimer');
  if(node.callee.name==='i'&&node.arguments[0]?.value==='div'&&(node.arguments[1]?.name==='Qo'||text(node).startsWith('i("div", null, _(e.$t("layout.footer_3"))')))patch(node.start,node.end,'C("",true)','Requested footer credits removed');
  if(['i','l'].includes(node.callee.name)&&node.arguments[1]?.name==='Mm')patch(node.start,node.end,'C("",true)','Remove online promotion settings');
  if(['g','i','l'].includes(node.callee.name)&&node.arguments[1]?.type==='ObjectExpression'){
    const object=node.arguments[1],to=prop(object,'to'),href=prop(object,'href');
    if(to&&['/weapons','/policy'].includes(to.value.value))patch(node.start,node.end,'C("",true)','Omit inapplicable game navigation');
    const hrefPrefix=href?.value.value??href?.value.quasis?.[0]?.value.raw??'';
    if(/^(https?:|mailto:)/.test(hrefPrefix))patch(node.start,node.end,'C("",true)','Remove outbound promotions/navigation');
  }
},TemplateLiteral(node){
  const plannerEnergy=node.start>functions.get('Mb').start&&node.end<functions.get('Mb').end&&text(node).includes('items/special/resin.png');
  const importedItem=['xl','Ll'].some(name=>node.start>functions.get(name).start&&node.end<functions.get(name).end)&&text(node).includes('/items/');
  if(!plannerEnergy&&node.quasis.some(part=>/(?:\/(?:characters|items|inventory-filters)\/|img\/)/.test(part.value.raw)))
    patch(node.start,node.end,(importedItem?'s.gameItem?.image??':'')+`holoAsset(${text(node)})`,'Resolve actual game asset in original slot');
},Literal(node){
  if(node.value==='hsr')patch(node.start,node.end,'"hololive"','Game namespace');
}});
simple(functions.get('Jo').body,{ConditionalExpression(node){if(text(node.test)==='e.settings.sidebar_divider_style !== "none"'&&text(node.consequent).includes('key: 0'))patch(node.start,node.end,'C("",true)','One original divider between active sections and Settings');}});
simple(functions.get('Jo').body,{CallExpression(node){
  if(node.callee.name==='g'&&node.arguments[0]?.name==='x'&&node.arguments.length===1){
    patch(node.end,node.end,',g(window.__holodoriDesktop.appUpdateDialog)','Mount the app update prompt in the captured shell');
  }
  if(node.callee.name==='i'&&['So','Fo'].includes(node.arguments[1]?.name)){
    patch(node.start,node.end,'C("",false)','Remove sidebar title and language controls');
    return;
  }
  if(node.callee.name==='i'&&node.arguments[0]?.value==='img'&&text(node).includes('img/logo.svg')){
    patch(node.arguments[1].start+1,node.arguments[1].start+1,'alt:"hololive Dreams",','Give the sidebar logo an accessible name');
  }
  if(node.callee.name==='g'&&node.arguments[0]?.name==='v'&&node.arguments.length===1){
    patch(node.start,node.end,'C("",true)','Remove the retired support dialog from the sidebar');
    return;
  }
  if(node.callee.name!=='g'||prop(node.arguments[1],'to')?.value.value!=='/achievements')return;
  const progress=text(node).replace('"/achievements"','"/progress"').replace('name: "achievements"','name: "progress"')
    .replace('e.$t("achievements")','"Progress"').replace('game: "hsr"','game: "hololive"');
  patch(node.end,node.end,','+progress,'Reuse the captured sidebar entry pattern for Progress below Achievements');
  const optimizer=progress.replace('to: "/progress"','to: "/team-optimizer", onPointerenter:prepareTeamOptimizer, onFocus:prepareTeamOptimizer')
    .replace('name: "progress"','name: "team-optimizer"').replace('"Progress"','"Team Optimizer"');
  patch(node.end,node.end,','+optimizer,'Reuse the captured sidebar entry pattern for Team Optimizer');
  const leaderboards=progress.replace('"/progress"','"/leaderboards"').replace('name: "progress"','name: "leaderboards"')
    .replace('"Progress"','"Leaderboards"');
  patch(node.end,node.end,','+leaderboards,'Add the Leaderboards sidebar entry');
}});
simple(functions.get('b5').body,{Literal(node){if(node.value==='E')patch(node.start,node.end,'"B"','Holodori Bloom stage prefix');}});
simple(functions.get('K4').body,{TemplateLiteral(node){if(text(node)==='`E${r}`')patch(node.start,node.end,'`B${r}`','Holodori Bloom in shared artwork');}});
// Restore the actual Planner activity grid, toolbar, popovers and contributor
// portraits. Its game buckets now describe material categories, not energy.
simple(functions.get('Mb').body,{
  ArrayExpression(node){if(text(node)==='[0, 10, 30]')patch(node.start,node.end,'["level","training","bloom","other"]','Verified material categories in original Planner filters and sections');},
  ConditionalExpression(node){if(text(node)==='x == 0 ? e.$t("none") : x')patch(node.start,node.end,'e.$t(x)','Holodori category caption in original section header');},
  CallExpression(node){
    if(node.callee.name==='i'&&node.arguments[1]?.name==='bb'&&node.arguments[2]?.type==='ArrayExpression')
      patch(node.arguments[2].start+1,node.arguments[2].start+1,'g(holoJarSummary,{actions:a.filter==="all"||a.filter==="training"?r.jarActions:null},null,8,["actions"]),','Show jar recommendations in the original Planner materials section');
    if(node.callee.name==='i'&&node.arguments[0]?.value==='div'&&node.arguments[1]?.value===null&&node.arguments[2]?.type==='ArrayExpression'&&
      node.arguments[2].elements.some(element=>element?.type==='SequenceExpression'&&text(element).includes('a.activities[x],')))
      patch(node.arguments[2].start+1,node.arguments[2].start+1,'g(holoBloomPlanSummary,{plans:x==="bloom"?r.bloomPlans:null},null,8,["plans"]),','Show card-specific Bloom requirements in the captured Bloom category');
    if(node.callee.name==='_'&&node.arguments[0]?.name==='x')patch(node.arguments[0].start,node.arguments[0].end,'e.$t(x)','Material-category tab caption');
    if(['g','V'].includes(node.callee.name)&&node.arguments[0]?.name==='z'){const cost=prop(node.arguments[1],'cost');patch(cost.value.start,cost.value.end,'0','Original material panel without unsupported farming estimates');}
    if(['i','l'].includes(node.callee.name)&&node.arguments[0]?.value==='img'&&text(node).includes('items/special/resin.png')){const src=prop(node.arguments[1],'src');patch(src.value.start,src.value.end,'holoAsset(`${e.url}img/inventory-filters/${x}.png`)','Material category icon in original Planner slot');}
    if(node.callee.type==='MemberExpression'&&node.callee.property.name==='$t'&&node.arguments[0]?.value==='no_activities')patch(node.arguments[0].start,node.arguments[0].end,'(a.filter!=="all"?"planner_category_ready":r.hasPlannedRequirements?"planner_materials_ready":"planner_no_requirements")','Accurate original empty state for covered or unconfigured goals');
    if(node.callee.name==='g'&&node.arguments[0]?.name==='v')patch(node.start,node.end,'C("",true)','Remove online import from restored Planner toolbar');
    if(['i','l'].includes(node.callee.name)&&node.arguments[0]?.value==='button'&&text(node.arguments[1]||{}).includes('a.filter = "relics"'))patch(node.start,node.end,'C("",true)','Remove unsupported Artwork farming filter');
  },
  AssignmentExpression(node){if(text(node.left)==='t[5]'&&text(node.right).includes('bg-gray-600 opacity-25'))patch(node.start,node.end,'t[5]=C("",false)','Remove cached ad separator while preserving original block tracking');},
});
simple(functions.get('Ug').body,{CallExpression(node){if(node.callee.name==='i'&&node.arguments[1]?.name==='jg')patch(node.start,node.end,'C("",true)','Keep original Planner settings without HSR account/server fields');}});
simple(ast,{CallExpression(node){if(node.callee.type==='MemberExpression'&&node.callee.object.type==='ThisExpression'&&node.callee.property.name==='driveInit')patch(node.start,node.end,'void 0','Remove cloud startup call while preserving remaining original mounted handlers');}});
simple(functions.get('tb').body,{UnaryExpression(node){if(text(node)==='!r.count')patch(node.start,node.end,'(!r.count&&!!a.filter)','Keep the original empty task graphic in explicit task tabs, leaving the default Planner compact');}});
replaceObjectMethod('L6','computed','mode','return ["hologold","lessonPoints"].includes(this.item.type)?"horizontal":"vertical";');
simple(functions.get('vg').body,{CallExpression(node){if(node.callee.name==='l'&&node.arguments[0]?.value==='div'&&node.arguments[1]?.type==='ObjectExpression'){
  const classes=prop(node.arguments[1],'class');if(classes&&text(classes.value).includes('bg-gray-700/70 shadow rounded'))patch(node.arguments[1].start+1,node.arguments[1].start+1,'"data-material":s.location,','Identify original material panels for runtime verification');
}},ConditionalExpression(node){if(node.test.type==='ConditionalExpression'&&text(node.test).includes('typeof h.missing'))
  patch(node.test.start,node.test.end,`(h.jarPlanned||(${text(node.test)}))`,'Keep captured material cards and contributors visible when jars cover the goal');}});

// Actual Inventory controls and renderers, with Holodori material categories.
const inventoryNode=bindings.get('Jb'),inventoryComponents=prop(inventoryNode,'components').value;
const inventorySource=text(inventoryNode),componentText='{'+inventoryComponents.properties.filter(node=>key(node)!=='InventoryImport').map(text).join(',')+'}';
const inventoryOptions=inventorySource.slice(0,inventoryComponents.start-inventoryNode.start)+componentText+inventorySource.slice(inventoryComponents.end-inventoryNode.start);
patch(inventoryNode.start,inventoryNode.end,`configureInventory(${inventoryOptions})`,'Original Inventory options with verified categories and profile-aware filtering');
simple(ast,{Property(node){if(node.method&&key(node)==='setInventory')patch(node.value.body.start+1,node.value.body.start+1,'if((!holoGame.resourceKeys.includes(t)&&!isGameInventoryId(t))||e!==t||s!==0)return;n=inventoryQuantity(n);','Normalize quantities before original inventory setters and native commits');}});
replaceObjectMethod('zb','methods','clean','this.inventory=clearGameInventory(this.inventory,this.$root.data?.[this.account+"-holodori"]?.gameAccountImport?.snapshot);this.isVisible=false;');
simple(functions.get('tx').body,{Property(node){
  if(key(node)==='hour_format')patch(node.start,node.start,'number_format:validNumberFormat(e.number_format),date_format:validDateFormat(e.date_format),optimizer_use_gpu:e.optimizer_use_gpu===true,','Restore saved formats and optimizer compute preference before first render');
  if(key(node)==='inventory_show')patch(node.start,node.start,'inventory_hide_zero:e.inventory_hide_zero===true,','Restore the Inventory zero filter from saved settings');
}});
simple(ast,{Property(node){if(node.method&&key(node)==='setCustomItem')patch(node.value.body.start+1,node.value.body.start+1,'if(!holoGame.resourceKeys.includes(t)||e!==t||s!==0)return;n=inventoryQuantity(n);','Keep original extra-material inputs finite nonnegative whole quantities');}});
replaceMethod('getCustomItem','const item=this.custom_items.find(value=>value.type===e&&value.item===t&&value.tier===s);return inventoryQuantity(item?.value)||null;','Read legacy extra-material quantities consistently without rewriting saved files');
simple(functions.get('pC').body,{
  ConditionalExpression(node){
    const test=text(node.test);
    if(test==='a.filter == "all" || a.filter == "common"')
      patch(node.start,node.end,'C("",true)','Use the normal grid in place of the separate stock row and divider');
    if(test.startsWith('a.filteredItems[S - 1]')){
      patch(node.test.start,node.test.end,'!!r.itemHeadings[j]','Show headings only for visible subcategories in individual tabs');
      patch(node.consequent.start,node.consequent.end,'(o(),l("h2",{key:0,class:"w-full mt-1 mb-2 text-xs font-semibold text-gray-300"},_(r.itemHeadings[j]),1))','Label item subcategories in the original inventory grid');
    }
  },
  MemberExpression(node){if(text(node)==='a.filteredItems')patch(node.start,node.end,'r.displayItems','Include imported items in the existing Inventory grid');},
  Literal(node){
    if(typeof node.value==='string'&&node.value.startsWith('py-2 px-1 sm:px-3 md:px-2 lg:px-1 xl:px-2'))
      patch(node.start,node.end,JSON.stringify(node.value.replace('sm:px-3 md:px-2','sm:px-2')),'Keep Inventory tabs on one row at the minimum window width');
    if(node.value==='flex-shrink-0')
      patch(node.start,node.end,'"flex shrink-0"','Stretch each tab button to the shared search row height');
  },
  CallExpression(node){
    if(node.callee.name==='l'&&node.arguments[1]?.name==='Kb'){
      const children=node.arguments[2].elements;
      patch(children.at(-1).end,children.at(-1).end,',a.loaded&&r.searchQuery&&!r.displayItems.length?(o(),l("p",{key:4,class:"mt-4 text-sm text-gray-300",role:"status"},"No matching items.")):C("",true)','Show an empty search result in the active Inventory tab');
    }
    if(node.callee.name==='i'&&node.arguments[1]?.name==='tC'){
      const children=node.arguments[2];
      patch(children.end-1,children.end-1,'g(O8,{modelValue:a.search,"onUpdate:modelValue":value=>a.search=value,class:"ml-2 mr-1 my-1 text-base font-normal"},null,8,["modelValue"]),','Give the shared Characters search clearance from the tabs and toolbar divider');
    }
    if(node.callee.name==='i'&&node.arguments[1]?.name==='iC'){
      const children=node.arguments[2];
      patch(children.start+1,children.start+1,'g(p,{modelValue:r.hideZero,"onUpdate:modelValue":value=>r.hideZero=value,label:e.$t("inventory_hide_zero"),small:""},null,8,["modelValue","label"]),','Use the captured switch in the Inventory toolbar');
    }
    if(text(node)==='e.$t(j)')patch(node.start,node.end,'e.$t(j==="all"?j:"inventory_"+j)','Use game category names on the original tabs');
    if(node.callee.name==='l'&&node.arguments[0]?.value==='button'&&node.arguments[1]?.type==='ObjectExpression'){
      const props=node.arguments[1],click=prop(props,'onClick');
      const mode=click&&/r\.show = r\.show == "(needed|craftable)"/.exec(text(click.value))?.[1];
      if(mode)patch(props.start+1,props.start+1,'"aria-label":e.$t('+JSON.stringify(mode)+'),','Name the original Inventory requirement controls');
    }
    if(node.callee.name==='i'&&node.arguments[0]?.value==='button'&&prop(node.arguments[1],'onClick')&&text(prop(node.arguments[1],'onClick').value).includes('a.filter = j')){
      const props=node.arguments[1];
      patch(props.start+1,props.start+1,'"aria-label":e.$t(j==="all"?j:"inventory_"+j),title:e.$t(j==="all"?j:"inventory_"+j),','Name the original tabs at compact widths');
    }
    if(node.callee.name==='g'&&node.arguments[0]?.name==='m'){
      patch(node.arguments[0].start,node.arguments[0].end,'window.__holodoriInventoryConversions','Replace foreign-format importer with local conversion in original menu slot');
      patch(node.arguments[1].start+1,node.arguments[1].start+1,'onConverted:r.getItems,','Refresh filtered results after explicit conversion');
    }
    if(node.callee.name==='V'&&node.arguments[1]?.type==='ObjectExpression'){
      const props=node.arguments[1],item=prop(props,'item');
      if(item?.value.name==='j'){
        patch(props.start+1,props.start+1,'gameItem:r.gameItems[j],"data-inventory-item":j,onQuantityFocus:r.focusQuantityItem,onQuantityBlur:r.blurQuantityItem,','Pass imported quantities and track focus in the original tile');
        const release=prop(props,'release').value;
        patch(release.start,release.end,'e.items[j]?.release','Imported tiles have no planner release restriction');
        for(const [name,value]of [['type','r.gameItems[j]?j:e.getType(j)'],['buttons','r.buttons&&!r.gameItems[j]?.unlimited&&!(r.gameItems[j]?.quantity>Number.MAX_SAFE_INTEGER)'],['options','r.gameItems[j]?r.regularGridOptions:a.options'],['craft-button','!r.gameItems[j]&&r.craftButton']]){
          const target=prop(props,name).value;
          if(text(target)!==value)patch(target.start,target.end,value,'Use the original inventory controls for game quantities');
        }
        patch(node.arguments[4].start+1,node.arguments[4].start+1,'"gameItem",','Refresh imported tile props when the active profile changes');
      }
    }
  },
});
replaceObjectMethod('Pl','computed','mode','return ["hologold","lessonPoints"].includes(this.item.type)?"horizontal":"vertical";');
simple(functions.get('Ql').body,{ConditionalExpression(node){if(text(node.test)==='r.need')patch(node.test.start,node.test.end,'r.need&&!s.conversionPreview','Conversion quotes show one quantity in the actual ItemCost renderer');}});
simple(functions.get('N6').body,{Literal(node){if(node.value==='credit')patch(node.start,node.end,'"hologold"','Use the original wide formatted currency popover for Hologold');}});
simple(functions.get('pC').body,{ArrayExpression(node){if(text(node)==='["all", "char_asc", "trace_cone", "trace_char", "trace_epic"]')patch(node.start,node.end,'inventoryCategories','Holodori Inventory categories');}});
replaceInit('tC','{class:"flex flex-wrap min-w-0 -mb-[2px]"}','Wrap the original Inventory tabs within the toolbar');
replaceInit('eC','{class:"flex flex-wrap items-center gap-x-1 gap-y-1 border-b-2 border-gray-500/20 text-xs lg:text-sm mt-2 font-semibold justify-between"}','Separate the secondary tools when they wrap below the search row');
replaceInit('aC','{class:"hidden sm:block ml-1"}','Keep the four Inventory tab labels readable at the minimum desktop width');
replaceInit('iC','{class:"flex items-center shrink-0 gap-0.5 xl:gap-2 ml-auto"}','Keep the original Inventory tools together when search expands');
simple(functions.get('xl').body,{
  Property(node){
    if(key(node)==='opacity-50'&&text(node.value)==='!r.need')patch(node.value.start,node.value.end,'!s.gameItem&&!r.need','Keep read-only stock visible at full contrast');
  },
  ConditionalExpression(node){
    if(text(node.test)==='e.maxTier[s.type] > 0'&&text(node.consequent).startsWith('e.$t('))
      patch(node.start,node.end,'s.gameItem?s.gameItem.tooltip:('+text(node)+')','Show the imported item name in the original icon tooltip');
    if(text(node.test)==='(y = s.options) != null && y.hideNeed')
      patch(node.test.start,node.test.end,'s.options?.hideNeed||(s.options?.hideEmptyNeed&&!r.need)','Show the original requirement strip only for items with a planned amount');
  },
  CallExpression(node){
    if(node.callee.name!=='i'||node.arguments[0]?.value!=='img')return;
    const props=node.arguments[1],src=prop(props,'src');
    if(src&&text(src.value).includes('/items/'))
      patch(props.start+1,props.start+1,'alt:s.gameItem?.name,loading:s.gameItem?"lazy":void 0,','Keep imported artwork accessible and defer offscreen images');
  },
});
replaceInit('cl','["src","alt","loading"]','Refresh imported artwork attributes in the original tile');
for(const name of ['xl','Ll','Ql'])if(functions.has(name))simple(functions.get(name).body,{Literal(node){if(node.value==='credit')patch(node.start,node.end,'"hologold"','Use original currency input for Hologold');if(['char_xp','cone_xp'].includes(node.value))patch(node.start,node.end,'"lessonPoints"','Use existing XP input for Lesson Points');}});
simple(ast,{ArrayExpression(node){if(text(node)==='[5, 4]')patch(node.start,node.end,'[5,4,3]','All Holodori card rarities');}});
replaceObjectMethod('qd','computed','subjectEstimation','return this.subjectCosts.filter(cost=>Number(cost.need)>0).length;');
replaceObjectMethod('qd','computed','estimation','return this.totalCosts.filter(cost=>Number(cost.need)>0).length;');
simple(functions.get('Kd').body,{CallExpression(node){if(node.callee.name==='i'&&['Bd','Wd'].includes(node.arguments[1]?.name))patch(node.arguments[2].start,node.arguments[2].end,'e.$t("materials")','No invented farming time; original summary label shows materials');if(node.callee.name==='i'&&['Ud','Qd'].includes(node.arguments[1]?.name))patch(node.start,node.end,'C("",true)','No unsupported premium energy estimate');if(node.callee.name==='i'&&node.arguments[0]?.value==='img'&&text(node).includes('src: f1'))patch(node.start,node.end,'C("",true)','Remove premium energy material image');}});

// Keep the captured Settings controls and move them into desktop disclosures.
const settingsSections=new Map();
simple(functions.get('Tm').body,{CallExpression(node){
  if(node.callee.name==='i'&&['b3','P3','X3','cm','Cm'].includes(node.arguments[1]?.name))
    settingsSections.set(node.arguments[1].name,node);
}});
const profileChildren=settingsSections.get('b3').arguments[2].elements;
patch(profileChildren[0].start,profileChildren[0].end,'i("h2",{class:"font-semibold text-sm"},_(e.$t("account")))','Label the profile toolbar');
patch(profileChildren[1].start,profileChildren[1].end,'C("",false)','Keep the toolbar concise and explain full backups with backup actions');
replaceInit('b3','{id:"settings-profile",class:"bg-gray-700 p-3 rounded-md mt-3"}','Keep the active profile and its actions in one toolbar');
replaceInit('w3','{class:"desktop-profile-actions"}','Wrap profile actions as one toolbar');
replaceInit('k3','{class:"desktop-profile-action-group"}','Align profile management controls with profile file actions');
replaceInit('V3','{class:"desktop-profile-action-group"}','Align profile file actions with profile management controls');
const profileActions=profileChildren[2].arguments[2].elements[0].arguments[2].elements;
const [addProfile, ,renameProfile]=profileActions;
const addAction='i("button",{"aria-label":"Add profile",title:"Add profile",disabled:r.profileLocked,class:"bg-gray-600 shadow rounded-md px-2 lg:pr-3 py-2 flex items-center justify-center",onClick:t[0]||(t[0]=(...f)=>r.addAccount&&r.addAccount(...f))},[g(c,{class:"w-5 h-6"}),i("span",x3,_(e.$t("add")),1)],8,["disabled"])';
patch(addProfile.start,addProfile.end,'C("",false)','Place the active profile first in visual and keyboard order');
patch(renameProfile.end,renameProfile.end,','+addAction,'Place Add beside Rename in the profile toolbar');
const [materialEntry,goals]=settingsSections.get('X3').arguments[2].elements.slice(1);
const [,hideArtwork,hideBloom,appearance]=settingsSections.get('cm').arguments[2].elements;
const [hour,...sidebar]=appearance.arguments[2].elements;
const clock=text(hour).replace('i("p", _m, _(e.$t("hour_format")), 1)','i("span",{class:"font-semibold"},_(e.$t("hour_format")),1)')
  .replace('i("div", null, [','i("label",{class:"desktop-format-row"},[')
  .replace('class: "bg-gray-600 rounded-md",','class:"bg-gray-600 rounded-md","aria-label":e.$t("hour_format"),');
const sidebarControls=sidebar.map(node=>{
  const replacements=[];
  simple(node,{CallExpression(button){
    if(button.callee.name!=='i'||button.arguments[0]?.value!=='button')return;
    const [,props,,flags]=button.arguments;
    const selected=text(props).match(/r\.sidebar(?:Density|DividerStyle) == "[^"]+"/)?.[0];
    if(!selected||flags?.value!==3)throw Error('Captured sidebar toggle changed');
    replacements.push([props.start+1,props.start+1,`type:"button","aria-pressed":${selected},`],
      [flags.start,flags.end,'11,["aria-pressed"]']);
  }});
  let output=text(node);
  for(const [start,end,value] of replacements.reverse())output=output.slice(0,start-node.start)+value+output.slice(end-node.start);
  return output;
});
const panels=settingsSections.get('P3');
patch(panels.start,settingsSections.get('Cm').end,
  `g(window.__holodoriDesktop.settingsComponent,null,{
    formats:R(()=>[${clock}]),
    sidebar:R(()=>[${sidebarControls.join(',')}]),
    materialEntry:R(()=>[${text(materialEntry)}]),
    goals:R(()=>[${text(goals)}]),
    cardDetails:R(()=>[${[hideArtwork,hideBloom].map(node=>text(node).replace('class: "mt-2",','')).join(',')}])
  })`,'Place original settings controls in their workflow groups');
replaceInit('tm','{class:"desktop-settings-controls"}','Align material entry controls');
replaceInit('lm','{class:"desktop-settings-controls"}','Align goals summary controls');
replaceInit('rm','{key:0,class:"desktop-settings-tab-order"}','Allow the conditional tab-order field to wrap');
replaceInit('z3','{class:"text-sm break-words"}','Remove reserved header spacing from the profile confirmation');
replaceInit('O3','{class:"desktop-settings-dialog-actions mt-3"}','Align the profile confirmation actions');
const mount=source.indexOf('e.mount("#app")');patch(mount,mount+'e.mount("#app")'.length,'(window.__seelieApp=e.mount("#app"),window.__holodoriApp=window.__seelieApp,window.__holodoriDesktop.onMounted())','Expose actual mounted Vue root and native boundary');
const boot=functions.get('sx');patch(boot.body.start+1,boot.body.start+1,'await window.__holodoriDesktop.ready;window.__holodoriDesktop.install({h:i,reactive:ea,vnode:g,resolve:M,Dialog:le,Switch:Ae});','Wait for native data before original Vue bootstrap');
patch(boot.body.start+1,boot.body.start+1,'window.__holodoriInventoryConversions=createInventoryConversions({h:i,vnode:g,Dialog:le,Cost:cs});','Use captured Dialog and ItemCost renderers for manual conversion');
simple(boot.body,{AssignmentExpression(node){if(text(node.left)==='e.config.globalProperties.$url')patch(node.right.start,node.right.end,'holoPublic','Resolve neutral common assets locally');}});
const defaults=functions.get('tx');simple(defaults.body,{VariableDeclarator(node){if(node.id.name==='t'&&node.init?.type==='ObjectExpression')patch(node.init.start+1,node.init.start+1,'boosts:{minigame:null,live:null,holoPassport:false},','Persist both boost trackers');},Property(node){if(key(node)==='resin_adjust_quantities')patch(node.start,node.start,'holodori_boosts:e.holodori_boosts||{},','Persist original boost preferences');}});
const debounceEnd=source.indexOf('    a\n  );',source.indexOf('function jk('));if(debounceEnd>=0)patch(debounceEnd,debounceEnd,'window.__holodoriDesktop.trackDebounce(a),\n','Flush original debounced edits on close');
patch(source.lastIndexOf('sx();'),source.lastIndexOf('sx();')+5,'window.__holodoriGame=holoGame;window.__seelieCatalog={characters:holoGame.characters,items:holoGame.items};window.__holodoriCapture={Level:fs,Training:holoTrainingEditor,Bloom:holoBloomEditor};\nexport { sx as startCapturedApp };','Expose captured component identities and await the original startup');

// Cached source VNodes are constructed only once. A tracked replacement comment
// there would enter the first render's dynamicChildren but not later renders.
// Keep those removals static, including the captured language-menu help link.
const cachedInitializers=[];
simple(ast,{LogicalExpression(node){if(node.operator==='||'&&node.left.type==='MemberExpression'&&node.right.type==='AssignmentExpression'&&text(node.left)===text(node.right.left))cachedInitializers.push(node.right.right);}});
for(const change of changes)if(change.value==='C("",true)'&&cachedInitializers.some(node=>node.start<=change.start&&node.end>=change.end))change.value='C("",false)';
changes.sort((a,b)=>a.start-b.start||b.end-a.end);
const effective=[];
for(const change of changes){const previous=effective.at(-1);if(previous&&change.start<previous.end){if(change.end<=previous.end)continue;throw Error('Overlapping capture edits: '+previous.reason+' / '+change.reason);}effective.push(change);}
for(const [reason,count]of [
  ['Original material panel without unsupported farming estimates',1],
  ['Verified material categories in original Planner filters and sections',2],
  ['Remove cached ad separator while preserving original block tracking',1],
  ['Keep original Planner settings without HSR account/server fields',1],
  ['Original Inventory options with verified categories and profile-aware filtering',1],
  ['Normalize quantities before original inventory setters and native commits',1],
  ['Replace foreign-format importer with local conversion in original menu slot',1],
  ['Conversion quotes show one quantity in the actual ItemCost renderer',1],
  ['Use the normal grid in place of the separate stock row and divider',2],
  ['Show the original requirement strip only for items with a planned amount',1],
])if(effective.filter(change=>change.reason===reason).length!==count)throw Error('Missing captured Planner adaptation: '+reason);
let adapted=source;
for(const change of effective.toReversed())adapted=adapted.slice(0,change.start)+change.value+adapted.slice(change.end);
parse(adapted,{ecmaVersion:'latest',sourceType:'module'});

// Only generated build trees are replaced; saves and source captures are separate.
for(const directory of [stage,out]){if(path.resolve(directory)!==path.join(root,path.basename(directory)))throw Error('Unexpected build directory');await fs.rm(directory,{recursive:true,force:true});await fs.mkdir(directory,{recursive:true});}
await fs.cp(path.join(archive,'upstream/assets'),path.join(stage,'assets'),{recursive:true,filter:file=>!path.extname(file)||/\.(?:js|css)$/.test(file)});
const capturedVendor=path.join(stage,'assets/vendor-8ba3b986.js');
const vendorSource=await fs.readFile(capturedVendor,'utf8');
const keepAlive=vendorSource.match(/\b([\w$]+)=\{name:"KeepAlive",__isKeepAlive:!0,/);
if(!keepAlive)throw Error('Missing captured Vue KeepAlive');
await fs.appendFile(capturedVendor,'\nexport {'+keepAlive[1]+' as holoKeepAlive};\n');
await fs.writeFile(path.join(stage,'assets/index-f19fde22.js'),adapted);

// Strip game dictionaries from all original locale modules. Shared interface
// dictionaries stay in the actual original locale format and loading workflow.
const gameBundle=await build({entryPoints:[path.join(root,'source/captured-holodori/game.ts')],bundle:true,format:'esm',platform:'node',write:false});
const dataModule=await import('data:text/javascript;base64,'+Buffer.from(gameBundle.outputFiles[0].contents).toString('base64'));
const labels={...dataModule.game.translations,title:'Hololive Dreams Planner',characters:'Characters',character:'Card',inventory:'Inventory',settings:'Settings',path:'Stat',paths:'Stats',type:'Type',types:'Types',tier:'Rarity',traces:'SP Training',trace:'SP Training',cone:'Bloom',cones:'Bloom',relics:'Artwork',eidolons:'Bloom',current_sp:'Current SP',goal_sp:'Goal SP',owned:'Owned',unowned:'Unowned',ownership_unavailable:'Import account data to filter by ownership.',hide_maxed_cards:'Hide maxed cards',current_bloom:'Current Bloom',training:'SP Training',bloom:'Bloom',other:'Other',materials:'materials',planner_category_ready:'No missing materials in this category.',planner_materials_ready:'All planned materials are ready.',planner_no_requirements:'Add card goals or extra materials to build your plan.',none_required:'None required',share_goal_traces:'SP Training',share_format_landscape:'Landscape',share_made_with:'Made with',share_art_local:'Your image is saved in this profile on this computer.',crafted_explanation:'Record the exchanges planned for this material. Matching Beads upgrade to Crystals with Mega Sphere Coins. The VIP Lounge exchanges both other attributes for Beads or Crystals with Soda Pop Coins.',clean_confirmation:'Clear the recorded inventory quantities for this profile? Goals and other profile data are kept.',only_obtainable:'Materials required for the selected goals. No farming estimates are assumed.'};
Object.assign(labels,{goal_bloom:'Goal Bloom',resin_full:'Full',account:'Profile',more_than_one_account:'Keep separate card progress and inventories in each profile.',export_account:'Export profile',import_account:'Import profile',delete_profile_confirmation:'Delete this profile? A recovery backup will be created first.',hide_artifacts_expanded_goals:'Hide Artwork from expanded cards',hide_weapons_expanded_goals:'Hide Bloom from expanded cards',hour_format:'Time format',sidebar_density:'Sidebar density',sidebar_divider_style:'Sidebar divider'});
Object.assign(labels,{inventory_training:'Training',inventory_construction:'Construction',inventory_other:'Others',inventory_hide_zero:'Hide zero quantities'});
labels.show_added_cards='Show added cards';
labels.back_to_seelie='Back to Planner';
await adaptCapturedData(stage,source,labels);
await adaptCapturedLazyAssets(stage);
await fs.writeFile(path.join(stage,'entry.js'),'import "'+path.join(root,'source/captured-holodori/desktop.js').replaceAll('\\','/')+'";await window.__holodoriDesktop.finishStartup(()=>import("./assets/index-f19fde22.js"));');
const result=await build({entryPoints:{main:path.join(stage,'entry.js'),'team-optimizer-worker':path.join(root,'source/captured-holodori/team-optimizer-worker.js'),'outfit-decode-worker':path.join(root,'source/captured-holodori/outfit-decode-worker.js')},bundle:true,splitting:true,format:'esm',outdir:path.join(out,'app'),minify:true,target:'es2022',charset:'utf8',legalComments:'linked',metafile:true,alias:{'@shared':path.join(root,'source/hololive/vendor/shared')},plugins:[{name:'captured-game-boundaries',setup(build){
  build.onResolve({filter:/^\/captured\//},args=>({path:path.join(root,'source/captured-holodori',args.path.slice('/captured/'.length)).replace(/game\.js$/,'game.ts').replace(/assets\.js$/,'assets.ts')}));
  build.onLoad({filter:/progression\.json$/},async({path:filename})=>{
    const data=JSON.parse(await fs.readFile(filename,'utf8'));
    const fields=['memberName','groupId','groupLabel'];
    const columns=['id','cardName','rarity','attribute','stat','animation'];
    if(!data.cards?.every(card=>typeof card.assetId==='string'&&fields.every(key=>typeof card[key]==='string')))
      return {loader:'json',contents:JSON.stringify(data)};
    const members={};
    for(const card of data.cards){
      if(card.id==='card-'+card.assetId)delete card.assetId;
      const identity=members[card.id.slice(5,10)]??={};
      for(const field of fields){
        identity[field]??=card[field];
        if(identity[field]===card[field])delete card[field];
      }
    }
    const labels=Object.fromEntries(['attribute','stat'].map(key=>[key,[...new Set(data.cards.map(card=>card[key]))]]));
    const animations=[];
    data.cards=data.cards.map(card=>{
      const row=columns.map(key=>card[key]);
      if(columns.some(key=>!Object.hasOwn(card,key))||!card.id.startsWith('card-'))return card;
      row[0]=card.id.slice(5);
      for(const key of Object.keys(labels))row[columns.indexOf(key)]=labels[key].indexOf(card[key]);
      const animation=JSON.stringify(card.animation);
      if(!animations.includes(animation))animations.push(animation);
      row[columns.indexOf('animation')]=animations.indexOf(animation);
      for(const key of columns)delete card[key];
      if(Object.keys(card).length)row.push(card);
      return row;
    });
    return {loader:'js',contents:`const data=${JSON.stringify(data)},members=${JSON.stringify(members)};
      const columns=${JSON.stringify(columns)};
      const labels=${JSON.stringify(labels)};
      const animations=${JSON.stringify(animations)};
      data.cards=data.cards.map(row=>{
        const card=Array.isArray(row)?{...row[columns.length],...Object.fromEntries(columns.map((key,index)=>[key,row[index]]))}:row;
        if(Array.isArray(row)){
          card.id='card-'+card.id;
          for(const key of Object.keys(labels))card[key]=labels[key][card[key]];
          card.animation=JSON.parse(animations[card.animation]);
        }
        card.assetId??=card.id.slice(5);
        for(const field of ${JSON.stringify(fields)})card[field]??=members[card.id.slice(5,10)][field];
        return card;
      });
      export default data;`};
  });
  build.onLoad({filter:/vendor[/\\]data[/\\]account\.json$/},async({path:filename})=>{
    const data=JSON.parse(await fs.readFile(filename,'utf8'));
    const ids=[...new Set(Object.values(data.cardConnectEffectIds))];
    const index=new Map(ids.map((id,i)=>[id,i]));
    for(const card of Object.keys(data.cardConnectEffectIds))
      data.cardConnectEffectIds[card]=index.get(data.cardConnectEffectIds[card]);
    return {loader:'js',contents:`const data=${JSON.stringify(data)}, ids=${JSON.stringify(ids)};
      const effects=data.cardConnectEffectIds;
      for(const card of Object.keys(effects))effects[card]=ids[effects[card]];
      export default data;`};
  });
  build.onLoad({filter:/card-catalog-order\.json$/},async({path:filename})=>{
    const order=JSON.parse(await fs.readFile(filename,'utf8'));
    const variants=['nrml','cmmn','uniq'];
    const ids=Object.keys(order).sort((a,b)=>order[a]-order[b]);
    if(ids.some((id,index)=>order[id]!==index+1))return {loader:'json',contents:JSON.stringify(order)};
    const parts=ids.map(id=>/^card-(\d{5})-([345])-(nrml|cmmn|uniq)-(\d{4})-00$/.exec(id));
    if(parts.some(part=>!part))return {loader:'json',contents:JSON.stringify(order)};
    const compact=parts.map(([,member,tier,variant,design])=>
      (((Number(member)*9+(Number(tier)-3)*3+variants.indexOf(variant))*10000)+Number(design)).toString(36).padStart(7,'0'));
    return {loader:'js',contents:`
      const variants=${JSON.stringify(variants)};
      export default Object.fromEntries(${JSON.stringify(compact.join(''))}.match(/.{7}/g).map((key,i)=>{
        const encoded=parseInt(key,36),type=Math.floor(encoded/10000);
        const member=String(Math.floor(type/9)).padStart(5,'0');
        const design=String(encoded%10000).padStart(4,'0');
        return ['card-'+member+'-'+(3+Math.floor(type/3)%3)+'-'+variants[type%3]+'-'+design+'-00',i+1];
      }));`};
  });
}}]});
await fs.cp(path.join(root,'hololive-assets/assets'),path.join(out,'assets'),{recursive:true});
const outfitDir=path.join(out,'assets/outfits');
const outfitFiles=new Set(await fs.readdir(outfitDir));
const outfitIndex=Object.fromEntries([...outfitFiles]
  .filter(file=>file.endsWith('.mesh.gz')).sort().map(file=>[file.slice(0,-8),[]]));
for(const file of [...outfitFiles].sort()){
  const match=/^(.+)\.atlas-\d+\.webp$/.exec(file);
  if(match&&outfitIndex[match[1]])outfitIndex[match[1]].push(file);
}
outfitIndex.rooms=Object.fromEntries([...outfitFiles].filter(file=>/^room-\d{5}\.webp$/.test(file))
  .sort().map(file=>[file.slice(5,-5),'/assets/outfits/'+file]));
outfitIndex.thumbnails=Object.fromEntries([...outfitFiles].filter(file=>/^thumb-\d{5}-[a-z]+-\d{4}-\d{2}\.webp$/.test(file))
  .sort().map(file=>[file.slice(6,-5),'/assets/outfits/'+file]));
outfitIndex.reactions={};
for(const file of [...outfitFiles].sort()){
  const match=/^(.+)\.reaction-(\d+)\.gz$/.exec(file);
  if(match)(outfitIndex.reactions[match[1]]??=[]).push(Number(match[2]));
}
for(const slots of Object.values(outfitIndex.reactions))slots.sort((a,b)=>a-b);
await fs.writeFile(path.join(outfitDir,'index.json'),JSON.stringify(outfitIndex));
await fs.copyFile(path.join(root,'source/captured-holodori/outfit-waist-anchors.json'),path.join(out,'assets/outfit-waist-anchors.json'));
const outfitUpdates=path.join(out,'assets/outfit-updates');
await fs.mkdir(outfitUpdates,{recursive:true});
await fs.writeFile(path.join(outfitUpdates,'index.json'),'{}');
const optimizerAssets=path.join(out,'assets/team-optimizer');
await fs.mkdir(optimizerAssets,{recursive:true});
const chartArtwork=path.join(out,'assets/chart-artwork');
await fs.mkdir(chartArtwork,{recursive:true});
const chartArtworkSource=path.join(root,'hololive-assets/chart-artwork');
const artIndex=await fs.readFile(path.join(chartArtworkSource,'index.json'),'utf8').then(JSON.parse).catch(error=>{
  if(error.code!=='ENOENT')throw error;
  return {};
});
for(const key of Object.keys(artIndex)){
  if(!/^m\d{4}_(easy|normal|hard|expert)$/.test(key))throw Error('Invalid chart artwork key '+key);
  await fs.copyFile(path.join(chartArtworkSource,key+'.png'),path.join(chartArtwork,key+'.png'));
}
await fs.writeFile(path.join(chartArtwork,'index.json'),JSON.stringify(artIndex));
await fs.cp(path.join(root,'source/hololive/scoring-reviewed/preview-soundtracks'),
  path.join(optimizerAssets,'soundtracks'),{recursive:true});
for(const dir of ['soundtrack-updates','jacket-updates']){
  const updates=path.join(optimizerAssets,dir);
  await fs.mkdir(updates,{recursive:true});
  await fs.writeFile(path.join(updates,'index.json'),'{}');
}
await fs.cp(path.join(root,'source/hololive/scoring-reviewed/preview-hit-sounds'),
  path.join(optimizerAssets,'hit-sounds'),{recursive:true});
await fs.mkdir(path.join(optimizerAssets,'hit-sound-updates'),{recursive:true});
await fs.writeFile(path.join(optimizerAssets,'hit-sound-updates/index.json'),'{}');
for(const file of ['hdsolver.js','hdsolver.wasm','event-titles.json'])
  await fs.copyFile(path.join(root,'evidence/team-optimizer/reference',file),path.join(optimizerAssets,file));
for(const file of ['solver-data.json','optimizer-events.json','song-lengths.json','song-unlocks.json'])
  await fs.copyFile(path.join(root,'source/hololive/scoring-reviewed/compact',file),path.join(optimizerAssets,file));
for (const file of ['game-scoring-release.json','optimizer-charts.json', 'optimizer-chart-events-v3.bin',
  'optimizer-preview-lanes.json','optimizer-preview-lanes.bin','optimizer-preview-hits.json','optimizer-preview-geometry.json']) {
  await fs.copyFile(path.join(root, 'source/hololive/scoring-reviewed', file), path.join(optimizerAssets, file));
}
for (const file of ['scoring.json', 'chart-denominators.json']) {
  await fs.copyFile(path.join(root, 'source/hololive/vendor/data', file), path.join(optimizerAssets, file));
}
for(const dir of ['jackets','portraits','event-banners'])
  await fs.cp(path.join(root,'evidence/team-optimizer/reference/ui-assets',dir),path.join(optimizerAssets,dir),{recursive:true});
for(const dir of ['jackets','portraits'])
  await fs.cp(path.join(root,'source/hololive/scoring-reviewed/compact',dir),path.join(optimizerAssets,dir),{recursive:true});
const eventBanners=await fs.readdir(path.join(optimizerAssets,'event-banners'));
const eventArt=Object.fromEntries(eventBanners
  .filter(file=>/^marathon_event-(?:normal|relay)-\d+\.webp$/.test(file))
  .map(file=>[path.basename(file,'.webp'),`/assets/team-optimizer/event-banners/${file}`]));
await fs.writeFile(path.join(optimizerAssets,'event-art.json'),JSON.stringify(eventArt));
const optimizerJson=async file=>JSON.parse(await fs.readFile(path.join(optimizerAssets,file+'.json'),'utf8'));
const [solverData,eventData,unlocks,eventTitles]=await Promise.all(
  ['solver-data','optimizer-events','song-unlocks','event-titles'].map(optimizerJson));
await fs.writeFile(path.join(optimizerAssets,'workspace.json'),JSON.stringify(buildOptimizerWorkspace({
  data:solverData,events:normalizeOptimizerEvents(eventData.events),unlocks,eventArt,eventTitles,
  bundledCardIds:solverData.cards.map(card=>card.id),bundledSongIds:solverData.songs.map(song=>song.id),
})));
const achievementBundle=await build({entryPoints:[path.join(root,'source/captured-holodori/achievements.ts')],bundle:true,format:'esm',platform:'node',write:false});
const {buildAchievementCatalog,buildAchievementRewardCatalog}=await import('data:text/javascript;base64,'+Buffer.from(achievementBundle.outputFiles[0].contents).toString('base64'));
const achievementMaster=JSON.parse(await fs.readFile(path.join(root,'source/hololive/vendor/data/game-reference.json'),'utf8'));
const {LiveTower,LiveTowerStage}=achievementMaster.tables;
await fs.writeFile(path.join(optimizerAssets,'challenge-stages.json'),JSON.stringify({
  sourceCommit:achievementMaster.sourceCommit,
  stages:projectChallengeStages(LiveTower.map(row=>row.data),LiveTowerStage.map(row=>row.data)),
}));
const achievementAssets=path.join(out,'assets/achievements');
const rewardImages=Object.fromEntries((await fs.readdir(path.join(achievementAssets,'rewards')))
  .filter(file=>file.endsWith('.webp')).map(file=>[path.basename(file,'.webp'),'/assets/achievements/rewards/'+file]));
const achievementCategories=buildAchievementCatalog(achievementMaster.tables);
await fs.writeFile(path.join(achievementAssets,'catalog.json'),JSON.stringify({
  categories:achievementCategories,rewardImages,rewards:buildAchievementRewardCatalog(achievementCategories),
}));
const itemNames=new Map(achievementMaster.tables.LangItem_Eng.map(({data})=>[data.id,data.text]));
const gameInventoryAssets=path.join(out,'assets/game-inventory');
const itemImages={};
for(const file of await fs.readdir(path.join(gameInventoryAssets,'icons'))){
  const match=/^img_item_(thumb|icon)_([a-z0-9-]+)\.webp$/.exec(file);
  if(match&&(match[1]==='thumb'||!itemImages[match[2]]))itemImages[match[2]]='/assets/game-inventory/icons/'+file;
}
const inventoryItems=Object.fromEntries(achievementMaster.tables.Item.map(({data})=>{
  const image=itemImages[data.assetId]||rewardImages[data.id];
  if(!image)throw Error('Missing inventory item artwork: '+data.id);
  return [data.id,{name:itemNames.get(data.nameLangId),image,category:data.inventoryItemCategoryType?.split('_TYPE_').at(-1),type:data.type?.split('_TYPE_').at(-1),order:data.order}];
}));
const baitNames=new Map(achievementMaster.tables.LangParkFishingBait_Eng.map(({data})=>[data.id,data.text]));
const inventoryIconFiles=new Set(await fs.readdir(path.join(gameInventoryAssets,'icons')));
for(const {data} of achievementMaster.tables.ParkFishingBait){
  const asset=data.knownIconAssetId??data.assetId;
  const image=inventoryIconFiles.has(asset+'.webp')?'/assets/game-inventory/icons/'+asset+'.webp':undefined;
  inventoryItems[data.id]={name:baitNames.get(data.nameLangId),image,category:'OTHER',type:'FISHING_BAIT',order:data.order,unlimited:data.isUnlimited};
}
await fs.writeFile(path.join(gameInventoryAssets,'catalog.json'),JSON.stringify({items:inventoryItems,images:itemImages}));
await fs.cp(path.join(root,'source/hololive/branding'),path.join(out,'branding'),{recursive:true});
await fs.mkdir(path.join(out,'captured'),{recursive:true});
for(const [file,input]of [['vendor.css',path.join(archive,'upstream/assets/vendor-3469c8ca.css')],['theme.css',path.join(archive,'upstream/assets/index-0f094ee1.css')],['layouts.css',path.join(archive,'upstream/assets/layouts-f9ade246.css')],['desktop.css',path.join(archive,'source/desktop.css')]])await fs.copyFile(input,path.join(out,'captured',file));
await fs.writeFile(path.join(out,'captured/theme.css'),stripGameHistoryCss(await fs.readFile(path.join(out,'captured/theme.css'),'utf8')));
await fs.copyFile(path.join(root,'source/captured-holodori/card-stats.css'),path.join(out,'captured/card-stats.css'));
await fs.copyFile(path.join(root,'source/captured-holodori/achievements.css'),path.join(out,'captured/achievements.css'));
await fs.copyFile(path.join(root,'source/captured-holodori/account-progress.css'),path.join(out,'captured/account-progress.css'));
await fs.copyFile(path.join(root,'source/captured-holodori/holomem-board.css'),path.join(out,'captured/holomem-board.css'));
await fs.copyFile(path.join(root,'source/captured-holodori/team-optimizer.css'),path.join(out,'captured/team-optimizer.css'));
await fs.copyFile(path.join(root,'source/captured-holodori/holomem-leaderboard.css'),path.join(out,'captured/holomem-leaderboard.css'));
await fs.copyFile(path.join(root,'source/captured-holodori/desktop-settings.css'),path.join(out,'captured/desktop-settings.css'));
await fs.mkdir(path.join(out,'img/flags'),{recursive:true});
for(const name of ['de','en','es','fr','id','it','ja','ko','pt','ru','th','tr','tw','vi','zh']){const files=await fs.readdir(path.join(archive,'upstream/assets'));const file=files.find(file=>file.startsWith(name+'-')&&file.endsWith('.svg'));if(file)await fs.copyFile(path.join(archive,'upstream/assets',file),path.join(out,'img/flags',name+'.svg'));}
await fs.mkdir(path.join(out,'img/other'),{recursive:true});await fs.copyFile(path.join(archive,'upstream/img/other/times.svg'),path.join(out,'img/other/times.svg'));
await fs.copyFile(path.join(archive,'upstream/img/other/question-mark.svg'),path.join(out,'img/other/question-mark.svg'));
const html='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hololive Dreams Planner</title><link rel="icon" href="/branding/icon.ico"><link rel="stylesheet" href="/captured/vendor.css"><link rel="stylesheet" href="/captured/theme.css"><link rel="stylesheet" href="/captured/layouts.css"><link rel="stylesheet" href="/captured/desktop.css"><link rel="stylesheet" href="/captured/card-stats.css"><link rel="stylesheet" href="/captured/achievements.css"><link rel="stylesheet" href="/captured/account-progress.css"><link rel="stylesheet" href="/captured/holomem-board.css"><link rel="stylesheet" href="/captured/team-optimizer.css"><link rel="stylesheet" href="/captured/holomem-leaderboard.css"><script type="module" src="/app/main.js"></script></head><body style="background-color:#0D132B"><div id="app"></div></body></html>';
const mainOutput=Object.entries(result.metafile.outputs).find(([filename])=>filename.endsWith('/app/main.js'))?.[1];
const capturedEntry=mainOutput?.imports.find(entry=>entry.kind==='dynamic-import'&&path.basename(entry.path).startsWith('index-f19fde22-'));
const preload=capturedEntry?`<link rel="modulepreload" href="/app/${path.basename(capturedEntry.path)}">`:'';
await fs.writeFile(path.join(out,'index.html'),html.replace('</head>',preload+'<link rel="stylesheet" href="/captured/desktop-settings.css"></head>'));
await fs.mkdir(path.join(root,'evidence/captured-base'),{recursive:true});
await fs.copyFile(path.join(stage,'artwork-adaptations.json'),path.join(root,'evidence/captured-base/artwork-adaptations.json'));
await fs.writeFile(path.join(root,'evidence/hololive-build.json'),JSON.stringify(result.metafile,null,2));
await fs.writeFile(path.join(root,'evidence/captured-base/build.json'),JSON.stringify({version:metadata,base:sourcePath,sha256:crypto.createHash('sha256').update(source).digest('hex'),renderer:'actual-captured-vue',reactInputs:Object.keys(result.metafile.inputs).filter(name=>/react(?:-dom)?\//.test(name)),patches:effective.map(({start,end,reason})=>({start,end,reason})),inputs:Object.keys(result.metafile.inputs)},null,2));
console.log(`Built actual captured Vue application with ${effective.length} explicit game/offline adaptations.`);
