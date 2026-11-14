import {achievementRewardFamilies} from './achievements';

const sections = [
  {kind:'emblem',label:'Individual emblems',keywords:'emblems cosmetics'},
  {kind:'outfit',label:'Individual Park Outfits',keywords:'outfits cosmetics'},
  {kind:'item',label:'Items, currency and EXP'},
];

export function createAchievementRewardFilter({h,vnode,resolve,OverlayPanel}) {
  return {
    name:'AchievementRewardFilter',
    props:{options:Array,images:Object,selected:Array},
    emits:['update:selected'],
    data() { return {query:'',open:false,expanded:new Set()}; },
    computed:{
      terms() { return this.query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean); },
      selectedIds() { return new Set(this.selected); },
      filteredOptions() {
        return sections.map(section => ({
          ...section,
          options:this.options.filter(option => option.kind === section.kind &&
            this.matches(`${option.label} ${section.keywords || ''}`)),
        })).filter(section => section.options.length);
      },
    },
    methods:{
      matches(value) {
        const label = value.toLocaleLowerCase();
        return this.terms.every(term => label.includes(term));
      },
      toggle(id) {
        this.$emit('update:selected',this.selectedIds.has(id) ?
          this.selected.filter(value => value !== id) : [...this.selected,id]);
      },
      toggleSection(kind) {
        if (this.expanded.has(kind)) this.expanded.delete(kind);
        else this.expanded.add(kind);
      },
      show() {
        this.open = true;
        this.$nextTick(() => this.$refs.query?.focus());
      },
      hide() {
        this.open = false;
        this.query = '';
      },
    },
    render() {
      const Chevron = resolve('chevron-down-icon');
      const panelId = `holo-achievement-rewards-${this.$.uid}`;
      const families = achievementRewardFamilies.filter(family => this.matches(family.label));
      const choice = option => h('button',{
        key:option.id,type:'button',class:'holo-reward-choice rounded text-left hover:bg-gray-600',
        'aria-pressed':this.selectedIds.has(option.id),'data-reward-option':option.id,
        onClick:() => this.toggle(option.id),
      },[
        this.images[option.id] ? h('img',{src:this.images[option.id],alt:'',width:22,height:22,loading:'lazy',decoding:'async'}) : null,
        h('span',{},option.label),
      ]);
      const list = section => h('section',{key:section.kind,class:'holo-reward-section','data-reward-kind':section.kind},[
        section.kind === 'item' || this.terms.length ?
          h('h3',{class:'text-xs font-semibold text-gray-300'},section.label) :
          h('button',{type:'button',class:'holo-reward-section-toggle rounded hover:bg-gray-600',
            'aria-expanded':this.expanded.has(section.kind),'aria-controls':`${panelId}-${section.kind}`,onClick:() => this.toggleSection(section.kind)},[
            section.label,vnode(Chevron,{class:`w-4 ${this.expanded.has(section.kind) ? 'rotate-180' : ''}`,'aria-hidden':'true'}),
          ]),
        h('div',{id:`${panelId}-${section.kind}`,class:'holo-reward-options'},section.kind === 'item' || this.terms.length || this.expanded.has(section.kind) ?
          section.options.map(choice) : null),
      ]);
      return h('div',{class:'holo-reward-filter'},[
        h('button',{
          type:'button',class:`holo-reward-filter-trigger bg-gray-700 rounded-md hover:bg-gray-600 font-semibold${this.selected.length ? ' ring ring-purple-500/50' : ''}`,
          'aria-expanded':this.open,'aria-controls':panelId,'aria-haspopup':'dialog',
          onClick:event => this.$refs.panel.toggle(event),
        },[
          this.selected.length ? `Rewards (${this.selected.length})` : 'Rewards',
          vnode(Chevron,{class:'w-4 shrink-0','aria-hidden':'true'}),
        ]),
        vnode(OverlayPanel,{ref:'panel',id:panelId,class:'holo-reward-popover','aria-label':'Achievement reward filters',
          onShow:this.show,onHide:this.hide},{default:() => [
          h('div',{class:'holo-reward-popover-toolbar'},[
            h('input',{ref:'query',type:'search',placeholder:'Find rewards',value:this.query,'aria-label':'Find rewards',
              class:'bg-gray-700 border-none rounded-md min-w-0',onInput:event => {this.query=event.target.value;}}),
            this.selected.length ? h('button',{type:'button',class:'rounded px-2 hover:bg-gray-600 text-sm',onClick:() => this.$emit('update:selected',[])},'Clear') : null,
          ]),
          h('div',{class:'holo-reward-popover-list'},[
            families.length ? h('div',{class:'holo-reward-families'},families.map(choice)) : null,
            ...this.filteredOptions.map(list),
            !families.length && !this.filteredOptions.length ? h('p',{class:'text-sm text-gray-400 py-2'},'No matching rewards.') : null,
          ]),
        ]}),
      ]);
    },
  };
}
