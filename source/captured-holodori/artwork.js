import {game} from './game';

// Holodori's local motion is an artwork source for the captured Share renderer.
// Its composition, cropping controls, canvas export and dialogs stay original.
export async function loadArtwork(staticLoader,args,signal) {
  const card=game.getCard(args.artKey),settings=window.__holodoriDesktop.getArtworkSettings(args.artKey);
  const preference=settings.animation;
  if(!card?.animation||preference==='off'||(preference==='inherit'&&!settings.cardAnimationsDefault))return staticLoader(args,signal);
  const video=document.createElement('video');video.muted=true;video.loop=true;video.playsInline=true;video.preload='auto';
  const release=()=>{video.pause();video.removeAttribute('src');video.load();};
  signal?.addEventListener('abort',release,{once:true});
  video.src=window.__holodoriAnimationUrl(card.assetId,`full-${args.variant>1?1:0}`);
  try{
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{cleanup();reject(Error('Local animation timed out'));},8000);const cleanup=()=>{clearTimeout(timer);video.removeEventListener('loadeddata',done);video.removeEventListener('error',failed);};const done=()=>{cleanup();resolve();};const failed=()=>{cleanup();reject(Error('Local animation unavailable'));};video.addEventListener('loadeddata',done,{once:true});video.addEventListener('error',failed,{once:true});video.load();});
    if(signal?.aborted){release();return {image:null,source:null};}
    video.width=video.videoWidth;video.height=video.videoHeight;await video.play();
    return {image:video,source:'official'};
  }catch{release();if(signal?.aborted)return {image:null,source:null};return staticLoader(args,signal);}
}
const drawings=new WeakMap();
/** Fit a complete card in the captured illustration slot. Zoom intentionally
 * crops; its focus remains bounded so dragging cannot expose an empty edge.
 * The original composer still paints the frame, labels, goals and materials.
 */
export function drawCardArtwork(context,image,box,options={}) {
  const width=image.naturalWidth||image.videoWidth||image.width;
  const height=image.naturalHeight||image.videoHeight||image.height;
  if(!width||!height)return;
  const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
  const zoom=clamp(Number(options.zoom)||1,1,3);
  const scale=Math.min(box.w/width,box.h/height)*zoom;
  const w=width*scale,h=height*scale;
  const x=clamp(box.x+box.w/2-(options.focusX??.5)*w,box.x+Math.min(0,box.w-w),box.x+Math.max(0,box.w-w));
  const y=clamp(box.y+box.h/2-(options.focusY??.5)*h,box.y+Math.min(0,box.h-h),box.y+Math.max(0,box.h-h));
  context.save();context.beginPath();context.rect(box.x,box.y,box.w,box.h);context.clip();
  context.beginPath();context.roundRect(x,y,w,h,18);context.clip();
  context.drawImage(image,x,y,w,h);context.restore();
}
export function drawArtwork(draw,canvas,model,format) {
  const video=model.art?.image,old=drawings.get(canvas);
  old?.stop(old.video!==video);
  draw(canvas,model,format);
  // Export canvases receive the same complete frame, without a display loop.
  if(!(video instanceof HTMLVideoElement)||!canvas.isConnected)return;
  const token={stopped:false,last:performance.now(),frame:null,video,stop:null};
  const observer=new MutationObserver(()=>{if(!canvas.isConnected)stop();});
  function stop(pause=true){
    if(token.stopped)return;
    token.stopped=true;
    if(token.frame!==null)cancelAnimationFrame(token.frame);
    token.frame=null;
    document.removeEventListener('visibilitychange',visible);
    video.removeEventListener('emptied',emptied);
    observer.disconnect();
    if(pause)video.pause();
    if(drawings.get(canvas)===token)drawings.delete(canvas);
  }
  const emptied=()=>stop();
  const schedule=()=>{if(!token.stopped&&token.frame===null)token.frame=requestAnimationFrame(frame);};
  const visible=()=>{
    if(token.stopped)return;
    if(!canvas.isConnected||!video.src){stop();return;}
    if(document.hidden){
      if(token.frame!==null)cancelAnimationFrame(token.frame);
      token.frame=null;
      video.pause();
      return;
    }
    if(video.paused)void video.play().catch(()=>{});
    schedule();
  };
  const frame=now=>{
    token.frame=null;
    if(token.stopped)return;
    if(!canvas.isConnected||!video.src){stop();return;}
    if(document.hidden){visible();return;}
    if(video.paused)void video.play().catch(()=>{});
    if(now-token.last>=1000/24){draw(canvas,model,format);token.last=now;}
    schedule();
  };
  token.stop=stop;drawings.set(canvas,token);
  document.addEventListener('visibilitychange',visible);
  video.addEventListener('emptied',emptied);
  observer.observe(document.documentElement,{childList:true,subtree:true});
  visible();
}
