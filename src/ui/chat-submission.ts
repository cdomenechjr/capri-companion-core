/** Typed chat submission. Renderer memory only: each submitted draft is retained until a receipt proves acceptance or the user disposes of it. */
import { settleSubmission, type Submission, type SubmissionOutcome } from './transcript-correction';

export type ChatRequest = {id: string; text: string; private: boolean};
/** One typed request. Its id is fixed when it is captured, together with its privacy mode and privacy epoch. */
export type ChatAttempt = ChatRequest & {epoch: number; outcome: SubmissionOutcome; error: string};
/** Oldest first. At most one attempt is pending; the rest are rejected or unconfirmed drafts awaiting Restore or Dismiss. */
export type ChatSubmissionState = {attempts: ChatAttempt[]};
export type ChatRefusal = 'empty' | 'pending' | 'unknown' | 'full';
export type ChatPrepared =
  | {ok: true; state: ChatSubmissionState; request: ChatRequest}
  | {ok: false; state: ChatSubmissionState; reason: ChatRefusal};
type TaskRow = {id: string; status?: string};
type ChatMessage = {id?: string; taskId?: string; role?: string; text?: string};

/** Unresolved drafts kept at once; beyond this the user must restore or dismiss one before sending more. */
export const heldLimit = 4;
export const emptyChatSubmission: ChatSubmissionState = {attempts: []};
export const chatReasons: Record<ChatRefusal, string> = {
  empty: 'Type a message first.',
  pending: 'Your last message is still being sent.',
  unknown: 'That message may have been received. Check Activity, or dismiss the notice to send it again.',
  full: 'Restore or dismiss an earlier unsent message before sending another.',
};

const same = (a: string, b: string) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
const seen = (attempt: ChatAttempt, tasks: TaskRow[]) => tasks.some(task => task.id === attempt.id);
const without = (state: ChatSubmissionState, drop: (attempt: ChatAttempt) => boolean): ChatSubmissionState => {
  const attempts = state.attempts.filter(attempt => !drop(attempt));
  return attempts.length === state.attempts.length ? state : {attempts};
};

export const pendingChat = (state: ChatSubmissionState) => state.attempts.some(attempt => attempt.outcome === 'pending');
export const findChat = (state: ChatSubmissionState, id: string) => state.attempts.find(attempt => attempt.id === id) || null;

/**
 * Captures one request. While one is pending, another is refused; the same text as an unconfirmed attempt is refused
 * too, so a repeated click cannot quietly duplicate a request the service may already have stored. Earlier unresolved
 * drafts stay retained alongside the new attempt; nothing is replaced without acceptance or explicit dismissal.
 */
export function prepareChat(current: ChatSubmissionState, text: string, privateMode: boolean, epoch: number, tasks: TaskRow[] = [], newId: () => string = () => crypto.randomUUID()): ChatPrepared {
  const state = without(current, attempt => seen(attempt, tasks));
  if (pendingChat(state)) return {ok: false, state, reason: 'pending'};
  if (!text.trim()) return {ok: false, state, reason: 'empty'};
  if (state.attempts.some(attempt => attempt.outcome === 'unknown' && same(attempt.text, text))) return {ok: false, state, reason: 'unknown'};
  if (state.attempts.length >= heldLimit) return {ok: false, state, reason: 'full'};
  const request = {id: newId(), text, private: privateMode};
  return {ok: true, state: {attempts: [...state.attempts, {...request, epoch, outcome: 'pending', error: ''}]}, request};
}
/** Settles only the still-pending attempt with this id. Acceptance releases that retained draft; others are untouched. */
export function settleChat(state: ChatSubmissionState, requestId: string, submission: Submission): ChatSubmissionState {
  const attempt = findChat(state, requestId);
  if (!attempt || attempt.outcome !== 'pending') return state;
  if (submission.outcome === 'accepted') return without(state, a => a.id === requestId);
  return {attempts: state.attempts.map(a => a.id === requestId ? {...a, outcome: submission.outcome, error: submission.error} : a)};
}
/** Attempts whose captured id appears in an observed task record; that proves acceptance, whatever they were classified as. */
export function observedChat(state: ChatSubmissionState, tasks: TaskRow[]): ChatAttempt[] {
  return state.attempts.filter(attempt => seen(attempt, tasks));
}
/** Drops observed attempts. Returns the same state object when nothing was observed. */
export function reconcileChat(state: ChatSubmissionState, tasks: TaskRow[]): ChatSubmissionState {
  return without(state, attempt => seen(attempt, tasks));
}
/**
 * Privacy change: private attempts are purged, pending or not, so no private text survives into another session. History
 * drafts stay retained, including a pending one, which still settles against its own captured id and privacy mode.
 */
