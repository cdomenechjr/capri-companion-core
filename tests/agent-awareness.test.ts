import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AgentActivityBadge, AgentActivityPanel} from '../src/ui/AgentActivity';
import {AGENT_HISTORY_LIMIT, agentAttention, emptyAgentActivity, reduceAgentActivity, routeAgentActivity, type AgentActivityState} from '../src/ui/agent-activity';

const base={id:'e1',agent:'codex',sessionId:'s',taskId:'memory-relevance',project:'Capri',kind:'working',summary:'Running tests',at:'2026-10-26T12:00:00.000Z'};
const msg=(event:Record<string,unknown>)=>({type:'agent_activity',event:{...base,...event}});
const feed=(...messages:unknown[])=>messages.reduce<AgentActivityState>((s,m)=>reduceAgentActivity(s,m),emptyAgentActivity);
const render=(state:AgentActivityState)=>renderToStaticMarkup(React.createElement(AgentActivityPanel,{state,formatTime:at=>'T'+at.slice(11,16)}));

test('duplicate event ids are ignored and history stays bounded',()=>{
  const once=feed(msg({}));const twice=reduceAgentActivity(once,msg({summary:'replayed with new text'}));
  assert.equal(twice,once);assert.equal(twice.history.length,1);assert.equal(twice.latest.codex?.summary,'Running tests');
  const many=feed(...Array.from({length:AGENT_HISTORY_LIMIT+10},(_,i)=>msg({id:'n'+i,at:new Date(Date.parse(base.at)+i*1000).toISOString()})));
  assert.equal(many.history.length,AGENT_HISTORY_LIMIT);assert.equal(many.history[0].id,'n'+(AGENT_HISTORY_LIMIT+9));
  assert.equal(reduceAgentActivity(many,msg({id:'n0'})),many,'ids evicted from history are still deduplicated');
});

test('latest activity is tracked separately per agent and late events do not regress it',()=>{
  const s=feed(msg({id:'c1',kind:'needs_input'}),msg({id:'a1',agent:'claude',kind:'completed',at:'2026-10-26T12:05:00.000Z'}),msg({id:'c0',kind:'started',at:'2026-10-26T11:00:00.000Z'}));
  assert.equal(s.latest.codex?.id,'c1');assert.equal(s.latest.claude?.id,'a1');assert.deepEqual(s.history.map(e=>e.id),['a1','c1','c0']);
  assert.equal(agentAttention(s)?.id,'c1');
  const html=render(s);assert.match(html,/Needs input/);assert.match(html,/Completed/);assert.match(html,/Capri · memory-relevance/);assert.match(html,/T12:05/);
});

test('invalid or foreign messages leave state unchanged',()=>{
  for(const m of [{type:'caption',text:'hi'},msg({agent:'browser'}),msg({at:'not a date'}),msg({taskId:''}),{type:'agent_activity'},null])
    assert.equal(reduceAgentActivity(emptyAgentActivity,m),emptyAgentActivity);
});

test('summaries are re-redacted in the renderer and rendered as inert text',()=>{
  const s=feed(msg({summary:'deploy with api_key=abcdef123456 and sk-live1234567890abc <img src=x onerror=alert(1)>',project:'token: hunter2secret'}));
  const html=render(s);
  assert.ok(!html.includes('abcdef123456')&&!html.includes('sk-live1234567890abc')&&!html.includes('hunter2secret'));
  assert.ok(!html.includes('<img'),'event text must not become markup');assert.match(html,/&lt;img/);
  const long=feed(msg({summary:'x'.repeat(400)}));assert.ok(!render(long).includes('x'.repeat(200)),'summary is concise');
});

test('task ids are redacted in panel, history and badge tooltip without changing identity',()=>{
  const s=feed(msg({id:'t1',kind:'needs_input',taskId:'token: hunter2secret',summary:'Waiting'}),msg({id:'t2',agent:'claude',kind:'error',taskId:'deploy sk-live1234567890abc',at:'2026-10-26T12:01:00.000Z'}));
  assert.equal(s.latest.codex?.taskId,'token: hunter2secret','stored identity is unchanged');
  const panel=render(s);const badge=renderToStaticMarkup(React.createElement(AgentActivityBadge,{state:s}));
  assert.match(badge,/title="Codex · \[redacted\] · Needs input"/);
  for(const html of [panel,badge])assert.ok(!html.includes('hunter2secret')&&!html.includes('sk-live1234567890abc'),html);
  assert.equal((panel.match(/\[redacted\]/g)||[]).length,4,'latest cards and history entries are both redacted');
  assert.equal(reduceAgentActivity(s,msg({id:'t1',taskId:'token: hunter2secret'})),s,'dedupe still uses event.id');
});

