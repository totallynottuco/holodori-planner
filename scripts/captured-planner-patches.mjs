import { simple } from 'acorn-walk';

// Surgical edits to the captured application's actual Vue options/render AST.
// Ranges refer to the supplied unmodified readable bundle.
export function capturedPlannerPatches(source, ast) {
  const changes = [], bindings = new Map(), functions = new Map();
  const add = (start, end, value, reason) => changes.push({ start, end, value, reason });
  simple(ast, {
    VariableDeclarator(node) { if (node.id.type === 'Identifier') bindings.set(node.id.name, node.init); },
    FunctionDeclaration(node) { if (node.id) functions.set(node.id.name, node); },
  });
  const code = node => source.slice(node.start, node.end);
  const property = (object, key) => object?.properties?.find(item => (item.key.name ?? item.key.value) === key);
  for (const [name, factory] of [['wy', 'configureBoostOptions'], ['y9', 'configureBoostSettings']]) {
    const node = bindings.get(name);
    if (!node || node.type !== 'ObjectExpression') throw Error('Missing captured boost options ' + name);
    add(node.start, node.end, factory + '(' + code(node) + ')', 'Retain ' + name + ' options with Holodori boost controller');
  }
  const tracker = functions.get('Ly');
  if (!tracker) throw Error('Missing captured tracker Ly');
  simple(tracker.body, {
    CallExpression(node) {
      if (['i','l'].includes(node.callee.name) && node.arguments[0]?.value === 'div' && node.arguments[1]?.name === 'ky') {
        add(node.arguments[1].start, node.arguments[1].end,
          '{class:k(["py-2 px-2 rounded-md overflow-hidden relative",s.kind==="live"?"bg-pink-600/60":"bg-green-800/80"]),"aria-label":e.boostName}',
          'Two boost palettes on the original tracker container');
      }
      if (node.callee.name === 'i' && node.arguments[0]?.value === 'img' && node.arguments[1]?.type === 'ObjectExpression' && code(node.arguments[1]).includes('items/special_item/resin.png')) {
        add(node.start, node.end,
          'i("div",{class:"flex items-center gap-1"},[g(Mp,{class:"w-4 h-4 flex-shrink-0"}),i("span",{class:"text-xs font-semibold whitespace-nowrap"},e.boostName)])',
          'Replace game-specific resin artwork with captured neutral clock and correct boost name');
      }
      // Cy is the original online account/session energy importer.
      if (node.callee.name === 'g' && node.arguments[0]?.name === 'c') {
        add(node.start, node.end, 'C("",true)', 'Remove unsupported online energy import');
      }
      if (node.callee.name === 'g' && node.arguments[0]?.name === 'd' && node.arguments[1]?.type === 'ObjectExpression') {
        add(node.arguments[1].start + 1, node.arguments[1].start + 1, 'kind:s.kind,', 'Pass boost kind to original settings');
      }
      if (node.callee.name === 'i' && node.arguments[0]?.value === 'span' && node.arguments[1]?.name === 'jy') {
        add(node.arguments[1].start, node.arguments[1].end,
          '{class:k(["text-xs ml-1",s.kind==="live"?"text-pink-400":"text-green-300"])}',
          'Boost cap label uses matching original utility palette');
      }
      if (node.callee.name === 'i' && node.arguments[0]?.value === 'div' && node.arguments[1]?.name === 'zy') {
        add(node.start, node.end, 'C("",true)',
          'Omit boost estimate footer until verified activity costs exist');
      }
    },
    Literal(node) {
      if (node.value === 'mt-2 text-[0.82rem] leading-snug text-blue-200')
        add(node.start, node.end, '(s.kind==="live"?"mt-1 min-h-8 text-xs leading-snug flex flex-col gap-0.5 text-pink-400":"mt-1 min-h-8 text-xs leading-snug flex flex-col gap-0.5 text-green-300")', 'Preserve recovery rows with boost-specific text tint');
      if(node.value==='flex sm:items-center sm:flex-row')add(node.start,node.end,'"flex items-center"','Keep the compact tracker header on one aligned row');
      if(node.value==='text-lg font-bold cursor-pointer inline-block text-center w-9')add(node.start,node.end,'"text-base font-bold cursor-pointer inline-block text-center w-8"','Slim the original boost amount display');
      if(node.value==='bg-gray-600 text-lg rounded-md py-px px-0 w-9 text-center font-semibold focus:outline-none border-none')add(node.start,node.end,'"bg-gray-600 text-base rounded-md py-px px-0 w-8 text-center font-semibold focus:outline-none border-none"','Keep the original inline boost editor compact');
    },
    LogicalExpression(node){if(code(node)==='e.resinTime && "flex-col"')add(node.start,node.end,'false','Preserve the same compact header in every tracker state');},
    ObjectExpression(node){if(node.properties.some(item=>(item.key?.name??item.key?.value)==='columns-2'))add(node.start,node.end,'{}','Keep compact recovery details readable without narrow columns');},
    Property(node) {
      if ((node.key.name ?? node.key.value) === 'disabled' && code(node.value).includes('e.computedResin + 1 < m * -1'))
        add(node.value.start,node.value.end,'m < 0 ? e.computedResin < -m : e.computedResin >= e.resinCap','Discrete boost spending and cap checks on the original adjustment buttons');
    },
  });

  const settings = functions.get('cy');
  if (!settings) throw Error('Missing captured energy settings cy');
  simple(settings.body, {
    CallExpression(node) {
      if (node.callee.name !== 'i' || node.arguments[0]?.value !== 'div' || node.arguments[1]?.name !== 'v9') return;
      const sections = node.arguments[2]?.elements;
      if (!sections || sections.length !== 8) throw Error('Unexpected captured energy settings sections');
      // Keep actual adjustment/recovery controls, divider and Delete Tracker.
      // Remove unsupported notifications, badges and game premium refill costs.
      for (const index of [2, 3, 4, 5])
        add(sections[index].start, sections[index].end, 'C("",true)', 'Remove unsupported energy notification/refill section');
    },
    Property(node) {
      if ((node.key.name ?? node.key.value) === 'header' && code(node.value) === 'e.$t("settings")')
        add(node.value.start, node.value.end, 'e.boostName+" · "+e.$t("settings")', 'Name the correct boost settings dialog');
    },
  });

  const planner = functions.get('Mb');
  if (!planner) throw Error('Missing captured Planner Mb');
  let trackerCall = 0;
  simple(planner.body, {
    CallExpression(node) {
      if (node.callee.name === 'g' && node.arguments[0]?.name === 'u') {
        add(node.start, node.end,
          'g(u,{kind:"minigame",estimation:0,game:"holodori",class:"w-72 max-w-full"}),g(u,{kind:"live",estimation:0,game:"holodori",class:"w-72 max-w-full"})',
          'Render two instances of the original tracker component');
        trackerCall++;
      }
    },
  });
  if (trackerCall !== 1) throw Error('Missing unique captured Planner tracker call');
  const rowClass = property(bindings.get('nb'), 'class');
  if (!rowClass) throw Error('Missing captured Planner energy row');
  add(rowClass.value.start, rowClass.value.end, JSON.stringify('mt-4 flex items-start flex-wrap gap-2'), 'Keep both compact boost trackers adjacent');
  for(const [name,value]of [['$y','flex items-center h-7 ml-1'],['Sy','flex items-center flex-shrink-0 ml-2 rounded-md border-white text-[0.84rem] leading-none overflow-hidden'],['Ey','ml-auto flex items-center justify-center'],['My','w-full whitespace-nowrap'],['Ty','w-full whitespace-nowrap']]){
    const classes=property(bindings.get(name),'class');add(classes.value.start,classes.value.end,JSON.stringify(value),'Compact original boost layout '+name);
  }

  const tasks = functions.get('tb');
  simple(tasks.body, {
    CallExpression(node) {
      if (node.callee.name === 'i' && node.arguments[0]?.value === 'img' && node.arguments[1]?.type === 'ObjectExpression') {
        const src = property(node.arguments[1], 'src');
        if (src && code(src.value).includes('emote/sleep-'))
          add(src.value.start, src.value.end, JSON.stringify('/branding/logo.webp'), 'Replace sleeping game emote in the original image slot');
      }
    },
  });
  for (const reason of [
    'Two boost palettes on the original tracker container',
    'Replace game-specific resin artwork with captured neutral clock and correct boost name',
    'Pass boost kind to original settings',
    'Boost cap label uses matching original utility palette',
    'Omit boost estimate footer until verified activity costs exist',
    'Preserve recovery rows with boost-specific text tint',
    'Discrete boost spending and cap checks on the original adjustment buttons',
    'Name the correct boost settings dialog',
    'Replace sleeping game emote in the original image slot',
  ]) {
    if (changes.filter(change => change.reason === reason).length !== 1)
      throw Error('Missing or ambiguous captured Planner adaptation: ' + reason);
  }
  return {
    changes,
    imports: 'import {configureBoostOptions,configureBoostSettings} from "/captured/planner.js";\n',
    requirements: {
      accountDefault: 'boosts: {minigame:null,live:null,holoPassport:false}',
      settingsDefault: 'holodori_boosts: e.holodori_boosts || {}',
      deferredEvents: 'Root allEvents must return [] until Holodori schedules exist.',
    },
  };
}
