// The captured crop controls keep their own rendering and calculations. This
// scheduler only makes their delayed storage write part of desktop autosave.
export function createCropScheduler({official,custom,onError}) {
  let timer=null,pending=null;
  const scheduler={
    cancel(){clearTimeout(timer);timer=null;pending=null;},
    flush(){
      clearTimeout(timer);timer=null;
      const value=pending;pending=null;if(!value)return;
      try{
        const result=value.custom
          ?custom(value.game,value.account,value.character,value.crop)
          :official(value.game,value.account,value.character,value.variant,value.crop);
        Promise.resolve(result).catch(onError);
      }catch(error){onError(error);}
    },
    schedule(value){
      clearTimeout(timer);
      pending={...value,game:String(value.game),account:String(value.account),character:String(value.character),crop:{...value.crop},at:Date.now()};
      timer=setTimeout(()=>scheduler.flush(),400);
    },
  };
  window.__holodoriDesktop.trackDebounce(scheduler);
  return scheduler;
}
