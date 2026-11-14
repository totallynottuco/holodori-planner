import {formatNumber} from './regional-formats.js';
import {achievementProgress,indexAchievementProgress,loadAchievementCatalog} from './achievements';
import {createAchievementRewardFilter} from './achievement-reward-filter';
import {accountCharactersById,memberLevelProgression} from '../hololive/vendor/shared/account-data';

const amount = value => value == null ? '—' : formatNumber(BigInt(value));
const art = icon => `/assets/achievements/groups/${icon}.webp`;
const uiArt = icon => `/assets/achievements/ui/${icon}.webp`;
const portrait = memberId => `/assets/achievements/portraits/img_chr_icon_normal_${memberId.slice(4)}.webp`;
const categoryArt = [portrait('chr-00018'),...['live','chase','w1-a01','card','login'].map(icon => art('img_achieve_icon_'+icon))];
const groupArt = group => group.memberId ? portrait(group.memberId) : art(group.icon);
const tierLabels = {received:'Received',claimable:'Ready in game',incomplete:'Incomplete',unknown:'Unknown'};
const formatObjective = (text,target) => text.replaceAll('{0}',amount(target)).replace(/<[^>]+>/g,'');

function memberRank(member) {
  if (!member) return null;
  const rank = member.level;
  if (!accountCharactersById.has(member.characterId)) return {rank};
  const levels = memberLevelProgression(member.characterId);
  const current = levels[rank - 1], next = levels[rank];
  if (!current || !next) return {rank,maxed:!!current && rank === levels.length};
  const needed = next.experience - current.experience;
  const earned = Number(member.exp) - current.experience;
  if (earned < 0 || earned >= needed || !Number.isSafeInteger(earned)) return {rank};
  return {rank,earned,needed};
}

function groupProgress(group,index) {
  let done = index === null ? null : 0, total = 0, ready = 0;
  const missions = group.missions.map(mission => {
    const {progress,tiers} = achievementProgress(mission,index);
    const received = tiers.filter(tier => tier.status === 'received').length;
    const pending = tiers.filter(tier => tier.status === 'claimable').length;
    const target = tiers.findLast(tier => tier.status === 'claimable') ??
      tiers.find(tier => tier.status === 'incomplete' || tier.status === 'unknown') ?? tiers.at(-1);
    if (done !== null) done += received + pending;
    total += tiers.length;
    ready += pending;
    return {...mission,progress,tiers,target,pending,finished:received === tiers.length};
  });
  return {...group,missions,done,total,ready};
}

function summarize(items) {
  return {
    done:items.some(item => item.done === null) ? null : items.reduce((sum,item) => sum + item.done,0),
    total:items.reduce((sum,item) => sum + item.total,0),
  };
}

function missionObjective(mission) {
  const hidden = !!mission.unstartedTitle && (mission.progress === null || mission.progress === '0');
  const target = mission.target?.target;
  return {
    title:formatObjective(hidden ? mission.unstartedTitle : mission.title || mission.description,target),
    description:hidden || !mission.title ? '' : formatObjective(mission.description,target),
  };
}

function matchRewardTiers(mission,ids,hideCompleted) {
  const tiers = mission.tiers.filter(tier => (!hideCompleted || tier.status !== 'received') &&
    tier.rewards.some(reward => ids.has(reward.id)));
  if (!tiers.length) return null;
  const pending = tiers.findLast(tier => tier.status === 'claimable');
  const target = pending ?? tiers.find(tier => tier.status !== 'received') ?? tiers.at(-1);
  return {...mission,tiers,target,pending:!!pending,finished:tiers.every(tier => tier.status === 'received'),
    previewRewards:target.rewards.filter(reward => ids.has(reward.id))};
}

