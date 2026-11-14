export const numberFormats = [
  ['system','System default'], ['en-US','English (United States)'], ['en-GB','English (United Kingdom)'],
  ['de-DE','German (Germany)'], ['fr-FR','French (France)'], ['en-IN','English (India)'],
  ['ja-JP','Japanese (Japan)'], ['none','No grouping'],
];
export const dateFormats = [
  ['system','System default'], ['en-US','Month/day/year'], ['en-GB','Day/month/year'],
  ['de-DE','Day.month.year'], ['iso','Year-month-day'],
];
export const validNumberFormat = value => numberFormats.some(([id])=>id===value)?value:'system';
export const validDateFormat = value => dateFormats.some(([id])=>id===value)?value:'system';

let initial = {};
export function initializeRegionalFormats(settings) {initial=settings;}
const settings = () => globalThis.window?.__seelieApp?.settings??initial;
const numbers = new Map(), dates = new Map();
function numberFormatter(format,options={}) {
  const key=JSON.stringify([format,options]);
  if(!numbers.has(key))numbers.set(key,new Intl.NumberFormat(
    format==='system'||format==='none'?undefined:format,
    {numberingSystem:'latn',useGrouping:format!=='none',...options},
  ));
  return numbers.get(key);
}
export function formatNumber(value,options,format=settings().number_format??'system') {
  return numberFormatter(format,options).format(value);
}
export function numberParts(value,options) {
  return numberFormatter(settings().number_format??'system',options).formatToParts(value);
}

const numberPatterns=new Map();
const escapeRegex=text=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function numberPattern(format) {
  if(numberPatterns.has(format))return numberPatterns.get(format);
  // Allow the locale's grouped form and ordinary ungrouped digits. Derive
  // widths from Intl so Indian grouping and narrow-space grouping round trip.
  const parts=numberFormatter(format==='none'?'system':format).formatToParts(1234567890123.5);
  const groups=parts.filter(part=>part.type==='integer').map(part=>part.value.length);
  const group=parts.find(part=>part.type==='group')?.value;
  const decimal=parts.find(part=>part.type==='decimal').value;
  const separator=group&&/\s/.test(group)?'[ \\u00a0\\u202f]':group&&escapeRegex(group);
  const last=groups.at(-1), middle=groups.at(-2)??last;
  const grouped=separator?`|\\d{1,${middle}}(?:${separator}\\d{${middle}})*${separator}\\d{${last}}`:'';
  const pattern=new RegExp(`^[+-]?(?:\\d+${grouped})(?:${escapeRegex(decimal)}\\d+)?$`);
  const result={pattern,group,decimal};
  numberPatterns.set(format,result);
  return result;
}
export function parseNumber(text,format=settings().number_format??'system') {
  const value=String(text).trim().replaceAll('−','-');
  const {pattern,group,decimal}=numberPattern(format);
  const [mantissa,exponent,...extra]=value.toLowerCase().split('e');
  if(extra.length||!pattern.test(mantissa)||(exponent!==undefined&&!/^[+-]?\d+$/.test(exponent)))return NaN;
  const plain=group&&/\s/.test(group)?mantissa.replace(/[ \u00a0\u202f]/g,''):group?mantissa.replaceAll(group,''):mantissa;
  return Number(plain.replace(decimal,'.')+(exponent===undefined?'':'e'+exponent));
}

function dateFormatter(format,options) {
  const key=JSON.stringify([format,options]);
  if(!dates.has(key))dates.set(key,new Intl.DateTimeFormat(
    format==='system'?undefined:format==='iso'?'en-CA':format,options));
  return dates.get(key);
}
export function formatDate(value,{time=false,format=settings().date_format??'system'}={}) {
  const date=new Date(value);
  if(!Number.isFinite(date.getTime()))return '';
  let label;
  if(format==='iso'){
    const parts=Object.fromEntries(dateFormatter('iso',{year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date)
      .map(({type,value})=>[type,value]));
    label=`${parts.year}-${parts.month}-${parts.day}`;
  }else{
    label=dateFormatter(format,{year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
  }
  if(!time)return label;
  const hourCycle=Number(settings().hour_format)===12?'h12':'h23';
  return label+' · '+dateFormatter(format,{hour:'2-digit',minute:'2-digit',hourCycle}).format(date);
}
export const formatDateTime = value => formatDate(value,{time:true});
