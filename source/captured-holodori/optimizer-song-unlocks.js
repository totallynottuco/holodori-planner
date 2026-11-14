const key = 'optimizer_song_unlocks';

function profiles(storage){
  try{
    const value=JSON.parse(storage.getItem(key)??'{}');
    return value && typeof value==='object' && !Array.isArray(value)?value:{};
  }catch{return {};}
}

export function loadExtraSongs(storage,id){
  const values=profiles(storage)[id];
  return Array.isArray(values)?[...new Set(values.filter(value=>typeof value==='string'&&/^m\d{4}$/.test(value)))]:[];
}

export function saveExtraSongs(storage,id,songs){
  const all=profiles(storage);
  if(songs.length)all[id]=songs;
  else if(Object.hasOwn(all,id))delete all[id];
  else return;
  if(Object.keys(all).length)storage.setItem(key,JSON.stringify(all));
  else storage.removeItem(key);
}
