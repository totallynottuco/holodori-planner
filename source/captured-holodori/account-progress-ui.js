import {formatNumber,parseNumber} from './regional-formats.js';
import {
  accountRosterBranches,
} from '../hololive/vendor/shared/account-data';
import {createDefaultAccountState} from '../hololive/vendor/shared/profile';
import {accountProgressLimits,accountProgressMemoryBonus,accountProgressRank} from './account-progress';
import {createHolomemBoard} from './holomem-board-ui';

const emptyAccount = createDefaultAccountState();
const roster = accountRosterBranches.map(branch => ({
  ...branch,members:branch.generations.flatMap(group => group.characters),
}));
const entryNumber = parseNumber;

export function createAccountProgress({h,vnode,resolve,Search,OverlayPanel,Dialog,headingClass,titleClass}) {
  const Board=createHolomemBoard({h,vnode,Search,Dialog});
  return {
    name:'HolodoriAccountProgress',
    data() { return {search:'',editor:null,sliderDrafts:{},section:'overview'}; },
    computed:{
      profileId() { return window.__seelieApp?.account || 'main'; },
      profile() { return window.__seelieApp?.data?.[`${this.profileId}-holodori`]; },
      progressAccount() { return this.profile?.account ?? emptyAccount; },
      importedRanks() {
        return new Map(this.profile?.gameAccountImport?.snapshot.tables.members.map(member => [member.characterId,member.level]));
      },
      unlocked() { return new Set(this.progressAccount.unlockedCharacterIds); },
      visibleBranches() {
        const query = this.search.trim().toLocaleLowerCase();
        return roster.map(branch => ({
          ...branch,members:branch.members.filter(member =>
            `${member.name} ${member.shortName}`.toLocaleLowerCase().includes(query)),
        })).filter(branch => branch.members.length);
      },
    },
    watch:{
      profileId() {
        this.finishEditor({cancel:true});
        this.sliderDrafts = {};
      },
    },
    beforeUnmount() { this.commitEditor(); },
    methods:{
      selectSection(section) {
        if(section===this.section)return;
        this.finishEditor();
        this.section=section;
      },
      save(edit) { window.__holodoriDesktop.setAccountProgress(this.profileId,edit); },
      editChip(event,details,digit) {
        const anchor = event.currentTarget;
        if (this.editor?.anchor === anchor) {
          this.finishEditor();
          return;
        }
        this.commitEditor();
        this.editor = {...details,anchor,profileId:this.profileId,text:digit ?? formatNumber(details.value),
          episode:details.episode == null ? '' : formatNumber(details.episode),direct:digit != null};
        const panel = this.$refs.progressEditor;
        const alreadyOpen = panel.visible;
        panel.show(event,anchor);
        if (alreadyOpen) this.$nextTick(() => { panel.alignOverlay(); this.focusEditor(); });
      },
      focusEditor() {
        const input = this.$refs.progressInput;
        if (!input || !this.editor) return;
        input.focus();
        if (this.editor.direct) input.setSelectionRange(input.value.length,input.value.length);
        else input.select();
      },
      commitEditor(cancel=false) {
        const editor = this.editor;
        this.editor = null;
        if (!editor || cancel || editor.profileId !== this.profileId) return;
        const value = entryNumber(editor.text);
        const edit = editor.kind === 'quest' ? {kind:'quest',chapter:value,episode:entryNumber(editor.episode)} :
          editor.kind === 'rank' ? {kind:'rank',characterId:editor.characterId,value} : {kind:editor.kind,value};
        this.save(edit);
      },
      finishEditor({cancel=false,advance=0,focus=false}={}) {
        const anchor = this.editor?.anchor;
        this.commitEditor(cancel);
        this.$refs.progressEditor?.hide();
        if (!anchor || (!focus && !advance)) return;
        const chips = [...this.$el.querySelectorAll('[data-progress-rank-chip]')];
        const index = chips.indexOf(anchor);
        const target = advance && index >= 0 ? chips[index+advance] ?? anchor : anchor;
        this.$nextTick(() => target.focus());
      },
      editorKeys(event) {
        if (!this.editor) return;
        const rank = this.editor.kind === 'rank';
        if (event.key === 'Escape' || event.key === 'Enter' || (rank && event.key === 'Tab')) {
          event.preventDefault();
          event.stopPropagation();
          const cancel = event.key === 'Escape';
          this.finishEditor({cancel,focus:true,advance:rank && !cancel ? (event.shiftKey && event.key === 'Tab' ? -1 : 1) : 0});
        }
      },
      commitRank(characterId,value) {
        delete this.sliderDrafts[characterId];
        this.save({kind:'rank',characterId,value});
      },
      toggleMember(event,characterId) {
        event.preventDefault();
        this.save({kind:'toggle-member',characterId});
      },
    },
    render() {
      const tabs=[['overview','Overview'],['board','Holomem Board']];
      const header=[
        h('header',{class:headingClass},[h('h1',{class:titleClass},'Progress')]),
        h('div',{class:'holo-progress-tabs','aria-label':'Progress views',role:'group'},tabs.map(([id,label])=>
          h('button',{key:id,type:'button','aria-pressed':this.section===id,onClick:()=>this.selectSection(id),
            class:'holo-progress-tab flex items-center justify-center text-sm font-semibold h-8 rounded focus:ring '+
              (this.section===id?'bg-gray-900':'bg-gray-800 hover:bg-gray-700 text-gray-300'),
          },[id==='board'?h('img',{src:'/assets/boards/ui_999_ico_potential.webp',alt:''}):null,label]),
        )),
      ];
      if(this.section==='board')return h('section',{class:'holo-progress','aria-label':'Progress'},[
        ...header,vnode(Board,{key:this.profileId,snapshot:this.profile?.gameAccountImport?.snapshot,inventory:this.profile?.inventory}),
      ]);
      const account = this.progressAccount, story = account.storyProgress;
      const limits = accountProgressLimits(account);
      const memoryBonus = accountProgressMemoryBonus(account);
      const bonus = (label,title,percent) => h('span',{
        class:'holo-progress-bonus rounded-full',title,'aria-label':`${title} ${percent}`,
      },`${label} ${percent}`);
      const Check = resolve('check-icon');
      const editor = this.editor;
      const chip = (caption,details) => h('button',{
        type:'button',class:'holo-progress-chip rounded-full bg-gray-700 hover:bg-gray-600 font-semibold',
        'aria-label':`${details.label}, currently ${details.kind === 'quest' ? `Chapter ${details.value} Episode ${details.episode}` : details.value}`,
        'aria-haspopup':'dialog',
        'aria-expanded':!!editor && editor.kind === details.kind && editor.characterId === details.characterId,
        ...(details.kind === 'rank' ? {'data-progress-rank-chip':details.characterId} : {}),
        onClick:event => this.editChip(event,details),
        onKeydown:event => {
          if (!event.altKey && !event.ctrlKey && !event.metaKey && /^\d$/.test(event.key)) {
            event.preventDefault();
            this.editChip(event,details,event.key);
          }
        },
      },caption);
      const tile = member => {
        const rank = accountProgressRank(account,member.id,this.importedRanks.get(member.id));
        const level = this.sliderDrafts[member.id] ?? rank.level;
        const unlocked = this.unlocked.has(member.id);
        const step = (label,delta,disabled,text) => h('button',{
          type:'button',tabindex:-1,class:'holo-progress-step rounded bg-gray-700 hover:bg-gray-600 font-semibold',
          'aria-label':`${label} ${member.name} member rank`,disabled,
          onClick:() => this.commitRank(member.id,level+delta),
        },text);
        return h('article',{
          key:member.id,class:`holo-progress-tile bg-gradient-to-br from-gray-700 to-gray-800 rounded-md${unlocked ? '' : ' holo-progress-locked'}`,
          'data-member-id':member.id,'data-member-unlocked':unlocked,role:'group',
          'aria-label':`${member.name}, ${unlocked ? 'unlocked' : 'locked'}`,'aria-keyshortcuts':'Shift+F10',
          title:`Right-click to ${unlocked ? 'lock' : 'unlock'} ${member.name}`,
          onContextmenu:event => this.toggleMember(event,member.id),
          onKeydown:event => {
            if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) this.toggleMember(event,member.id);
          },
        },[
          h('h3',{class:'holo-progress-name font-semibold'},member.name),
          h('img',{class:'holo-progress-portrait',src:`/assets/members/${member.assetId}.webp`,
            width:40,height:40,alt:'',loading:'lazy',decoding:'async'}),
          chip(`Rank ${level}`,{kind:'rank',characterId:member.id,label:`Set ${member.name} member rank`,
            inputLabel:`${member.name} rank`,value:level,min:rank.min,max:rank.max}),
          h('div',{class:'holo-progress-slider'},[
            step('Decrease',-1,level<=rank.min,'−'),
            h('input',{type:'range',class:'progress-range','data-v-b2dcd9af':'',tabindex:-1,
              'aria-label':`${member.name} member rank slider`,min:1,max:rank.max,step:1,value:level,'aria-valuemin':rank.min,
              style:{'--fill':`${rank.max>1 ? (level-1)/(rank.max-1)*100 : 100}%`},
              onInput:event => {
                const value = Math.max(rank.min,Number(event.target.value));
                event.target.value = value;
                this.sliderDrafts[member.id] = value;
              },
              onChange:event => this.commitRank(member.id,Number(event.target.value)),
              onBlur:() => { delete this.sliderDrafts[member.id]; },
              onPointercancel:() => { delete this.sliderDrafts[member.id]; },
            }),
            step('Increase',1,level>=rank.max,'+'),
          ]),
        ]);
      };
      const editField = (label,value,change,primary=false) => h('label',{class:'holo-progress-field'},[
        h('span',{class:'text-xs font-semibold text-gray-300'},label),
        h('input',{ref:primary?'progressInput':undefined,type:'text',inputmode:'numeric',
          class:'bg-gray-700 border-none rounded-md',value,onInput:event => change(event.target.value)}),
      ]);
      return h('section',{class:'holo-progress','aria-label':'Progress'},[
        ...header,
        h('div',{class:'holo-progress-account','aria-label':'Account progress'},[
          chip(story.episode===0?'Main Quest · No clears':`Main Quest · Ch. ${story.chapter} · Ep. ${story.episode}`,
            {kind:'quest',label:'Set Main Quest progress',value:story.chapter,episode:story.episode}),
          chip(`Dream Rank ${account.playerLevel}`,
            {kind:'dream-rank',label:'Set Dream Rank',inputLabel:'Dream Rank',value:account.playerLevel,min:1,max:limits.dreamRank}),
          chip(`${account.memoriesCollected} ${account.memoriesCollected === 1 ? 'Memory' : 'Memories'}`,
            {kind:'memories',label:'Set Memories Collected',inputLabel:'Memories Collected',value:account.memoriesCollected,min:0,max:limits.memories}),
          memoryBonus===undefined?null:bonus('Memory','Unit parameter bonus from Memories',`+${formatNumber(memoryBonus/10,{minimumFractionDigits:1,maximumFractionDigits:1})}%`),
          account.upgradeBonusPermyriad===undefined?null:bonus('Upgrade','Upgrade Bonus',`+${formatNumber(account.upgradeBonusPermyriad/100,{minimumFractionDigits:2,maximumFractionDigits:2})}%`),
        ]),
        vnode(Search,{label:'Search members',search:this.search,'onUpdate:search':value=>{this.search=value;}}),
        h('div',{class:'holo-progress-roster'},this.visibleBranches.length ? this.visibleBranches.map(branch => h('section',{
          key:branch.id,'aria-label':branch.name,class:'holo-progress-branch',
        },[
          h('h2',{class:'holo-progress-branch-title font-semibold'},branch.name),
          h('div',{class:'holo-progress-grid'},branch.members.map(tile)),
        ])) : [h('p',{class:'text-gray-400'},'No members found')]),
        vnode(OverlayPanel,{ref:'progressEditor',class:'holo-progress-popover','aria-label':editor?.label,
          onShow:() => this.$nextTick(this.focusEditor),onHide:() => this.commitEditor()},{default:() => editor ? [
          h('div',{class:'holo-progress-edit-fields',onKeydownCapture:this.editorKeys},[
            ...(editor.kind === 'quest' ? [
              editField('Chapter',editor.text,value=>{editor.text=value;},true),
              editField('Episode',editor.episode,value=>{editor.episode=value;}),
            ] : [editField(editor.inputLabel,editor.text,value=>{editor.text=value;},true)]),
            h('button',{type:'button',class:'holo-progress-confirm rounded bg-gray-700 hover:bg-gray-600',
              'aria-label':`Confirm ${editor.inputLabel ?? 'Main Quest progress'}`,onClick:() => this.finishEditor({focus:true})},[
              vnode(Check,{class:'w-4 h-4','aria-hidden':'true'}),
            ]),
            h('span',{class:'sr-only'},editor.kind === 'quest' ? `Chapter 1 to ${limits.chapters}. Up to episode ${limits.episodes(Number(editor.text))}.` :
              `Enter a number from ${editor.min} to ${editor.max}.`),
          ]),
        ] : []}),
      ]);
    },
  };
}
