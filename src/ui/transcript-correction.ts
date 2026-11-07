/** Last-heard transcript correction. Renderer memory only: never persisted, broadcast or replayed. */
import type { UserTranscriptEvent, UserTranscriptOutcomeEvent } from './voice';

export const CORRECTION_LIMIT = 4000;
/**
 * What is actually known about a submitted request. Only a receipt carrying the request id (or an observed
 * task record) counts as accepted. Only a typed pre-acceptance failure is a rejection; anything else is unknown.
 */
export type SubmissionOutcome = 'pending' | 'accepted' | 'rejected' | 'unknown';
export type Submission = {outcome: Exclude<SubmissionOutcome, 'pending'>; error: string};
export type HeardTranscript = {
  /** Local id of this heard utterance. */
  id: string;
  text: string;
  /** Request id Voice submitted for the original utterance. Its status is never altered here. */
  taskId: string;
  private: boolean;
  outcome: SubmissionOutcome;
  error: string;
};
/** The explicit corrected request. Its id is stable: an unconfirmed attempt is never retried under a fresh id. */
export type ResendAttempt = {id: string; text: string; outcome: SubmissionOutcome; error: string};
export type CorrectionState = {
  heard: HeardTranscript | null;
  draft: string;
  editing: boolean;
  resend: ResendAttempt | null;
};
export type CorrectionRequest = {id: string; text: string; private: boolean};
export type ResendResult =
  | {ok: true; state: CorrectionState; request: CorrectionRequest}
  | {ok: false; state: CorrectionState; reason: 'none' | 'empty' | 'unchanged' | 'pending' | 'already' | 'unknown' | 'privacy'};

export const emptyCorrection: CorrectionState = {heard: null, draft: '', editing: false, resend: null};
export const correctionNotice = 'Sends a new request. The original stays as it was, and anything it already did is not undone.';
export const resendReasons: Record<Exclude<ResendResult, {ok: true}>['reason'], string> = {
  none: 'Nothing has been heard yet.',
  empty: 'Type the corrected request first.',
  unchanged: 'Change the transcript before resending.',
  pending: 'The correction is still being sent.',
  already: 'This correction was already sent.',
  unknown: 'The correction may have been received. Check Activity before sending it again.',
  privacy: 'Privacy mode changed, so this transcript was cleared.',
};

const clean = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, CORRECTION_LIMIT);
const settled = (outcome: unknown): outcome is Submission['outcome'] => outcome === 'accepted' || outcome === 'rejected' || outcome === 'unknown';

/**
 * Typed provenance for a failure known to happen before the service could store anything (a local guard that
 * refused to dispatch). Only this counts as a rejection; message text never does, because the request transport
 * strips status metadata and the service can fail after storing the task.
 */
export class NotAcceptedError extends Error {
  readonly notAccepted = true;
  constructor(message: string) { super(message); this.name = 'NotAcceptedError'; }
}

/** A receipt is only an acceptance when it names the request that was sent. */
export function receiptOutcome(requestId: string, receipt: unknown): Submission {
  const id = receipt && typeof receipt === 'object' ? (receipt as {id?: unknown}).id : undefined;
  return id === requestId ? {outcome: 'accepted', error: ''} : {outcome: 'unknown', error: 'No receipt came back for this request.'};
}
/** Any failure without typed pre-acceptance provenance leaves acceptance unknown, including a generic service error. */
export function failureOutcome(error: unknown): Submission {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const message = raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^(?:Error|CapriError):\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return {outcome: error instanceof NotAcceptedError ? 'rejected' : 'unknown', error: message || 'Request failed.'};
}
/** Awaits one submission and reports what is actually known. Never retries. */
export async function settleSubmission(requestId: string, send: () => Promise<unknown>): Promise<Submission> {
  try { return receiptOutcome(requestId, await send()); } catch (e) { return failureOutcome(e); }
}

/**
 * Records Voice's explicit userTranscript event. A new utterance replaces the previous one and discards any
 * unsent draft. Anything else, a repeat of the same id, or an event from the other privacy mode is ignored.
 */
