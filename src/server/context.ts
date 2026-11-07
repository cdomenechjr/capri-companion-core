import {RecordData} from '../shared';
const stopWords=new Set('a about an and are as at be been being but by can could did do does for from had has have he her him his how i if in into is it its me my of on or our please s she should so t than that the their them there these they this those to us was we were what when where which who why will with would you your'.split(' '));
function tokens(value:unknown):string[]{return typeof value==='string'?value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)||[]:[];}
function timestamp(value:unknown){const time=typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(time)?time:0;}

export function relevant(records:RecordData[],query:string,limit=20){
 // Search content only: IDs, provenance and arbitrary metadata are not memories.
 const count=Number.isFinite(limit)?Math.min(100,Math.max(0,Math.trunc(limit))):0;
 const queryTokens=tokens(query);const words=[...new Set(queryTokens.filter(word=>!stopWords.has(word)))];
 if(!count||!words.length)return [];
 const phrase=' '+queryTokens.join(' ')+' ';
 return records.map((row,index)=>{
  const fields=[row.text,row.title,row.project,row.category].map(value=>new Set(tokens(value)));
  const weights=[3,3,2,1];let matches=0,score=0;
  for(const word of words){
   const weight=Math.max(0,...fields.map((field,i)=>field.has(word)?weights[i]:0));
   if(weight){matches++;score+=weight;}
  }
  const project=tokens(row.project);
  // A complete project name in the request outranks a partial name or a mention in prose.
  const projectMatch=matches&&project.some(word=>!stopWords.has(word))&&phrase.includes(' '+project.join(' ')+' ')?project.length:0;
  return {row,index,matches,score,projectMatch,confirmed:row.confirmed===true?1:0,updatedAt:timestamp(row.updatedAt)};
 }).filter(result=>result.matches>0)
  .sort((a,b)=>b.projectMatch-a.projectMatch||b.matches-a.matches||b.score-a.score||b.confirmed-a.confirmed||b.updatedAt-a.updatedAt||a.index-b.index)
  .slice(0,count).map(result=>result.row);
}
export function projectSuggestion(memories:RecordData[],plans:RecordData[],previous:string[]=[]){
 const active=plans.filter(p=>!p.done);const interests=memories.filter(m=>/like|love|interest|learn|enjoy|project|game|build/i.test(m.text||''));
 const choices=[...active.map(p=>'Got an angle for “'+String(p.title).slice(0,120)+'”: we could make a small prototype and test the interesting part first.'),...interests.map(m=>'Project idea from something you mentioned: '+String(m.text).slice(0,160)+'. Want to turn that into something we can build?')];
 return choices.find(x=>!previous.includes(x));
}
