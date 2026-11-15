import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

// Keep each hosted transfer modest. The complete archives remain the offline payloads.
const partSize=24*1024*1024;
const [payload,manifestFile,indexFile,uploadTarget,splitPlan,coreUploadDirectory]=process.argv.slice(2);
const uploadDirectory=uploadTarget==='-'?null:uploadTarget;
if(!payload||!manifestFile||!indexFile)throw Error('Expected payload directory, output manifest and Setup index.');
const manifest=JSON.parse(await fs.readFile(path.join(payload,'media-packs.json'),'utf8'));
const splits=splitPlan&&splitPlan!=='-'?JSON.parse(await fs.readFile(splitPlan,'utf8')):{};
if(uploadDirectory)await fs.mkdir(uploadDirectory,{recursive:true});
const index=[];
const buffer=Buffer.alloc(partSize);
const sha256=buffer=>createHash('sha256').update(buffer).digest('hex');

async function segment(file,logicalName,stem,destination=uploadDirectory){
  const handle=await fs.open(file,'r');
  const parts=[];
  let number=0;
  try{
    while(true){
      let length=0;
      while(length<buffer.length){
        const {bytesRead}=await handle.read(buffer,length,buffer.length-length,null);
        if(!bytesRead)break;
        length+=bytesRead;
      }
      if(!length)break;
      const part=String(number++).padStart(3,'0');
      const split=splits[`${stem}-${part}`];
      if(split!==undefined&&(!Number.isSafeInteger(split)||split<1024*1024||split>=partSize)){
        throw Error('Invalid hosted part split size.');
      }
      const step=split??partSize;
      for(let offset=0;offset<length;offset+=step){
        const data=buffer.subarray(offset,Math.min(offset+step,length));
        const hash=sha256(data);
        const suffix=split?`${part}-${String(offset/step).padStart(2,'0')}`:part;
        const name=`${stem}-${suffix}.bin`;
        if(destination)await fs.writeFile(path.join(destination,name),data);
        index.push(`${logicalName}|${name}|${hash}`);
        parts.push({size:data.length,sha256:hash,suffix});
      }
    }
  }finally{await handle.close();}
  if(!parts.length)throw Error(`Empty hosted payload ${logicalName}`);
  return parts;
}

for(const pack of manifest.packs){
  if(!['animations','outfits','charts','music'].includes(pack.id)||!/^[a-f0-9]{64}$/.test(pack.sha256))
    throw Error('Invalid pack identity.');
  const stem=`${pack.id}-${pack.sha256}`;
  pack.parts=await segment(path.join(payload,stem+'.zip'),pack.id+'.zip',stem);
  if(pack.parts.reduce((sum,part)=>sum+part.size,0)!==pack.size)throw Error(`Archive size changed for ${pack.id}`);
}
const runtimes=(await fs.readdir(payload)).filter(name=>/^WebView2RuntimeInstaller-[a-f0-9]{64}\.exe$/.test(name));
if(runtimes.length!==1)throw Error('Expected one hashed WebView2 runtime.');
await segment(path.join(payload,runtimes[0]),'WebView2RuntimeInstaller.exe',path.basename(runtimes[0],'.exe'));
const cores=(await fs.readdir(payload)).filter(name=>/^core-[a-f0-9]{64}\.zip$/.test(name));
if(cores.length>1||coreUploadDirectory&&cores.length!==1)throw Error('Expected one hashed core archive.');
if(coreUploadDirectory)await fs.mkdir(coreUploadDirectory,{recursive:true});
if(cores.length)await segment(path.join(payload,cores[0]),'core.zip',path.basename(cores[0],'.zip'),coreUploadDirectory??uploadDirectory);
await fs.writeFile(manifestFile,JSON.stringify(manifest)+'\n');
await fs.writeFile(indexFile,index.join('\r\n')+'\r\n','ascii');
console.log(`Prepared ${index.length} verified download parts.`);