export function heardTranscript(state: CorrectionState, event: unknown, privateMode: boolean): CorrectionState {
  const heard = event as Partial<UserTranscriptEvent> | null;
  if (!heard || heard.type !== 'userTranscript' || typeof heard.id !== 'string' || !heard.id || typeof heard.taskId !== 'string' || !heard.taskId || typeof heard.private !== 'boolean') return state;
  if (heard.private !== privateMode || heard.id === state.heard?.id) return state;
  const text = clean(String(heard.text ?? ''));
  if (!text) return state;
  return {heard: {id: heard.id, text, taskId: heard.taskId, private: heard.private, outcome: 'pending', error: ''}, draft: text, editing: false, resend: null};
}
/** Applies Voice's follow-up outcome for the same heard id and request id. Only a pending submission settles. */
export function heardOutcome(state: CorrectionState, event: unknown): CorrectionState {
  const result = event as Partial<UserTranscriptOutcomeEvent> | null;
  const heard = state.heard;
  if (!heard || !result || result.type !== 'userTranscriptOutcome' || result.id !== heard.id || result.taskId !== heard.taskId || !settled(result.outcome) || heard.outcome !== 'pending') return state;
  return {...state, heard: {...heard, outcome: result.outcome, error: result.outcome === 'accepted' ? '' : String(result.error ?? '').slice(0, 200)}};
}
export function beginCorrection(state: CorrectionState, tasks: TaskRow[] = []): CorrectionState {
  state = reconcileObserved(state, tasks);
  return state.heard && canResend(state) ? {...state, editing: true, draft: state.draft || state.heard.text} : state;
}
export function updateCorrection(state: CorrectionState, draft: string): CorrectionState {
  return state.editing ? {...state, draft: draft.slice(0, CORRECTION_LIMIT)} : state;
}
export function cancelCorrection(state: CorrectionState): CorrectionState {
  if (!state.heard) return state;
  return {...state, editing: false, draft: state.resend?.outcome === 'rejected' ? state.draft : state.heard.text};
}
/** Clears everything when privacy mode changes so private speech never survives into a saved session (or vice versa). */
export function resetForPrivacy(state: CorrectionState, privateMode: boolean): CorrectionState {
  return state.heard && state.heard.private !== privateMode ? emptyCorrection : state;
}
/**
 * Folds observed task records into the state. A matching record proves acceptance, so the attempt is settled as
 * accepted for good (even if it was classified rejected, or the record later leaves the list). Returns the same
 * object when nothing changes.
 */
export function reconcileObserved(state: CorrectionState, tasks: TaskRow[]): CorrectionState {
  const seen = (id: string) => tasks.some(task => task.id === id);
  const heard = state.heard && state.heard.outcome !== 'accepted' && seen(state.heard.taskId) ? {...state.heard, outcome: 'accepted' as const, error: ''} : state.heard;
  const resend = state.resend && state.resend.outcome !== 'accepted' && seen(state.resend.id) ? {...state.resend, outcome: 'accepted' as const, error: ''} : state.resend;
  if (heard === state.heard && resend === state.resend) return state;
  return {...state, heard, resend, editing: resend !== state.resend ? false : state.editing};
}
/** Only a definite rejection with no observed task record permits another deliberate attempt. */
export function canResend(state: CorrectionState, tasks: TaskRow[] = []) {
  const resend = reconcileObserved(state, tasks).resend;
  return !resend || resend.outcome === 'rejected';
}

/**
 * Builds exactly one explicit new request from the edited draft. It never re-submits the original request id.
 * While a correction is pending, accepted (by receipt or observed task) or unconfirmed, another one is refused.
 */
