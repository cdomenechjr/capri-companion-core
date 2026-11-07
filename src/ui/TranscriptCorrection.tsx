import React from 'react';
import { Pencil, Send, X } from 'lucide-react';
import { canResend, CORRECTION_LIMIT, correctionNotice, observedOutcome, originalStatus, reconcileObserved, resendStatus, type CorrectionState } from './transcript-correction';

/** Last-heard transcript with a deliberate correct-and-resend action. Text renders as plain data only. */
export function TranscriptCorrection({state:raw,tasks,busy,onEdit,onChange,onCancel,onResend}:{state:CorrectionState;tasks:{id:string;status?:string}[];busy?:boolean;onEdit:()=>void;onChange:(text:string)=>void;onCancel:()=>void;onResend:()=>void}){
 const state=reconcileObserved(raw,tasks);const heard=state.heard;if(!heard)return null;
 const resend=state.resend;const open=canResend(state);
 const changed=state.draft.replace(/\s+/g,' ').trim();const ready=!!changed&&changed!==heard.text&&open&&!busy;
 const original=observedOutcome(heard.outcome,heard.taskId,tasks);const sent=resend?observedOutcome(resend.outcome,resend.id,tasks):'';
 return <section className="transcript-correction" aria-label="Last heard">
  <div className="transcript-head"><span className="eyebrow">LAST HEARD{heard.private?' · PRIVATE, NOT SAVED':''}</span>{!state.editing&&open&&<button type="button" className="text-link" onClick={onEdit}><Pencil size={12}/> {resend?'Edit and try again':'Correct'}</button>}</div>
  {state.editing?<form onSubmit={e=>{e.preventDefault();if(ready)onResend();}} onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();onCancel();}}}>
   <textarea aria-label="Correct what Capri heard" autoFocus maxLength={CORRECTION_LIMIT} value={state.draft} onChange={e=>onChange(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();if(ready)onResend();}}}/>
   {resend&&<p className="small transcript-outcome rejected" role="alert">{resendStatus(resend,tasks)}</p>}
   <p className="small muted">{correctionNotice} {originalStatus(heard,tasks)}</p>
   <div className="button-row"><button className="primary" disabled={!ready}><Send size={14}/> Send as new request</button><button type="button" className="secondary" onClick={onCancel}><X size={14}/> Cancel</button><span className="small muted">Ctrl+Enter to send · Esc to cancel</span></div>
  </form>:<p className="transcript-text">{resend&&resend.outcome!=='rejected'?resend.text:heard.text}</p>}
  {!state.editing&&!resend&&(original==='rejected'||original==='unknown')&&<p className={'small transcript-outcome '+original} role="status">{originalStatus(heard,tasks)}</p>}
  {resend&&!state.editing&&<p className={'small transcript-outcome '+sent} role="status">{resendStatus(resend,tasks)} {sent==='accepted'?originalStatus(heard,tasks)+' Anything it already did is not undone.':''}</p>}
 </section>;
}
