import fs from 'node:fs/promises';
import path from 'node:path';
import {parse} from 'acorn';
import {simple} from 'acorn-walk';
import {adaptCapturedArtworkLayouts} from './captured-artwork-patches.mjs';

// Tailwind captured changelog markup as invalid `bold:Name` declarations.
// These carry game names, have no CSS effect, and are not theme rules.
export const stripGameHistoryCss=css=>css.replace(/[^{}]+\{bold:[^{}]*\}/g,'');

// Locale exports include both raw dictionaries and Vite namespace facades. Keep
// their exact export contracts, without carrying the retired game's named data.
export async function adaptCapturedData(stage, source, labels) {
  const uiKeys=new Set();
  simple(parse(source,{ecmaVersion:'latest',sourceType:'module'}),{CallExpression(n){if(n.callee.type==='MemberExpression'&&['$t','$te'].includes(n.callee.property.name)&&n.arguments[0]?.type==='Literal')uiKeys.add(n.arguments[0].value);}});
  const directory=path.join(stage,'assets/locale');
  await fs.writeFile(path.join(directory,'holodori-labels.js'),'import {translations} from "/captured/game.js";const labels='+JSON.stringify(labels)+';Object.assign(labels,translations);export default labels;');
  for(const file of await fs.readdir(directory)) {
    if(!file.endsWith('.js')||file==='holodori-labels.js')continue;
    const filePath=path.join(directory,file);
    if(file.startsWith('achievements-')){await fs.writeFile(filePath,'export default [];');continue;}
    const raw=await fs.readFile(filePath,'utf8'),tree=parse(raw,{ecmaVersion:'latest',sourceType:'module'}),bindings=new Map(),memo=new Map();
    simple(tree,{VariableDeclarator(n){if(n.id.type==='Identifier')bindings.set(n.id.name,n.init);}});
    const read=n=>{
      if(!n)return undefined;
      if(n.type==='Literal')return n.value;
      if(n.type==='TemplateLiteral'){let result='';for(let i=0;i<n.quasis.length;i++)result+=n.quasis[i].value.cooked+(i<n.expressions.length?String(read(n.expressions[i])):'');return result;}
      if(n.type==='Identifier'){if(memo.has(n.name))return memo.get(n.name);memo.set(n.name,undefined);const value=read(bindings.get(n.name));memo.set(n.name,value);return value;}
      if(n.type==='ArrayExpression')return n.elements.map(read);
      if(n.type==='ObjectExpression'){const result={};for(const p of n.properties){if(p.type==='SpreadElement')Object.assign(result,read(p.argument));else result[p.key.name??p.key.value]=read(p.value);}return result;}
      if(n.type==='CallExpression'&&n.callee.type==='MemberExpression'&&n.callee.object.name==='Object')return read(n.arguments[0]);
      if(n.type==='UnaryExpression'&&n.operator==='!')return !read(n.argument);
      throw Error('Unsupported captured locale data expression '+n.type+' in '+file);
    };
    const exports=tree.body.find(n=>n.type==='ExportNamedDeclaration')?.specifiers||[];
    const locals=[];
    for(const specifier of exports){
      const name=specifier.local.name,value=read({type:'Identifier',name});
      if(!value||typeof value!=='object')throw Error('Unexpected locale export '+file+':'+name);
      const namespace=Object.hasOwn(value,'default'),dictionary=namespace?value.default:value;
      const isGame=Object.keys(dictionary).length>500;
      const clean={};
      for(const [key,item]of Object.entries(dictionary)){
        if(isGame&&!uiKeys.has(key))continue;
        if(/hoyo|honkai|star.?rail|trailblaz|seelie|patreon|supporter|privacy|adsense|light.cone|stell(ar|ar)|resin|hsr|genshin|zenless|warp|^(?:ads_|sync_|cloud_|drive_)/i.test(key+' '+JSON.stringify(item)))continue;
        clean[key]=key==='notes_format'&&typeof item==='string'?item.replaceAll('https://google.com','URL'):item;
      }
      locals.push(`const ${name}Data={...${JSON.stringify(clean)},...labels};const ${name}=${namespace?`{...${name}Data,default:${name}Data}`:`${name}Data`};`);
    }
    await fs.writeFile(filePath,'import labels from "./holodori-labels.js";'+locals.join('\n')+'export {'+exports.map(n=>n.local.name+' as '+n.exported.name).join(',')+'};');
  }
  // These are data-only history payloads; the captured changelog component stays.
  for(const file of await fs.readdir(path.join(stage,'assets')))if(file.startsWith('changelog-full-')&&file.endsWith('.js'))await fs.writeFile(path.join(stage,'assets',file),'export default [];');
}

