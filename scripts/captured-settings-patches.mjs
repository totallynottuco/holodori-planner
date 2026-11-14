import {simple} from 'acorn-walk';

/** Settings stays Tm/y3: source geometry, controls, dialogs and preference setters.
 * These edits only name/lock the existing profile actions and bind the draft. */
export function capturedSettingsPatches(source,ast) {
  const changes=[],bindings=new Map(),functions=new Map();
  const text=node=>source.slice(node.start,node.end);
  const key=node=>node?.key?.name??node?.key?.value;
  const prop=(object,name)=>object?.properties?.find(node=>key(node)===name);
  const patch=(node,value,reason)=>changes.push({start:node.start,end:node.end,value,reason});
  const insert=(at,value,reason)=>changes.push({start:at,end:at,value,reason});
  simple(ast,{VariableDeclarator(node){if(node.id.type==='Identifier')bindings.set(node.id.name,node.init);},FunctionDeclaration(node){functions.set(node.id.name,node);}});
  const options=bindings.get('zm');
  patch(options,`configureSettings(${text(options)})`,'Retain captured Settings controller with profile-safe draft handling');
  const sidebar=prop(prop(bindings.get('_n'),'methods').value,'setAccount').value;
  insert(sidebar.body.start+1,'if(!window.__holodoriDesktop.prepareProfileSwitch())return;','Flush original debounced edits before the captured sidebar changes profile');
  simple(functions.get('Tm').body,{
    Literal(node){if(node.value==='delete_confirmation')patch(node,'"delete_profile_confirmation"','Profile-specific confirmation copy without changing other delete dialogs');},
    CallExpression(node){
      const props=node.arguments[1];
      if(props?.type!=='ObjectExpression')return;
      if(node.callee.name==='i'&&node.arguments[0]?.value==='input'&&prop(props,'onInput')&&text(prop(props,'onInput').value).includes('r.nameChanged')) {
        patch(prop(props,'value').value,'a.newName','Bind the actual original rename input to the current draft');
        insert(props.start+1,'"aria-label":"Profile name",','Name the original rename input');
      }
      if(node.callee.name==='g'&&node.arguments[0]?.name==='u') {
        const visible=prop(props,'visible');
        if(visible&&['a.renameModal','a.deleteModal'].includes(text(visible.value))) {
          insert(props.start+1,`"aria-label":${JSON.stringify(text(visible.value)==='a.renameModal'?'Rename profile':'Delete profile')},closeOnEscape:!r.profileLocked,`,'Name the original headerless profile dialog');
          const mask=prop(props,'dismissable-mask');if(mask)patch(mask.value,'!r.profileLocked','Keep profile confirmation mounted while native work completes');
          if(node.arguments[4]?.type==='ArrayExpression')insert(node.arguments[4].start+1,'"closeOnEscape","dismissable-mask",','Track original profile dialog interaction locks');
          if(text(visible.value)==='a.deleteModal'){
            const slot=prop(node.arguments[2],'default')?.value?.arguments?.[0]?.body;
            if(slot?.type==='ArrayExpression')insert(slot.elements[0].end,',r.profileActionError?(o(),l("p",{class:"mt-2 text-red-400 font-semibold leading-tight",role:"alert"},_(r.profileActionError),1)):C("",true)','Keep native deletion errors inside the captured confirmation');
          }
        }
      }
      if(node.callee.name==='i'&&node.arguments[0]?.value==='select'&&prop(props,'onChange')&&text(prop(props,'onChange').value).includes('r.setAccount')) {
        insert(props.start+1,'"aria-label":"Profile",disabled:r.profileLocked,','Name and lock the captured profile selector during a native transaction');
        insert(bindings.get('A3').start+1,'"disabled",','Refresh original selector disabled state');
      }
      if(node.callee.name==='i'&&node.arguments[0]?.value==='button') {
        const click=prop(props,'onClick');if(!click)return;
        const handler=text(click.value);
        const label=handler.includes('r.addAccount')?'Add profile':handler.includes('a.renameModal = !0')?'Rename profile':handler.includes('a.deleteModal = !0')?'Delete profile':null;
        const profileAction=label||handler.includes('r.download')||handler.includes('r.clickUpload')||handler.includes('e.deleteAccount')||handler.includes('a.deleteModal = !1');
        if(!profileAction)return;
        if(label)insert(props.start+1,`"aria-label":${JSON.stringify(label)},`,'Name the original icon profile action at narrow widths');
        const disabled=prop(props,'disabled');
        if(disabled)patch(disabled.value,'(e.account==="main"||r.profileLocked)','Keep Main protected while locking native profile operations');
        else {
          insert(props.start+1,'disabled:r.profileLocked,','Lock captured profile actions during native operations');
          if(node.arguments[3]?.type==='Literal')patch(node.arguments[3],String(node.arguments[3].value|8),'Track the original profile button disabled property');
          else if(node.arguments.length===3)insert(node.arguments.at(-1).end,',8,["disabled"]','Track disabled state on original profile buttons');
          if(node.arguments[4]?.type==='ArrayExpression')insert(node.arguments[4].start+1,'"disabled",','Track original profile action disabled state');
          else if(node.arguments.length===4)insert(node.arguments.at(-1).end,',["disabled"]','Track original profile action disabled state');
        }
      }
    }
  });
  return {changes,imports:'import {configureSettings} from "/captured/settings.js";\n'};
}
