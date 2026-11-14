import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'hololive-dist');
const shell = path.join(root, '.desktop-shell');
const outfits = path.join(dist, 'assets', 'outfits');
const chartArtwork = path.join(dist, 'assets', 'chart-artwork');
const soundtracks = path.join(dist, 'assets', 'team-optimizer', 'soundtracks');
const externalMedia=new Set([outfits,chartArtwork,soundtracks]);

if (path.dirname(shell) !== root || path.basename(shell) !== '.desktop-shell')
  throw Error('Unexpected desktop staging directory.');
await fs.rm(shell, {recursive:true,force:true});
await fs.cp(dist, shell, {recursive:true,filter:source=>!externalMedia.has(source)});
for(const media of [chartArtwork,soundtracks]){
  const fallback=path.join(shell,path.relative(dist,media));
  await fs.mkdir(fallback,{recursive:true});
  await fs.writeFile(path.join(fallback,'index.json'),'{}');
}