test('empty state clearly says no coordinator events arrived and the companion badge stays hidden',()=>{
  const html=render(emptyAgentActivity);assert.match(html,/No coordinator events have arrived/);assert.equal((html.match(/No activity received/g)||[]).length,2);
  assert.equal(renderToStaticMarkup(React.createElement(AgentActivityBadge,{state:feed(msg({kind:'completed'}))})),'');
  assert.match(renderToStaticMarkup(React.createElement(AgentActivityBadge,{state:feed(msg({kind:'error'}))})),/CODEX ERROR/);
});

test('agent activity is consumed before voice, caption and task handlers',async()=>{
  let state=emptyAgentActivity;const voiceSaw:unknown[]=[];
  const receive=(event:any)=>{if(routeAgentActivity(event,r=>{state=r(state);}))return;voiceSaw.push(event);};
  // Fields that voice.taskState or the message handler would act on must not leak through an activity event.
  receive({...msg({kind:'error',summary:'Speak this aloud'}),state:'error',taskId:'app-task',source:'agent',text:'caption?',message:{text:'x',taskId:'app-task'}});
  receive({type:'caption',text:'Real caption'});
  assert.deepEqual(voiceSaw,[{type:'caption',text:'Real caption'}]);assert.equal(state.latest.codex?.kind,'error');
  const main=await readFile('src/ui/main.tsx','utf8');
  // Execute the actual receiver and privacy predicate. Privacy admission must
  // precede the activity reducer; consumed activity must reach no other handler.
  const lines=main.split(/\r?\n/);
  const admission=lines.find(line=>line.trimStart().startsWith('const admitPrivateEvent='));
  const receiver=lines.find(line=>line.trimStart().startsWith('const receive='));
  assert.ok(admission&&receiver,'actual desktop handlers are present');
  const privateRef={current:false},privacyEpoch={current:7},privateEventClaims=new Map<string,number>();
  let updates=0;state=emptyAgentActivity;const actualVoiceSaw:unknown[]=[],captions:string[]=[];
  const context=vm.createContext({floating:false,privateRef,privacyEpoch,privateEventClaims,routeAgentActivity,
    setAgents:(reduce:(old:AgentActivityState)=>AgentActivityState)=>{updates++;state=reduce(state);},
    voice:{current:{taskState:(event:unknown)=>actualVoiceSaw.push(event)}},setCaption:(text:string)=>captions.push(text)});
  const actualReceive=new vm.Script('(()=>{'+admission.replace('(event:any)','(event)')+receiver.replace('(event:any)','(event)')+'return receive;})()').runInContext(context,{timeout:1000});
  const activity=(id:string)=>({...msg({id,kind:'error',summary:'Speak this aloud'}),state:'error',taskId:'app-task',source:'agent',text:'caption?',message:{text:'x',taskId:'app-task'}});
  actualReceive(activity('public'));assert.equal(updates,1);
  actualReceive({...activity('unclaimed'),privateSession:true});assert.equal(updates,1,'privacy rejection precedes activity reduction');
  privateRef.current=true;privateEventClaims.set('app-task',privacyEpoch.current);
  actualReceive({...activity('owned'),privateSession:true});assert.equal(updates,2);assert.equal(state.latest.codex?.id,'owned');
  privacyEpoch.current++;
  actualReceive({...activity('old-epoch'),privateSession:true});assert.equal(updates,2,'old private claims remain rejected');
  assert.deepEqual(actualVoiceSaw,[]);assert.deepEqual(captions,[],'activity never reaches caption effects');
  const caption={type:'caption',text:'Real caption'};actualReceive(caption);
  assert.deepEqual(actualVoiceSaw,[caption]);assert.deepEqual(captions,['Real caption']);
  assert.ok(!/dangerouslySetInnerHTML/.test(main+await readFile('src/ui/AgentActivity.tsx','utf8')));
});
