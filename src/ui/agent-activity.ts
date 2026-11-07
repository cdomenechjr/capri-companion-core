import {normalizeAgentActivity, redactActivity, type AgentActivityEvent, type AgentActivityKind, type DevelopmentAgent} from '../development';

/** Coding-agent events are display-only data: never captions, speech, task completion or commands. */
export const agentNames: Record<DevelopmentAgent,string> = {codex:'Codex', claude:'Claude'};
export const agentOrder: DevelopmentAgent[] = ['codex','claude'];
export const AGENT_HISTORY_LIMIT = 24;
export const AGENT_SEEN_LIMIT = 500;
export const AGENT_SUMMARY_LIMIT = 160;
export type AgentActivityState = {
  latest: Partial<Record<DevelopmentAgent,AgentActivityEvent>>;
  history: AgentActivityEvent[];
  seen: string[];
};
export const emptyAgentActivity: AgentActivityState = {latest:{}, history:[], seen:[]};
export type AgentTone = 'attention' | 'error' | 'done' | 'active';
export function agentStatus(kind: AgentActivityKind): {label:string; tone:AgentTone} {
  if(kind==='needs_input')return {label:'Needs input', tone:'attention'};
  if(kind==='error')return {label:'Error', tone:'error'};
  if(kind==='completed')return {label:'Completed', tone:'done'};
  return {label:kind==='started'?'Started':kind==='thinking'?'Thinking':'Working', tone:'active'};
}
export function conciseSummary(summary: string): string {
  const text = summary.replace(/\s+/g,' ').trim();
  return text.length>AGENT_SUMMARY_LIMIT ? text.slice(0,AGENT_SUMMARY_LIMIT-1).trimEnd()+'…' : text || 'No summary';
}
/** Redacts the task id for display only; event.taskId keeps its original identity. */
export function displayTaskId(taskId: string): string {
  return redactActivity(taskId.replace(/\s+/g,' ').trim()) || 'unknown task';
}
export function isAgentActivityMessage(message: unknown): message is {type:'agent_activity'; event:unknown} {
  return !!message && typeof message==='object' && (message as {type?:unknown}).type==='agent_activity';
}
/** Re-validates and re-redacts the broadcast so the renderer does not trust the transport. */
export function reduceAgentActivity(state: AgentActivityState, message: unknown): AgentActivityState {
  if(!isAgentActivityMessage(message))return state;
  const event = normalizeAgentActivity(message.event);
  if(!event || state.seen.includes(event.id))return state;
  const current = state.latest[event.agent];
  const newer = !current || Date.parse(event.at)>=Date.parse(current.at);
  const history = [event,...state.history].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)).slice(0,AGENT_HISTORY_LIMIT);
  return {latest:newer?{...state.latest,[event.agent]:event}:state.latest, history, seen:[...state.seen,event.id].slice(-AGENT_SEEN_LIMIT)};
}
/** Consumes agent activity before any voice, caption or task handling. Returns true when handled. */
export function routeAgentActivity(message: unknown, apply: (reduce:(state:AgentActivityState)=>AgentActivityState)=>void): boolean {
  if(!isAgentActivityMessage(message))return false;
  apply(state=>reduceAgentActivity(state,message));
  return true;
}
/** The most urgent latest status, used for the compact companion indicator. */
export function agentAttention(state: AgentActivityState): AgentActivityEvent | undefined {
  const rank: Partial<Record<AgentActivityKind,number>> = {needs_input:2, error:1};
  return agentOrder.map(agent=>state.latest[agent]).filter((e):e is AgentActivityEvent=>!!e&&!!rank[e.kind])
    .sort((a,b)=>rank[b.kind]!-rank[a.kind]!||Date.parse(b.at)-Date.parse(a.at))[0];
}
