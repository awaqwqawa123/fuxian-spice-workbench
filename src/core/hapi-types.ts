import type { Project } from './circuit'
export interface HapiStatus { installed:boolean; available:boolean; version:string; message:string; hubUrl?:string; machineId?:string }
export interface HapiMessage { id:string; role:'user'|'assistant'; content:string; createdAt:number; delivery?:'queued'|'sent'|'unknown'|'failed' }
export interface HapiQuestion { id:string; question:string; options:{label:string;description?:string}[]; multiSelect?:boolean }
export interface HapiApproval { id:string; title:string; detail:string; kind:'approval'|'question'; questions?:HapiQuestion[] }
export interface HapiSessionState { projectId:string; sessionId:string|null; threadId:string|null; status:'idle'|'running'|'offline'|'error'; messages:HapiMessage[]; approvals:HapiApproval[]; error:string|null; updatedAt:number }
export interface HapiConnectRequest {projectId:string;project:Project}
