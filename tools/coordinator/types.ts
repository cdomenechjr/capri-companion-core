import type {SupervisorIdentity} from '../../src/extensions/supervisor';
export type Agent = 'codex'|'claude';
const capacityBusyInstances=new WeakSet<object>();
/** Trusted transport may throw ONLY when atomic capacity acquisition fails
 * before starting a run. JSON, model error text and prototype lookalikes carry
 * no brand and cannot exempt an attempted run from accounting. */
export class AgentCapacityBusy extends Error {
 readonly agent:Agent;
 constructor(agent:Agent){super('Agent provider capacity is busy before dispatch.');this.name='AgentCapacityBusy';this.agent=agent;capacityBusyInstances.add(this);}
}
export function isAgentCapacityBusy(value:unknown,agent:Agent):value is AgentCapacityBusy{return typeof value==='object'&&value!==null&&capacityBusyInstances.has(value)&&value instanceof AgentCapacityBusy&&value.agent===agent;}
export type Phase = 'queued'|'running'|'review'|'integration'|'completed'|'blocked'|'failed';
export type Check = {id:string;command:string;args:string[];timeoutMs?:number;scope?:'task'};
export type TaskSpec = {id:string;owner:Agent;goal:string;allowedPaths:string[];dependencies:string[];resources:string[];acceptance:string[];priority?:number};
export type PublicationReceipt = {schemaVersion:1;sourceCommit:string;version:string;sequence:number;manifestSha256:string;artifactSha256:string;artifactBytes:number;publisherKeyId:string;publishedAt:number;id:string};
export type ReleaseFinalization = {schemaVersion:1;batchId:string;previous:{sourceCommit:string;version:string;sequence:number;receiptId:string};productCommit:string;productDigest:string;targetVersion:string;outputDirectory:string;contributors:{id:string;implementationCommit:string;integrationCommit:string}[]};
export type ReleaseBatch = {contract:ReleaseFinalization;taskId:string;stage:'queued'|'ready'|'published'|'superseded';finalizedCommit?:string};
export type ReleaseVersionState = {anchor?:PublicationReceipt;batches:ReleaseBatch[];pendingBatchId?:string};
export type ReleaseTaskMetadata = {ownershipRecovery?:AgentOwnershipRecovery;kind?:'product'|'release-finalization';origin?:'static'|'continuous'|'coordinator';outcome?:'changed'|'no-change'|'superseded';integratedCommit?:string;releaseFinalization?:ReleaseFinalization;finalizationHistory?:{attempt:number;worktree:string;commit:string}[]};
export type WorkerResult = {status:'completed'|'blocked';summary:string;changedFiles:string[];tests:string[];limitations:string[];handoff:string};
export type ReviewResult = {approved:boolean;summary:string;issues:string[]};
export type ScopeAmendment = {at:string;feedback:string;addedPaths:string[];previousFingerprint:string;fingerprint:string};
export type Task = TaskSpec & ReleaseTaskMetadata & {phase:Phase;attempts:number;manualRetries?:number;attemptLimit?:number;retryHistory?:{at:string;feedback:string;afterAttempt:number;previousCommit?:string;addedPaths?:string[]}[];scopeAmendmentHistory?:ScopeAmendment[];reviewHistory?:{at:string;attempt:number;reviewer:Agent;review:ReviewResult;commit?:string}[];integrationFailure?:{at:string;commit:string;candidateCommit:string;error:string};pendingReintegration?:boolean;reintegrationHistory?:{at:string;feedback:string;commit:string;reviewer:Agent;afterAttempt:number;candidateCommit:string}[];integrationRepairHistory?:{at:string;commit:string;previousWorktree?:string;previousBase?:string;repairWorktree:string;candidateCommit:string}[];baseCommit?:string;commit?:string;worktree?:string;branch?:string;profile?:string;port?:number;result?:WorkerResult;review?:ReviewResult;error?:string;startedAt?:string;finishedAt?:string;run?:RunIdentity;fingerprint:string;validation?:CheckResult[]};
export type ScopeAmendmentResult = {task:Task;changed:boolean;addedPaths:string[]};
export type RunIdentity = {pid:number;marker:string;agent:Agent;mode:'implement'|'review'|'propose';taskId:string;sessionId:string;startedAt:string;leaseToken?:string;ownership?:'native-job-v1';supervisor?:SupervisorIdentity};
export type AgentOwnershipLease = {agent:Agent;state:'ready'|'busy'|'unconfirmed';reason?:string};
export type AgentOwnershipRecovery = {run:RunIdentity;stopped:boolean;reason?:string;at:string};
/** Installed by trusted process transport/source only. Provider output, model
 * records and activity events can never install hooks or attest ownership. */
