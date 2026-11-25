import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {chromium} from 'playwright';
export const root=path.resolve(import.meta.dirname,'..');
export async function capturedTest(run,{values:initial={},original=false,viewport={width:1440,height:1000},optimizerCatalog=null,mobileCatalog=null,catalog=null,ratingStandings,chromiumArgs=[]}={}){
 const values={game_id:'hololive-dreams',accounts:'[]',account:'main',...initial},events={errors:[],failed:[],external:[],downloads:[],backups:0,closed:false};
 const directory=path.join(root,original?'template-backup/hsr-template-1.0.2-build3/retired-runtime/desktop-dist':'hololive-dist');
 const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.webm':'video/webm'};
 const server=http.createServer(async(req,res)=>{let file=path.join(directory,decodeURIComponent(new URL(req.url,'http://local').pathname));try{if(!file.startsWith(directory+path.sep))throw Error('path');let bytes;try{bytes=await fs.readFile(file);}catch{if(path.extname(file)){res.writeHead(404).end();return;}file=path.join(directory,'index.html');bytes=await fs.readFile(file);}res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(bytes);}catch{res.writeHead(404).end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 const executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();
 const browser=await chromium.launch({headless:true,args:chromiumArgs,executablePath});
 const context=await browser.newContext({viewport,serviceWorkers:'block',baseURL:base});
 let revision=0,fail=false,deleteTicket=null;
 await context.exposeBinding('__invoke',async({page},name,args)=>{
  if(name==='desktop_bootstrap')return{values:{...values},revision,dataDir:'Isolated test profile directory',animationDir:'',recovery:[],smoke:null,catalog};
  if(name==='desktop_show_ready'){events.shown=await page.evaluate(()=>!!document.querySelector('#main h1'));return;}
  if(name==='desktop_optimizer_catalog_read')return optimizerCatalog;
  if(name==='desktop_mobile_scoring_read')return mobileCatalog;
  if(ratingStandings!==undefined&&name==='desktop_holomem_rating_standings')return ratingStandings[args.region]??{};
  if(ratingStandings!==undefined&&name==='desktop_refresh_holomem_rankings')return false;
  if(name==='desktop_save'){if(fail)throw Error('Simulated disk write failure');for(const[key,value]of Object.entries(args.patch)){if(value===null)delete values[key];else values[key]=value;}return ++revision;}
  if(name==='desktop_art')return null;
  if(name==='desktop_prepare_delete_data'){events.deletePrepared=(events.deletePrepared||0)+1;deleteTicket='isolated-delete-'+revision;return deleteTicket;}
  if(name==='desktop_cancel_delete_data'){deleteTicket=null;return true;}
  if(name==='desktop_delete_all_data'){
   if(!deleteTicket||args.token!==deleteTicket)throw Error('Review both delete warnings first.');
   if(events.failDelete)return{completed:false,pending:false,error:'Simulated deletion failure'};
   events.deleted=(events.deleted||0)+1;for(const key of Object.keys(values))delete values[key];Object.assign(values,{game_id:'hololive-dreams',account:'main',accounts:'[]'});revision=0;deleteTicket=null;return{completed:true,pending:false,error:null};
  }
  if(name==='desktop_download'||name==='desktop_save_image'){events.downloads.push(args);return true;}
  if(name==='desktop_backup'){events.backups++;return true;}
  if(name==='desktop_close'){events.closed=true;return true;}
  if(name==='desktop_export'||name==='desktop_open_folder'||name==='desktop_cancel_restore')return true;
  if(name==='desktop_import')return null;
  throw Error('Unexpected native request '+name);
 });
 await context.addInitScript(hasCatalog=>{window.__TAURI__={core:{invoke:(name,args)=>window.__invoke(name,args),
  convertFileSrc:value=>hasCatalog?'http://asset.localhost/'+encodeURIComponent(value):value}};},!!catalog);
 await context.route('**/*',async route=>{
  const url=route.request().url(),parsed=new URL(url);
  if(catalog&&parsed.origin==='http://asset.localhost'){
   const file=path.resolve(decodeURIComponent(parsed.pathname.slice(1))),directory=path.resolve(catalog.assetDir);
   if(!file.startsWith(directory+path.sep))return route.abort();
   try{return route.fulfill({status:200,contentType:mime[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file)});}
   catch{return route.abort();}
  }
  if(parsed.origin!==base){events.external.push(url);return route.abort();}
  return route.continue();
 });
 const page=await context.newPage();page.on('pageerror',error=>events.errors.push(error.stack||error.message));page.on('console',message=>{if(message.type()==='error')events.errors.push(message.text());});page.on('response',response=>{if(response.status()>=400)events.failed.push(response.url());});
 await fs.mkdir(path.join(root,'evidence/captured-base'),{recursive:true});
 try{return await run({page,context,values,events,base,failSaves(value){fail=value;}});}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
}