export function dropPrivateChat(state: ChatSubmissionState): ChatSubmissionState {
  return without(state, attempt => attempt.private);
}
/** Explicit disposition of one settled draft. A pending attempt cannot be dismissed. */
export function dismissChat(state: ChatSubmissionState, id: string): ChatSubmissionState {
  return without(state, attempt => attempt.id === id && attempt.outcome !== 'pending');
}
/** Puts a retained draft back without overwriting newer composer text. Never sends anything. */
export function restoreDraft(composer: string, text: string) {
  return composer.trim() ? composer.replace(/\s+$/, '') + '\n' + text : text;
}
/**
 * Adds a confirmed private user message to the ephemeral chat once. It goes before any reply for the same task, since
 * the service may emit the reply before the receipt arrives.
 */
export function insertConfirmed<T extends ChatMessage>(messages: T[], request: ChatRequest): (T | ChatMessage)[] {
  if (messages.some(message => message.id === request.id)) return messages;
  const entry = {id: request.id, role: 'user', text: request.text, taskId: request.id};
  const reply = messages.findIndex(message => message.taskId === request.id);
  return reply < 0 ? [...messages, entry] : [...messages.slice(0, reply), entry, ...messages.slice(reply)];
}
export function chatStatus(attempt: ChatAttempt | null): string {
  if (!attempt) return '';
  switch (attempt.outcome) {
    case 'accepted': return '';
    case 'pending': return 'Sending…';
    case 'rejected': return 'Not sent' + (attempt.error ? ': ' + attempt.error : '.') + ' Your draft is kept here.';
    default: return 'Capri could not confirm this message was received' + (attempt.error ? ' (' + attempt.error + ')' : '') + '. Check Activity; it will not be sent again automatically.';
  }
}

/**
 * Private request identities by privacy epoch. Every private request (typed, correction, local or realtime voice) is
 * claimed synchronously before dispatch with the epoch captured alongside its privacy mode. The ledger belongs to the
 * renderer, not the voice session, so stopping voice does not forget a current-epoch request. A privacy change retires
 * every claim before anything awaits, so a late reply or claim from an earlier private session is never admitted.
 */
export type PrivateGate = {epoch: number; current: Set<string>; stale: Set<string>};
/** What the receiving view knows when a message event arrives. */
export type ReplyView = {
  privateMode: boolean;
  /** The floating view mirrors the session but cannot verify privacy epochs; it gets admitted captions forwarded instead. */
  floating: boolean;
};
export type ReplyOutlet = {
  speak?: (text: string, taskId?: string) => void;
  caption: (text: string) => void;
  ephemeral: (message: any) => void;
  forward?: (text: string) => void;
};
const retainedStale = 2000, retainedCurrent = 500;
const retire = (gate: PrivateGate, id: string) => {
  gate.current.delete(id);
  gate.stale.delete(id);
  gate.stale.add(id);
  while (gate.stale.size > retainedStale) gate.stale.delete(gate.stale.values().next().value!);
};

export const privateGate = (): PrivateGate => ({epoch: 0, current: new Set(), stale: new Set()});
/**
 * Records a private request id before it is dispatched. Returns false, recording nothing, for an id captured under an
 * earlier epoch or one already retired or answered.
 */