export interface AgentOwnershipHooks {
 readonly protocol:'capri-agent-ownership-v1';
 reconcile(run:Readonly<RunIdentity>):Promise<{stopped:boolean;reason?:string}>;
 cleanupStatus(run:Readonly<RunIdentity>):'confirmed'|'unconfirmed';
 ready?(agent:Agent):boolean;
 /** Report both providers explicitly. busy includes a foreign live runtime
  * owner; never terminate it. Missing/malformed/unknown reports fail closed. */
 reconcileLeases?():Promise<AgentOwnershipLease[]>;
}
export type CheckResult = {id:string;passed:boolean;code:number|null;output:string};
export type Activity = {id:string;agent:Agent;sessionId:string;taskId:string;project:string;kind:'started'|'working'|'thinking'|'needs_input'|'error'|'completed';summary:string;at:string};
export type Config = {version:1;repo:string;developmentRoot:string;stateDir:string;worktreeRoot:string;profileRoot:string;referenceRoot:string;candidateBranch:string;tasksFile:string;prompts:{master:string;codex:string;claude:string;review:string};checks:Check[];agents:Record<Agent,{command:string;args?:string[]}>;continuous:boolean;timeoutMs:number;maxRepairAttempts:number;pollMs:number;maxProposalsPerCycle:number;maxQueuedTasks:number;proposalAllowedPaths:string[];operatorAllowedPaths?:string[];roadmapFile:string;releaseVersioning?:{enabled:boolean;previewPrefix:string}};
export type Replan = {at:string;changes:{taskId:string;previousDependencies:string[];dependencies:string[];requeued:boolean}[]};
export type State = {version:1;generation:number;runId:string;status:'running'|'paused'|'stopped';startedAt:string;updatedAt:string;candidateCommit:string;tasks:Task[];eventsSeen:string[];proposalsAfter:number;proposalAttempts:number;proposalRun?:RunIdentity;proposalOwnershipRecovery?:AgentOwnershipRecovery;agentOwnership?:{protocol:'capri-agent-ownership-v1';leases:AgentOwnershipLease[];at:string};lastError?:string;replans?:Replan[];planning?:{inputDigest:string;outcome:'running'|'empty'|'proposed'|'failed';at:string;taskIds?:string[];ownershipUnconfirmed?:boolean};releaseVersioning?:ReleaseVersionState};
export const resultSchema = {type:'object',additionalProperties:false,properties:{status:{type:'string',enum:['completed','blocked']},summary:{type:'string'},changedFiles:{type:'array',items:{type:'string'}},tests:{type:'array',items:{type:'string'}},limitations:{type:'array',items:{type:'string'}},handoff:{type:'string'}},required:['status','summary','changedFiles','tests','limitations','handoff']};
export const reviewSchema = {type:'object',additionalProperties:false,properties:{approved:{type:'boolean'},summary:{type:'string'},issues:{type:'array',items:{type:'string'}}},required:['approved','summary','issues']};
export const proposalSchema = {type:'object',additionalProperties:false,properties:{tasks:{type:'array',items:{type:'object',additionalProperties:false,properties:{id:{type:'string'},owner:{type:'string',enum:['codex','claude']},goal:{type:'string'},allowedPaths:{type:'array',items:{type:'string'}},resources:{type:'array',items:{type:'string'}}},required:['id','owner','goal','allowedPaths','resources']}}},required:['tasks']};
