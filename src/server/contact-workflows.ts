import {randomUUID} from 'node:crypto';
import type {AdminTemplate,ApprovedText} from '../extensions/contact-admin';
import {renderApprovedContactText,reviewedContactBody,type OutboundMessage} from '../extensions/contact-providers';
import {sha256} from '../extensions/policy';
import type {ContactIntent} from '../extensions/contracts';

/** No model text, task names, paths or summaries enter automatic notifications.
 * The only dynamic field in this initial slice is a server-observed lifecycle state. */
export type ContactWorkflowStatus='requested'|'completed'|'completed-unverified';
export function renderContactWorkflow(template:AdminTemplate,status:ContactWorkflowStatus,input:{channel:OutboundMessage['channel'];sender:string;recipient:string;approvedText?:ApprovedText}):OutboundMessage {
  const render=(text:string)=>{
    if(/[{}]/.test(text.replaceAll('{{status}}','')))throw Error('Unsupported contact template field.');
    return text.replaceAll('{{status}}',status);
  };
  const message:OutboundMessage={channel:input.channel,sender:input.sender,recipient:input.recipient,body:render(template.body)};
  if(input.channel==='gmail'&&template.subject!==undefined)message.subject=render(template.subject);
  if(input.channel==='voice')message.maxVoiceSeconds=template.maxVoiceSeconds;
  if(input.channel==='whatsapp'){
    const approved=input.approvedText;if(!approved||approved.sid!==template.whatsappSid)throw Error('Approved template unavailable.');
    // Plain text, optionally with exactly one server-owned status variable.
    const variables:Record<string,string>|undefined=approved.variables.length===0?{}:approved.variables.length===1&&approved.variables[0]==='1'?{'1':status}:undefined;
    if(!variables)throw Error('Unsupported contact template variables.');
    message.whatsapp={contentSid:approved.sid,variables};
    const actual=renderApprovedContactText(approved,variables);
    if(actual!==message.body)throw Error('Reviewed template text changed.');
  }
  return message;
}
export const contactCompletionIdentity=(taskId:string)=>'completion:'+sha256(taskId);
export function notificationIntent(binding:Omit<ContactIntent['binding'],'bodySha256'>,message:OutboundMessage):ContactIntent {
  return {requestId:randomUUID(),binding:{...binding,bodySha256:sha256(reviewedContactBody(message))}};
}
