import React from 'react';
import { Bot } from 'lucide-react';
import type { AgentActivityEvent } from '../development';
import { agentAttention, agentNames, agentOrder, agentStatus, conciseSummary, displayTaskId, type AgentActivityState } from './agent-activity';

const defaultTime=(at:string)=>new Date(at).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
type Format={formatTime?:(at:string)=>string};
// Event text is rendered only as React text nodes; it is never HTML, a link or an action.
function AgentLine({event,formatTime=defaultTime}:{event:AgentActivityEvent}&Format){const status=agentStatus(event.kind);
 return <><div className="agent-line-top"><span className="agent-task">{`${event.project} · ${displayTaskId(event.taskId)}`}</span><span className={'agent-status '+status.tone}>{status.label}</span></div><p className="agent-summary">{conciseSummary(event.summary)}</p><time dateTime={event.at}>{formatTime(event.at)}</time></>;}
export function AgentActivityPanel({state,formatTime,historyLimit=6}:{state:AgentActivityState;historyLimit?:number}&Format){const empty=!state.history.length;
 return <section className="card section-card agent-activity" aria-label="Coding agents activity"><div className="card-heading"><h2><Bot size={17}/> Coding agents</h2><span className={'tag '+(empty?'':'green')}>{empty?'NO EVENTS YET':state.history.length+' RECENT'}</span></div>
  {empty&&<p className="muted agent-empty">No coordinator events have arrived. Codex and Claude activity appears here when the development coordinator publishes it.</p>}
  <div className="agent-grid">{agentOrder.map(agent=>{const event=state.latest[agent];return <article key={agent} className={'agent-card '+(event?agentStatus(event.kind).tone:'idle')}><span className="eyebrow">{agentNames[agent].toUpperCase()}</span>{event?<AgentLine event={event} formatTime={formatTime}/>:<p className="agent-summary muted">No activity received</p>}</article>;})}</div>
  {state.history.length>0&&<details className="agent-history"><summary>Recent events</summary><ol>{state.history.slice(0,historyLimit).map(event=><li key={event.id}><b>{agentNames[event.agent]}</b><AgentLine event={event} formatTime={formatTime}/></li>)}</ol></details>}
 </section>;}
/** Small companion indicator. Only appears when an agent needs input or reported an error. */
export function AgentActivityBadge({state}:{state:AgentActivityState}){const event=agentAttention(state);if(!event)return null;const status=agentStatus(event.kind);
 return <span className={'agent-badge '+status.tone} role="status" title={agentNames[event.agent]+' · '+displayTaskId(event.taskId)+' · '+status.label}><Bot size={11}/>{`${agentNames[event.agent].toUpperCase()} ${status.tone==='error'?'ERROR':'INPUT'}`}</span>;}
