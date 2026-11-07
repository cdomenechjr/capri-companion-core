/** Coding-agent activity is presentation data. It never grants runtime tool permissions. */
export type DevelopmentAgent = 'codex' | 'claude';
export type AgentActivityKind = 'started' | 'working' | 'thinking' | 'needs_input' | 'error' | 'completed';
export type AgentActivityEvent = {
  id: string; agent: DevelopmentAgent; sessionId: string; taskId: string; project: string;
  kind: AgentActivityKind; summary: string; at: string;
};
export type CompanionPresentationEvent = {type:'agent_activity'; event:AgentActivityEvent};
const kinds = new Set<AgentActivityKind>(['started','working','thinking','needs_input','error','completed']);
export function redactActivity(value: string): string {
  return value.replace(/\bsk-[a-zA-Z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\b(?:Bearer|api[_-]?key|token|password|secret)\s*[:= ]\s*[^\s,;]+/gi, '[redacted]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500);
}
export function normalizeAgentActivity(value: unknown): AgentActivityEvent | undefined {
  if (!value || typeof value !== 'object') return;
  const e = value as Record<string, unknown>;
  if (!['codex','claude'].includes(String(e.agent)) || !kinds.has(e.kind as AgentActivityKind)) return;
  if (!['id','sessionId','taskId','project','summary','at'].every(k => typeof e[k] === 'string')) return;
  if (!e.id || !e.taskId || !Number.isFinite(Date.parse(e.at as string))) return;
  return {id:(e.id as string).slice(0,200), agent:e.agent as DevelopmentAgent,
    sessionId:(e.sessionId as string).slice(0,200), taskId:(e.taskId as string).slice(0,200),
    project:redactActivity(e.project as string), kind:e.kind as AgentActivityKind,
    summary:redactActivity(e.summary as string), at:e.at as string};
}