export function claimPrivate(gate: PrivateGate, id: string, epoch: number): boolean {
  if (!id || epoch !== gate.epoch || gate.stale.has(id)) return false;
  gate.current.add(id);
  while (gate.current.size > retainedCurrent) retire(gate, gate.current.values().next().value!);
  return true;
}
/** Starts a new privacy epoch. Every id claimed in the previous one becomes stale. Synchronous by design. */
export function advancePrivacy(gate: PrivateGate, epoch: number) {
  for (const id of [...gate.current]) retire(gate, id);
  gate.epoch = epoch;
}
/**
 * Whether a message event may be displayed, spoken or forwarded. Normal history messages pass unchanged. A private reply
 * is admitted only in the main view of a private session, and only for an id claimed before dispatch in this epoch and
 * not yet answered. Unknown, foreign, retired or repeated private replies are dropped.
 */
export function admitReply(gate: PrivateGate, event: any, view: ReplyView): boolean {
  if (!event?.privateSession) return true;
  const taskId = event.message?.taskId;
  if (view.floating || !view.privateMode || typeof taskId !== 'string' || !taskId) return false;
  return gate.current.has(taskId) && !gate.stale.has(taskId);
}
/**
 * Routes one message event to its outlets after the privacy check. Returns false when the event was dropped. An admitted
 * private reply answers its claim, so a duplicate delivery of the same reply is not shown or spoken again.
 */
export function showReply(gate: PrivateGate, event: any, view: ReplyView, out: ReplyOutlet): boolean {
  if (!admitReply(gate, event, view)) return false;
  const message = event.message;
  if (event.privateSession) retire(gate, message.taskId);
  out.speak?.(message.text, message.taskId);
  out.caption(message.text);
  if (event.privateSession) {
    out.ephemeral(message);
    out.forward?.(message.text);
  }
  return true;
}

/** What the renderer supplies to send one typed message. `epoch` is a monotonic privacy-session generation. */
export type ChatSession = {
  state: () => ChatSubmissionState;
  update: (next: ChatSubmissionState) => void;
  privateMode: () => boolean;
  epoch: () => number;
  tasks: () => TaskRow[];
  composer: () => string;
  setComposer: (text: string) => void;
  send: (request: ChatRequest) => Promise<unknown>;
  /** Adds an accepted private message to the ephemeral chat. */
  echo: (request: ChatRequest) => void;
  /** Records a private request id with its capture epoch before dispatch, so its reply can be told apart from stale ones. */
  claim?: (request: ChatRequest, epoch: number) => void;
  newId?: () => string;
};
export type ChatRun =
  | {sent: false; reason: ChatRefusal}
  | {sent: true; request: ChatRequest; submission: Submission; current: boolean};
/**
 * Sends one typed message. The pending state is written synchronously before the await, so a second click is
 * refused. The composer is cleared only if it still holds the submitted text; anything typed meanwhile is kept.
 * A late private result may only settle the still-retained attempt in the same privacy epoch. A history request settles
 * against its own captured id whatever the current privacy mode, and is never echoed into the private conversation.
 */
export async function runChat(session: ChatSession, text: string, fromComposer: boolean): Promise<ChatRun> {
  const prepared = prepareChat(session.state(), text, session.privateMode(), session.epoch(), session.tasks(), session.newId);
  session.update(prepared.state);
  if (!prepared.ok) return {sent: false, reason: prepared.reason};
  const request = prepared.request, epoch = session.epoch();
  if (fromComposer && session.composer() === text) session.setComposer('');
  if (request.private) session.claim?.(request, epoch);
  const submission = await settleSubmission(request.id, () => session.send(request));
  const retained = findChat(session.state(), request.id);
  const current = !!retained && retained.private === request.private &&(!request.private || (session.epoch() === epoch && session.privateMode()));
  if (!current) return {sent: true, request, submission, current};
  const observed = submission.outcome !== 'accepted' && session.tasks().some(task => task.id === request.id);
  session.update(settleChat(session.state(), request.id, observed ? {outcome: 'accepted', error: ''} : submission));
  if (request.private && (observed || submission.outcome === 'accepted')) session.echo(request);
  return {sent: true, request, submission, current};
}
