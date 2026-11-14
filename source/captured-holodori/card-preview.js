import {game} from './game';
import {effectiveCardAnimations} from '../hololive/vendor/shared/card-animation';

/** Native video playback reuses the reference's full-0/full-1 + alpha signature
 * composition; there is no per-frame canvas work or extra saved setting. */
export function createCardPreview(h){
  return {name:'CardPreview',props:{cardId:String,account:String,goals:Array,active:{type:Boolean,default:true}},
    data(){return {signatureOverride:null,signatureOwner:null,inView:true,baseReady:false,baseError:false,signatureError:false};},
    computed:{
      card(){return game.getCard(this.cardId);},
      media(){
        const profile=window.__seelieApp?.data?.[`${this.account}-holodori`];
        const settings=window.__holodoriDesktop.getArtworkSettings(this.cardId,this.account);
        const preferences={animation:settings.animation,signature:this.signatureOverride===null?settings.signature:this.signatureOverride?'on':'off'};
        return this.card?effectiveCardAnimations(this.card,{artworkPreferences:preferences},profile?.preferences?.cardAnimationsDefault??settings.cardAnimationsDefault):{animation:false,signature:false};
      },
      mediaKey(){return `${this.account}:${this.cardId}:${this.media.animation}:${this.media.signature}`;},
    },
    watch:{
      mediaKey:{flush:'sync',handler(){this.releaseVideos();this.baseReady=false;this.baseError=false;this.signatureError=false;this.$nextTick(()=>this.updatePlayback());}},
      active(){this.updatePlayback();},
      account(){this.signatureOverride=null;this.signatureOwner=null;},cardId(){this.signatureOverride=null;this.signatureOwner=null;},
      goals(){if(this.signatureOverride!==null)this.saveSignature();},
    },
    mounted(){
      this.visibilityHandler=()=>this.updatePlayback();document.addEventListener('visibilitychange',this.visibilityHandler);
      this.mediaObserver=new IntersectionObserver(entries=>{this.inView=entries.some(entry=>entry.isIntersecting);this.updatePlayback();});
      this.mediaObserver.observe(this.$el);this.updatePlayback();
    },
    beforeUnmount(){document.removeEventListener('visibilitychange',this.visibilityHandler);this.mediaObserver?.disconnect();this.releaseVideos();},
    methods:{
      releaseVideos(){for(const key of ['baseVideo','signatureVideo']){const video=this.$refs[key];if(video){video.pause();video.removeAttribute('src');video.load();}}},
      updatePlayback(restarting=false){for(const key of ['baseVideo','signatureVideo']){const video=this.$refs[key];if(!video)continue;if(document.hidden||!this.inView||!this.active)video.pause();else if(restarting||!video.ended)void video.play().catch(()=>{});}},
      restartSignedLoop(base){
        const signature=this.$refs.signatureVideo;
        base.currentTime=0;
        if(signature?.readyState)signature.currentTime=0;
        // A seek can leave ended set until the decoder presents the first frame.
        this.updatePlayback(true);
      },
      saveSignature(){const value=this.signatureOverride;if(this.signatureOwner!==`${this.account}:${this.cardId}`){this.signatureOverride=null;return;}if(value!==null&&window.__holodoriDesktop.setCardArtworkPreferences(this.cardId,{signature:value?'on':'off'},this.account))this.signatureOverride=null;},
      toggleSignature(){this.signatureOwner=`${this.account}:${this.cardId}`;this.signatureOverride=!this.media.signature;this.saveSignature();},
    },
    render(){
      const card=this.card,media=this.media,key=this.mediaKey,url=kind=>window.__holodoriAnimationUrl(card.assetId,kind);
      return h('div',{class:'holo-card-stats-art bg-gray-600/50 border border-gray-600 rounded overflow-hidden','data-card-preview':''},[
        h('img',{src:game.cardImage(this.cardId,'landscape'),alt:card?.cardName||'Card artwork',width:455,height:256,decoding:'async'}),
        card&&media.animation&&!this.baseError?h('video',{
          key:key+'-base',ref:'baseVideo',class:'holo-card-video',style:{opacity:this.baseReady?1:0},
          src:url(media.signature?'full-1':'full-0'),muted:true,loop:!media.signature,playsinline:true,preload:'auto','aria-hidden':'true',
          onLoadeddata:()=>{if(this.mediaKey===key){this.baseReady=true;this.updatePlayback();}},
          onEnded:event=>{if(this.mediaKey===key&&media.signature)this.restartSignedLoop(event.currentTarget);},
          onError:()=>{if(this.mediaKey===key)this.baseError=true;},
        }):null,
        card&&media.signature&&!this.signatureError?h('video',{key:key+'-signature',ref:'signatureVideo',class:'holo-card-video holo-card-signature',src:url('signature'),muted:true,playsinline:true,preload:'auto','aria-hidden':'true',onLoadeddata:()=>{if(this.mediaKey===key)this.updatePlayback();},onError:()=>{if(this.mediaKey===key)this.signatureError=true;}}):null,
        card?.animation?.signature?h('button',{type:'button',role:'switch','aria-label':'Show signature','aria-checked':media.signature,title:'Show Signature',class:'holo-card-signature-toggle',onClick:this.toggleSignature},[
          h('span',{class:'holo-signature-track'+(media.signature?' is-on':''),'aria-hidden':'true'},[h('img',{class:'holo-signature-icon',src:'/assets/ui/signature-toggle.png',alt:'',width:28,height:28}),h('span',{class:'holo-signature-knob'})]),
        ]):null,
      ]);
    },
  };
}