export function createAchievements({h,vnode,resolve,Search,Toggle,Rail,Row,OverlayPanel,headingClass,titleClass}) {
  const RewardFilter = createAchievementRewardFilter({h,vnode,resolve,OverlayPanel});
  return {
    name:'HolodoriAchievements',
    props:{account:String},
    data() {
      return {catalog:null,error:false,category:0,allCategories:false,search:'',hideCompleted:false,
        rewardSelection:[],openGroups:new Set(),openMissions:new Set()};
    },
    computed:{
      snapshot() {
        return window.__seelieApp?.data?.[`${this.account || 'main'}-holodori`]?.gameAccountImport?.snapshot;
      },
      categories() {
        const index = indexAchievementProgress(this.snapshot?.tables.missions);
        return (this.catalog?.categories ?? []).map(category => {
          const groups = category.groups.map(group => groupProgress(group,index));
          return {...category,groups,...summarize(groups)};
        });
      },
      members() {
        return new Map(this.snapshot?.tables.members?.map(member => [member.characterId,member]));
      },
      selectedRewardIds() {
        const selected = new Set(this.rewardSelection);
        return new Set((this.catalog?.rewards ?? []).filter(option => selected.has(option.id) ||
          option.families.some(family => selected.has(family))).map(option => option.id));
      },
      visibleCategories() {
        const query = this.search.trim().toLocaleLowerCase();
        const rewardIds = this.selectedRewardIds;
        const categories = this.allCategories ? this.categories : this.categories.slice(this.category,this.category + 1);
        return categories.flatMap(category => {
          const groups = category.groups.flatMap(group => {
            const nameMatches = `${group.name} ${group.memberName}`.toLocaleLowerCase().includes(query);
            const missions = group.missions.flatMap(mission => {
              const row = rewardIds.size ? matchRewardTiers(mission,rewardIds,this.hideCompleted) :
                this.hideCompleted && mission.finished ? null : mission;
              if (!row) return [];
              const objective = missionObjective(row);
              return nameMatches || `${objective.title} ${objective.description}`.toLocaleLowerCase().includes(query) ?
                [{...row,...objective}] : [];
            });
            return missions.length ? [{...group,missions}] : [];
          });
          return groups.length ? [{...category,groups}] : [];
        });
      },
    },
    watch:{
      account() {
        this.search = '';
        this.hideCompleted = false;
        this.rewardSelection = [];
        this.allCategories = false;
        this.openGroups.clear();
        this.openMissions.clear();
      },
    },
    mounted() { this.load(); },
    methods:{
      async load() {
        this.error = false;
        try { this.catalog = await loadAchievementCatalog(); }
        catch { this.error = true; }
      },
      selectCategory(index) {
        this.allCategories = index === null;
        if (index !== null) this.category = index;
        document.getElementById('main')?.scrollTo({top:0});
      },
      setRewardSelection(selection) {
        if (!this.rewardSelection.length && selection.length) this.allCategories = true;
        if (!selection.length) this.allCategories = false;
        this.rewardSelection = selection;
      },
      toggle(set,id) {
        if (set.has(id)) set.delete(id);
        else set.add(id);
      },
    },
    render() {
      const Chevron = resolve('chevron-right-icon');
      const total = summarize(this.categories);
      const count = item => `${amount(item.done)} / ${amount(item.total)}`;
      const picture = (src,size,extra={}) => h('img',{src,width:size,height:size,alt:'',decoding:'async',loading:'lazy',...extra});
      const arrow = open => vnode(Chevron,{class:`h-4 w-4 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`,'aria-hidden':'true'});
      const medal = group => h('span',{class:`holo-achievement-medal ${group.memberId ? 'is-member' : ''}`,'aria-hidden':'true'},[
        picture(uiArt('ui_1000_achievement_medal_base'),40,{class:'holo-medal-base'}),
        picture(groupArt(group),40,{class:'holo-medal-icon'}),
        picture(uiArt('ui_1000_achievement_medal_light'),40,{class:'holo-medal-light'}),
      ]);
      const rewardList = rewards => h('span',{class:'holo-achievement-rewards'},rewards.map(reward => {
        const image = this.catalog.rewardImages[reward.id];
        return h('span',{class:'holo-achievement-reward',key:reward.id},[
          image ? picture(image,18) : null,
          `${amount(reward.quantity)} × ${reward.label}`,
        ]);
      }));
      const rankLine = member => {
        const rank = memberRank(member);
        if (!rank) return null;
        return h('span',{class:'holo-achievement-rank'},[
          h('span',{class:'flex items-center justify-between gap-2'},[
            h('span',{class:'flex items-center gap-1'},[picture(uiArt('ui_999_ico_crown'),12,{class:'holo-achievement-crown'}),'Holomem Rank ',h('strong',{},amount(rank.rank))]),
            rank.needed ? h('span',{class:'tabular-nums'},`${amount(rank.earned)} / ${amount(rank.needed)}`) : rank.maxed ? 'Max' : null,
          ]),
          rank.needed ? h('span',{class:'holo-achievement-meter',role:'progressbar','aria-label':'Holomem Rank progress','aria-valuemin':0,'aria-valuemax':rank.needed,'aria-valuenow':rank.earned},[
            h('span',{style:{width:`${rank.earned * 100 / rank.needed}%`}}),
          ]) : null,
        ]);
      };
      const missionRow = mission => {
        const open = this.openMissions.has(mission.id);
        const bodyId = `holo-tier-${mission.id}`;
        const current = mission.target;
        const display = current && mission.progress !== null && BigInt(mission.progress) > BigInt(current.target) ? current.target : mission.progress;
        const contents = h('div',{class:'holo-achievement-mission','data-achievement-mission':mission.id},[
          h('button',{type:'button',class:'holo-achievement-mission-button','aria-expanded':open,'aria-controls':bodyId,onClick:()=>this.toggle(this.openMissions,mission.id)},[
            h('span',{class:'min-w-0'},[
              h('span',{class:'block font-semibold'},mission.title),
              mission.description && mission.description !== mission.title ? h('span',{class:'block text-sm text-gray-300'},mission.description) : null,
              current && !open ? rewardList(mission.previewRewards ?? current.rewards) : null,
            ]),
            h('span',{class:'holo-achievement-mission-progress'},[
              current ? h('span',{class:'tabular-nums'},`${amount(display)} / ${amount(current.target)}`) : null,
              mission.pending ? h('span',{class:'holo-achievement-claim'},tierLabels.claimable) : mission.finished ? h('span',{class:'holo-achievement-received'},'Received') : null,
            ]),
            arrow(open),
          ]),
          h('ul',{id:bodyId,hidden:!open,class:'holo-achievement-tiers','aria-label':'Achievement reward tiers'},open ? mission.tiers.map(tier => h('li',{key:tier.target,class:'holo-achievement-tier'},[
            h('span',{class:'font-semibold tabular-nums'},amount(tier.target)),
            rewardList(tier.rewards),
            h('span',{class:tier.status === 'claimable' ? 'holo-achievement-claim' : tier.status === 'received' ? 'holo-achievement-received' : 'text-gray-400'},tierLabels[tier.status]),
          ])) : null),
        ]);
        return vnode(Row,{key:mission.id,class:'holo-achievement-row',content:contents,complete:mission.finished});
      };
      const groupRow = group => {
        const open = this.openGroups.has(group.id);
        const bodyId = `holo-group-${group.id}`;
        const member = this.members.get(group.memberId);
        const locked = !member && !!this.snapshot && group.viewCondition === `cd-character_get-${group.memberId}`;
        return h('section',{key:group.id,'data-achievement-group':group.id,class:'holo-achievement-group'},[
          h('button',{type:'button',class:'holo-achievement-group-button bg-gradient-to-br from-gray-700 to-gray-800 hover:from-gray-600',
            'aria-expanded':open,'aria-controls':bodyId,onClick:()=>this.toggle(this.openGroups,group.id)},[
            medal(group),
            h('span',{class:'min-w-0'},[
              h('span',{class:'block font-semibold'},group.name),
              rankLine(member),
              locked ? h('span',{class:'block text-xs text-gray-400'},'Holomem locked') : null,
            ]),
            h('span',{class:'holo-achievement-earned tabular-nums'},[
              h('span',{class:'text-gray-400'},'Earned '),count(group),
              this.rewardSelection.length ? h('span',{class:'block text-gray-400'},`${amount(group.missions.length)} ${group.missions.length === 1 ? 'match' : 'matches'}`) :
                group.ready ? h('span',{class:'block holo-achievement-claim'},`${amount(group.ready)} ready in game`) : null,
            ]),
            arrow(open),
          ]),
          h('div',{id:bodyId,hidden:!open,class:'holo-achievement-missions'},open ? group.missions.map(missionRow) : null),
        ]);
      };
      const scope = this.allCategories ? 'All categories' : this.categories[this.category]?.name;
      const visibleGroups = this.visibleCategories.flatMap(category => [
        ...(this.allCategories ? [h('h2',{key:category.id,class:'holo-achievement-result-category text-sm font-semibold text-gray-300'},category.name)] : []),
        ...category.groups.map(groupRow),
      ]);

      return h('section',{class:'holo-achievements','aria-label':'Achievements'},[
        h('header',{class:headingClass},[
          h('h1',{class:titleClass},'Achievements'),
          this.catalog ? h('span',{class:'text-sm font-semibold tabular-nums','data-achievement-total':''},[`${count(total)} `,h('span',{class:'text-gray-400'},'completed')]) : null,
        ]),
        !this.catalog ? h('div',{class:'mt-4 text-gray-300',role:'status'},this.error ? [
          'The achievement catalog could not load. ',
          h('button',{type:'button',class:'rounded bg-gray-700 px-3 py-2 font-semibold hover:bg-gray-600',onClick:this.load},'Retry'),
        ] : 'Loading achievements…') : [
          this.snapshot?.tables.missions === undefined ? h('p',{class:'text-sm text-gray-400 mt-3'},[
            'Import game data in ',vnode(resolve('router-link'),{to:'/settings',class:'text-white underline'},()=> 'Settings'),' to see your progress.',
          ]) : null,
          h('div',{class:'holo-achievement-layout'},[
            h('nav',{class:'holo-achievement-rail','aria-label':'Achievement categories'},[
              ...(this.rewardSelection.length ? [vnode(Rail,{key:'all',isActive:this.allCategories,categoryName:'All categories',
                icon:art('img_achieve_icon_score'),onSelect:()=>this.selectCategory(null)})] : []),
              ...this.categories.map((category,index)=>vnode(Rail,{
                key:category.id,isActive:!this.allCategories && index===this.category,categoryName:category.name,icon:categoryArt[index],
                summary:category,onSelect:()=>this.selectCategory(index),
              })),
            ]),
            h('div',{class:'holo-achievement-content'},[
              h('div',{class:'holo-achievement-toolbar'},[
                vnode(Search,{class:'holo-achievement-search',search:this.search,'onUpdate:search':value=>{this.search=value;}}),
                vnode(RewardFilter,{options:this.catalog.rewards,images:this.catalog.rewardImages,selected:this.rewardSelection,'onUpdate:selected':this.setRewardSelection}),
                vnode(Toggle,{modelValue:this.hideCompleted,label:'Hide completed',disabled:total.done===null,'onUpdate:modelValue':value=>{this.hideCompleted=value;}}),
              ]),
              h('div',{class:'holo-achievement-groups','aria-label':`${scope} achievements`},visibleGroups.length ?
                visibleGroups : [h('p',{class:'rounded bg-gray-700 px-3 py-2 text-gray-300'},'No matching achievements.')]),
            ]),
          ]),
        ],
      ]);
    },
  };
}