export function prepareResend(current: CorrectionState, privateMode: boolean, newId: () => string = () => crypto.randomUUID(), tasks: TaskRow[] = []): ResendResult {
  const state = reconcileObserved(current, tasks);
  if (!state.heard) return {ok: false, state, reason: 'none'};
  if (state.heard.private !== privateMode) return {ok: false, state: emptyCorrection, reason: 'privacy'};
  const previous = state.resend?.outcome;
  if (previous === 'pending' || previous === 'accepted' || previous === 'unknown') return {ok: false, state, reason: previous === 'accepted' ? 'already' : previous};
  const text = clean(state.draft);
  if (!text) return {ok: false, state, reason: 'empty'};
  if (text === state.heard.text) return {ok: false, state, reason: 'unchanged'};
  const id = newId();
  return {ok: true, state: {...state, draft: text, editing: false, resend: {id, text, outcome: 'pending', error: ''}}, request: {id, text, private: privateMode}};
}
/** Records the settled corrected request. A rejection reopens the retained draft for a deliberate new attempt. */
export function resendOutcome(state: CorrectionState, requestId: string, submission: Submission): CorrectionState {
  const resend = state.resend;
  if (!resend || resend.id !== requestId || resend.outcome !== 'pending') return state;
  const next = {...resend, outcome: submission.outcome, error: submission.outcome === 'accepted' ? '' : submission.error};
  return {...state, resend: next, editing: submission.outcome === 'rejected'};
}

/** What the renderer supplies to send one correction. `epoch` is a monotonic privacy-session generation. */
export type ResendSession = {
  state: () => CorrectionState;
  update: (next: CorrectionState) => void;
  privateMode: () => boolean;
  epoch: () => number;
  tasks: () => TaskRow[];
  send: (request: CorrectionRequest) => Promise<unknown>;
  /** Adds the accepted private correction to the ephemeral chat. */
  echo: (request: CorrectionRequest) => void;
  newId?: () => string;
};
export type ResendRun =
  | {sent: false; reason: Exclude<ResendResult, {ok: true}>['reason']}
  | {sent: true; request: CorrectionRequest; submission: Submission; current: boolean};
/**
 * Sends one explicit correction. The privacy epoch is captured before the await; a late result may only update
 * the still-current request in the same epoch, so it can never restore private text after an off/on switch.
 */
export async function runResend(session: ResendSession): Promise<ResendRun> {
  const epoch = session.epoch();
  const result = prepareResend(session.state(), session.privateMode(), session.newId, session.tasks());
  session.update(result.state);
  if (!result.ok) return {sent: false, reason: result.reason};
  const request = result.request;
  const submission = await settleSubmission(request.id, () => session.send(request));
  const current = session.epoch() === epoch && session.privateMode() === request.private && session.state().resend?.id === request.id;
  if (!current) return {sent: true, request, submission, current};
  const next = reconcileObserved(resendOutcome(session.state(), request.id, submission), session.tasks());
  session.update(next);
  if (next.resend?.outcome === 'accepted' && request.private) session.echo(request);
  return {sent: true, request, submission, current};
}

type TaskRow = {id: string; status?: string};
/** A receipt or an actual task record confirms acceptance; nothing else does. */
export function observedOutcome(outcome: SubmissionOutcome, id: string, tasks: TaskRow[]): SubmissionOutcome {
  return tasks.some(task => task.id === id) ? 'accepted' : outcome;
}
/** Honest status line for the original request: correction never changes it. */
export function originalStatus(heard: HeardTranscript | null, tasks: TaskRow[]): string {
  if (!heard) return '';
  const status = tasks.find(task => task.id === heard.taskId)?.status;
  if (status) return 'Original request is ' + status + '.';
  switch (observedOutcome(heard.outcome, heard.taskId, tasks)) {
    case 'pending': return 'Original request is still being submitted.';
    case 'accepted': return 'Original request was received; Activity shows its status.';
    case 'rejected': return 'Original request was not accepted' + (heard.error ? ': ' + heard.error : '.');
    default: return 'Capri could not confirm the original request was received. Check Activity.';
  }
}
/** Honest status line for the explicit corrected request. */
export function resendStatus(resend: ResendAttempt | null, tasks: TaskRow[]): string {
  if (!resend) return '';
  const status = tasks.find(task => task.id === resend.id)?.status;
  switch (observedOutcome(resend.outcome, resend.id, tasks)) {
    case 'pending': return 'Sending the correction as a new request…';
    case 'accepted': return 'Correction sent as a new request' + (status ? ' and is ' + status : '') + '.';
    case 'rejected': return 'The correction was not accepted' + (resend.error ? ': ' + resend.error : '.') + ' Edit it and send again when ready.';
    default: return 'Capri could not confirm the correction was received. Check Activity; it will not be sent again automatically.';
  }
}
