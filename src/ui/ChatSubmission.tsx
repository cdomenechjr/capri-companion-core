import React from 'react';
import { RotateCcw, X } from 'lucide-react';
import { chatStatus, type ChatAttempt, type ChatSubmissionState } from './chat-submission';

/** Status of each typed message until a receipt or task record confirms it, or the user disposes of it. Text renders as plain data only. */
export function ChatSubmission({state,tasks,onRestore,onDismiss}:{state:ChatSubmissionState;tasks:{id:string;status?:string}[];onRestore:(attempt:ChatAttempt)=>void;onDismiss:(attempt:ChatAttempt)=>void}){
 const shown=state.attempts.filter(attempt=>attempt.outcome!=='accepted'&&!tasks.some(task=>task.id===attempt.id));if(!shown.length)return null;
 return <div className="chat-submissions">{shown.map(attempt=>{const pending=attempt.outcome==='pending';return <section key={attempt.id} className={'chat-submission '+attempt.outcome} aria-label="Message status">
  <span className="eyebrow">{pending?'SENDING':attempt.outcome==='rejected'?'NOT SENT':'NOT CONFIRMED'}{attempt.private?' · PRIVATE, NOT SAVED':''}</span>
  <p className="chat-submission-text">{attempt.text}</p>
  <p className={'small transcript-outcome '+attempt.outcome} role="status">{chatStatus(attempt)}</p>
  {!pending&&<div className="button-row"><button type="button" className="text-link" onClick={()=>onRestore(attempt)}><RotateCcw size={12}/> Restore draft</button><button type="button" className="text-link" onClick={()=>onDismiss(attempt)}><X size={12}/> Dismiss</button></div>}
 </section>;})}</div>;
}