export async function adaptCapturedLazyAssets(stage) {
  const directory=path.join(stage,'assets');
  for(const file of await fs.readdir(directory)){
    if(!file.endsWith('.js')||file==='index-f19fde22.js')continue;
    const filePath=path.join(directory,file),raw=await fs.readFile(filePath,'utf8'),tree=parse(raw,{ecmaVersion:'latest',sourceType:'module'}),edits=[];
    simple(tree,{CallExpression(n){if(n.arguments[0]?.type==='ArrowFunctionExpression'&&n.arguments[1]?.type==='ArrayExpression'&&raw.slice(n.arguments[0].start,n.arguments[0].end).includes('import('))edits.push({start:n.arguments[1].start,end:n.arguments[1].end,value:'[]'});},Literal(n){
      const names={'Honkai: Star Rail':'hololive Dreams','Genshin Impact':'hololive Dreams','Zenless Zone Zero':'hololive Dreams','hsr.seelie.me':'Hololive Dreams Planner','seelie.me':'Hololive Dreams Planner','zzz.seelie.me':'Hololive Dreams Planner','hsr':'hololive','gi':'hololive','zzz':'hololive'};
      const replacement=typeof n.value==='string'&&Object.hasOwn(names,n.value)?names[n.value]:undefined;
      if(replacement)edits.push({start:n.start,end:n.end,value:JSON.stringify(replacement)});
    }});
    let result=raw;for(const edit of edits.sort((a,b)=>b.start-a.start))result=result.slice(0,edit.start)+edit.value+result.slice(edit.end);
    await fs.writeFile(filePath,result);
  }
  const artPath=path.join(directory,'artStore-9382d89d.js');let art=await fs.readFile(artPath,'utf8');
  const start=art.indexOf('async function x('),end=art.indexOf('function A(',start);
  if(start<0||end<0)throw Error('Missing captured artwork repository boundary');
  art=art.slice(0,start)+`
const nativeKey=(...parts)=>parts.map(p=>Array.from(new TextEncoder().encode(String(p)),b=>b.toString(16).padStart(2,'0')).join('')).join('-');
const nativeArt=(op,key,data)=>window.__holodoriDesktop.nativeArt(op,key,data);
async function x(t,e,n){const raw=await nativeArt('get',nativeKey(t,e,n));if(!raw)return null;const value=JSON.parse(raw);const [head,body]=value.data.split(',');value.blob=new Blob([Uint8Array.from(atob(body),c=>c.charCodeAt(0))],{type:head.slice(5).split(';')[0]});delete value.data;return value;}
async function M(t,e,n,metadata,overrides={}){metadata=Promise.resolve(metadata);metadata.catch(()=>{});let result=null,preparationError=null;await nativeArt('put',nativeKey(t,e,n),async()=>{let prepared;try{prepared=await metadata;}catch(error){if(!(error instanceof i))throw error;preparationError=error;return null;}const {blob:r,width:o,height:a,crop:c,enabled:s=true}={...prepared,...overrides};const value={key:h(t,e,n),owner:f(t,e),width:o,height:a,crop:c||{x:.5,y:.5,zoom:1},enabled:s,updated:Date.now()};const data=await new Promise((resolve,reject)=>{const reader=new FileReader;reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(r)});result={...value,blob:r};return JSON.stringify({...value,data});});if(preparationError)throw preparationError;return result;}
async function R(t,e,n,r){let result=null;await nativeArt('put',nativeKey(t,e,n),async()=>{const o=await x(t,e,n);if(!o)return null;const value={...o,crop:{...r},updated:Date.now()};const data=await new Promise((resolve,reject)=>{const reader=new FileReader;reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(o.blob)});result=value;const {blob,...stored}=value;return JSON.stringify({...stored,data});});return result;}
async function U(t,e,n){await nativeArt('remove',nativeKey(t,e,n));}
async function E(t,e){await nativeArt('clear',nativeKey(t,e));}
`+art.slice(end);await fs.writeFile(artPath,art);
  const officialPath=path.join(directory,'officialArt-2015b6ff.js');let official=await fs.readFile(officialPath,'utf8');
  const tree=parse(official,{ecmaVersion:'latest',sourceType:'module'});simple(tree,{FunctionDeclaration(n){if(n.id.name==='m')official=official.slice(0,n.body.start)+'{return e?holoGame.cardImage(e,"full"):null;}'+official.slice(n.body.end);}});
  await fs.writeFile(officialPath,'import {game as holoGame} from "/captured/game.js";'+official);
  // Preserve the original artwork selector and draw function; supply local video
  // frames only when the user's existing Holodori animation preference allows.
  const motionTree=parse(official,{ecmaVersion:'latest',sourceType:'module'});let loadName;
  simple(motionTree,{FunctionDeclaration(n){if(n.id.name==='y')loadName=n.id;}});
  if(!loadName)throw Error('Missing captured official artwork loader');
  official=official.slice(0,loadName.start)+'holoStaticArt'+official.slice(loadName.end);
  await fs.writeFile(officialPath,'import {game as holoGame} from "/captured/game.js";import {loadArtwork as holoLoadArtwork} from "/captured/artwork.js";'+official+'\nasync function y(args,signal){return holoLoadArtwork(holoStaticArt,args,signal);}');
  const sharePath=path.join(directory,'ShareReadiness-1b2281d7.js');let share=await fs.readFile(sharePath,'utf8');
  const shareTree=parse(share,{ecmaVersion:'latest',sourceType:'module'}),drawCalls=[],cropChanges=[];
  const imports=new Map();
  for(const declaration of shareTree.body.filter(n=>n.type==='ImportDeclaration'))for(const specifier of declaration.specifiers)if(specifier.type==='ImportSpecifier')imports.set(specifier.imported.name,specifier.local.name);
  const officialCrop=imports.get('setOfficialCrop'),customCrop=imports.get('saveCrop'),optimize=imports.get('optimizeImage'),saveArt=imports.get('saveArt'),slice=n=>share.slice(n.start,n.end);
  let cropTimer=0,cropWrites=0,cropClears=0,uploadBoundary=0,timerName,cropWrite,officialCall,customCondition,errorHandler;
  simple(shareTree,{AssignmentExpression(n){if(n.right.type==='CallExpression'&&n.right.callee.name==='setTimeout'&&n.right.arguments[1]?.value===400){
    let call,condition,handler;
    simple(n.right.arguments[0],{CallExpression(node){if(node.callee.name===officialCrop)call=node;if(node.callee.type==='MemberExpression'&&node.callee.property.name==='catch'&&node.callee.object.callee?.name===customCrop)handler=node.arguments[0];},IfStatement(node){if(node.test.type==='UnaryExpression'&&node.test.operator==='!'&&node.consequent.argument?.callee?.name===officialCrop)condition=node.test.argument;}});
    if(call&&condition&&handler){cropWrite=n;timerName=n.left.name;officialCall=call;customCondition=condition;errorHandler=handler;cropWrites++;}
  }}});
  if(cropWrites!==1)throw Error('Missing captured crop write boundary');
  const args=officialCall.arguments;
  cropChanges.push({start:cropWrite.start,end:cropWrite.end,value:`${timerName}.schedule({game:${slice(args[0])},account:${slice(args[1])},character:${slice(args[2])},variant:${slice(args[3])},crop:${slice(args[4])},custom:${slice(customCondition)}})`});
  simple(shareTree,{
    FunctionDeclaration(n){
      let preparation,save,declaration;
      simple(n.body,{VariableDeclarator(node){if(node.init?.type==='AwaitExpression'&&node.init.argument.callee?.name===optimize)preparation=node;},VariableDeclaration(node){if(node.declarations.some(item=>item.init?.type==='AwaitExpression'&&item.init.argument.callee?.name===saveArt)){declaration=node;save=node.declarations.find(item=>item.init?.argument?.callee?.name===saveArt).init.argument;}}});
      if(!preparation||!save)return;
      uploadBoundary++;
      const body=n.body.body.find(node=>node.type==='IfStatement')?.consequent;
      if(!body)throw Error('Missing captured artwork upload body');
      const owner=save.arguments.slice(0,3).map(slice),crop=save.arguments[3].properties.find(p=>p.key?.name==='crop').value;
      cropChanges.push({start:body.start+1,end:body.start+1,value:`const owner={game:${owner[0]},account:${owner[1]},character:${owner[2]}};`});
      cropChanges.push({start:preparation.init.start,end:preparation.init.end,value:slice(preparation.init.argument)});
      cropChanges.push({start:save.start,end:save.end,value:`${saveArt}(owner.game,owner.account,owner.character,${preparation.id.name},{crop:${slice(crop)}})`});
      cropChanges.push({start:declaration.end,end:declaration.end,value:`if(owner.game!==${owner[0]}||owner.account!==${owner[1]}||owner.character!==${owner[2]})return;`});
    },
    VariableDeclarator(n){if(n.id.name===timerName&&n.init?.value===null){cropTimer++;cropChanges.push({start:n.init.start,end:n.init.end,value:`holoCropScheduler({official:${officialCrop},custom:${customCrop},onError:${slice(errorHandler)}})`});}},
    CallExpression(n){if(n.callee.name==='Oe')drawCalls.push(n);if(n.callee.name==='clearTimeout'&&n.arguments[0]?.name===timerName){cropClears++;cropChanges.push({start:n.start,end:n.end,value:`${timerName}.flush()`});}},
  });
  if(drawCalls.length!==1)throw Error('Missing captured readiness canvas draw boundary');
  if(cropTimer!==1||cropWrites!==1||cropClears!==2)throw Error('Missing captured crop persistence boundary');
  if(uploadBoundary!==1)throw Error('Missing captured artwork upload preparation boundary');
  // Replacing a pending draft cancels it; component teardown flushes it. Both
  // calls were clearTimeout(F) in the capture, in that source order.
  cropChanges.filter(n=>n.value===`${timerName}.flush()`).sort((a,b)=>a.start-b.start)[0].value=`${timerName}.cancel()`;
  for(const n of drawCalls)cropChanges.push({start:n.start,end:n.end,value:'holoDrawArtwork(Oe,'+share.slice(n.callee.end+1,n.end)});
  for(const edit of cropChanges.sort((a,b)=>b.start-a.start))share=share.slice(0,edit.start)+edit.value+share.slice(edit.end);
  await fs.writeFile(sharePath,'import {drawArtwork as holoDrawArtwork} from "/captured/artwork.js";import {createCropScheduler as holoCropScheduler} from "/captured/artwork-state.js";'+share);
  await adaptCapturedArtworkLayouts(stage);
}
