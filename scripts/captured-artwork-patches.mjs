import fs from 'node:fs/promises';
import path from 'node:path';
import {parse} from 'acorn';
import {simple} from 'acorn-walk';

// Source-level adaptations of the captured composer/studio, not a replacement
// UI or canvas renderer. Preserve its controls, drawing order and export path.
export async function adaptCapturedArtworkLayouts(stage){
 const directory=path.join(stage,'assets'),log=[];
 async function edit(file,adapt){
  let source=await fs.readFile(path.join(directory,file),'utf8');const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'}),changes=[];
  const text=node=>source.slice(node.start,node.end),patch=(node,value,reason)=>{changes.push({start:node.start,end:node.end,value});log.push({file,reason});};
  const insert=(at,value,reason)=>patch({start:at,end:at},value,reason);
  adapt({ast,text,patch,insert});
  for(const change of changes.sort((a,b)=>b.start-a.start))source=source.slice(0,change.start)+change.value+source.slice(change.end);
  await fs.writeFile(path.join(directory,file),source);
 }
 await edit('engine-b9adcb25.js',({ast,patch,insert})=>{
  let count=0;simple(ast,{VariableDeclarator(node){if(node.id.name==='F'&&node.init.type==='ObjectExpression'){insert(node.init.start+1,'landscape:{id:"landscape",width:1820,height:1024},','Full-frame landscape export alongside original Square and Story');count++;}},
   Literal(node){if(node.value==='seelie.png')patch(node,'"holodori.png"','Use app branding for the image sharing check');},
  });
  if(count!==1)throw Error('Missing captured artwork formats');
 });
 await edit('layouts-65ca4188.js',({ast,text,patch,insert})=>{
  const functions=new Map();simple(ast,{FunctionDeclaration(node){functions.set(node.id.name,node);}});
  const composer=functions.get('vo');if(!composer)throw Error('Missing captured readiness composer');
  let slots=0,names=0,formats=0,grids=0,previews=0,themes=0;
  simple(composer.body,{LogicalExpression(node){
   if(node.operator==='&&'&&text(node.left)==='G(t,ee)>v'&&text(node.right).includes('ae=ze(t,ee,v,2)'))
    patch(node,'G(t,ee)>v&&(()=>{q=n?76:58;do{k(t,te(l,q));ae=ze(t,ee,v,2);if(!ae.at(-1)?.endsWith("…")||q<=(n?48:36))break;q-=2;}while(true);})()','Fit full member/variant names in the original two-line canvas caption');
  },VariableDeclarator(node){
   if(node.id.name==='u'&&node.init?.type==='ConditionalExpression'&&text(node.init).includes('Math.round(s*.66)')){
    patch(node.init,'n?{x:d,y:d,w:r-d*2,h:Math.round(s*.38)}:{x:Math.round(r*.48),y:d,w:Math.round(r*.52)-d,h:Math.round(s*.58)}','Fit full card art above material panels, beside original name/goal text');slots++;
   }
   if(node.id.name==='v'&&node.init?.type==='ConditionalExpression'&&text(node.init).includes('Math.round(r*.5)')){patch(node.init,'n?r-d*2:Math.round(r*.4)','Keep long card titles clear of the full-frame illustration');names++;}
  }});
  simple(ast,{
   CallExpression(node){if(node.callee.name==='ce'&&node.arguments[0]?.value==='square'){patch(node.arguments[0],'"landscape"','Open the original studio in horizontal card format');formats++;}},
   Literal(node){
    if(node.value==='Holodori Planner')patch(node,'"Hololive Dreams Planner"','Use the official project name on exported artwork');
    if(node.value==='Made with Seelie')patch(node,'"Made with"','Use the local planner name from the artwork theme');
    if(node.value==='[SEELIE share]')patch(node,'"[Holodori artwork]"','Use the app name in artwork diagnostics');
    if(node.value==='grid grid-cols-2 gap-1 p-1 rounded-lg bg-gray-900/60 ring-1 ring-inset ring-white/5'){patch(node,JSON.stringify(node.value.replace('grid-cols-2','grid-cols-3')),'Three original format radio controls in one compact row');grids++;}
    if(node.value==='relative grid place-items-center rounded-xl bg-black/30 ring-1 ring-inset ring-white/5 p-2 sm:p-3 min-h-[14rem] md:min-h-[26rem]'){patch(node,JSON.stringify(node.value.replace(' md:min-h-[26rem]','')),'Remove portrait-only minimum height from horizontal artwork preview');previews++;}
   },
   VariableDeclarator(node){if(node.id.name==='Ve'){patch(node.init,'{hololive:to}','Use the actual captured template artwork theme, rather than another game fallback');themes++;}},
  });
  patch(functions.get('Xe').body,'{return Ve[e]||Ve.hololive;}','Resolve the template theme for Holodori');
  patch(functions.get('ho').body,'{return holoCardArtwork(e,o,a,t);}','Fit and bound horizontal official art; preserve the original composer');
  insert(0,'import {drawCardArtwork as holoCardArtwork} from "/captured/artwork.js";','Local card-dimension adapter for original official-art slot');
  if([slots,names,formats,grids,previews,themes].some(count=>count!==1))throw Error('Captured artwork layout anchors changed: '+JSON.stringify({slots,names,formats,grids,previews,themes}));
 });
 await edit('ShareCompletionist-a24ab7fc.js',({ast,text,patch})=>{
  simple(ast,{TemplateLiteral(node){if(node.quasis[0]?.value.raw==='seelie-')patch(node,text(node).replace('seelie-','holodori-'),'Use the app name in exported achievement images');}});
 });
 await edit('ShareReadiness-1b2281d7.js',({ast,text,patch,insert})=>{
  let crops=0,tiles=0,images=0;simple(ast,{
   Literal(node){
    if(node.value===.32||node.value===.4){patch(node,'.5','Center new/reset horizontal artwork; keep existing stored framing');crops++;}
    if(node.value==='w-12 h-12 rounded-lg overflow-hidden ring-2 transition-all bg-gray-800'){patch(node,'"w-20 h-12 rounded-lg overflow-hidden ring-2 transition-all bg-gray-800"','Compact horizontal choices, including portrait uploads, in original Artwork radio buttons');tiles++;}
    if(node.value==='w-full h-full object-cover object-top'){patch(node,'"block w-full h-full object-contain"','Show complete frame in original artwork choices');images++;}
   },
   Property(node){if(node.key?.name==='src'&&node.value.type==='MemberExpression'&&node.value.property.name==='thumb')insert(node.start,'width:1820,height:1024,','Reserve horizontal artwork-choice dimensions');},
   TemplateLiteral(node){if(node.quasis[0]?.value.raw==='seelie-')patch(node,text(node).replace('seelie-','holodori-'),'Use the app name in exported artwork filenames');},
  });
  if(crops<4||tiles!==1||images!==1)throw Error('Missing captured artwork crop/choice anchors');
 });
 await edit('artStore-9382d89d.js',({ast,patch})=>{
  let count=0;simple(ast,{FunctionDeclaration(node){if(node.id.name!=='I')return;simple(node.body,{ForStatement(loop){
   if(loop.test?.type==='BinaryExpression'&&loop.test.operator==='>='&&loop.test.right.value===400){
    patch(loop.test,'n>=Math.min(400,Math.max(e.naturalWidth,e.naturalHeight))','Encode valid small artwork once instead of incorrectly rejecting it as too large');count++;
   }
  }});}});if(count!==1)throw Error('Missing captured artwork encoder size boundary');
 });
 await fs.writeFile(path.join(stage,'artwork-adaptations.json'),JSON.stringify({renderer:'actual-captured-vue',changes:log},null,2));
}
