export const pickerActionClass='holo-team-action rounded bg-gray-700 hover:bg-gray-600 font-semibold';

export function renderPickerChoice(h,{value,media,arrow,label,onClick,disabled,expanded}){
  return h('button',{type:'button',class:pickerActionClass+' holo-team-choice',onClick,disabled,
    'aria-haspopup':'dialog','aria-label':label,'aria-expanded':expanded},[
    media,h('span',{class:'holo-team-choice-text',title:value},value),arrow,
  ]);
}

export function renderHolomemChoices(h,{members,portrait,onSelect,isSelected,emptyMessage}){
  if(!members.length)return h('p',{class:'text-xs text-gray-400'},emptyMessage);
  return h('div',{class:'holo-team-person-grid'},members.map(member=>
    h('button',{key:member.id,type:'button',class:pickerActionClass+' holo-team-person',
      'aria-pressed':isSelected(member.id),onClick:()=>onSelect(member.id)},[portrait(member),h('span',{},member.name)])));
}
