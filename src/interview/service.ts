import { canonicalJson } from '../ai/canonical';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { PracticeStore } from '../storage/practice-store';
import type { InterviewAnswer, InterviewRules, InterviewPool, InterviewSession, InterviewView, InterviewSaveResult, CompanyPreview } from '../shared/interview';
import type { AiTrustedContext } from '../shared/ai';
import { buildPool, validateRules } from './sampling';
import type { ProblemListItem } from '../shared/learning';
import { parseCompanyFile } from './company';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const id = (value: unknown): string => { if (typeof value !== 'string' || !value.trim() || value.length > 512 || value.includes('\0')) throw new Error('标识无效。'); return value; };
const codeText = (value: unknown): string => { if (typeof value !== 'string' || Buffer.byteLength(value) > 512 * 1024 || value.includes('\0')) throw new Error('代码需要是不超过 512 KiB 的文本。'); return value; };
const iso = (at: number) => new Date(at).toISOString();
export interface InterviewClock { wall(): number; monotonic(): number; }
export interface InterviewServiceOptions { store(): PracticeStore; clock?: InterviewClock; beforeStart?(pool: InterviewPool): Promise<void>; changed?(): void; }
const strictChannels = new Set(['interview:state','interview:start','interview:get','interview:save','interview:finish','interview:coach','interview:run','runner:cancel','ai:cancel']);
export class InterviewService {
  #clock: InterviewClock; #base: { id: string; wall: number; mono: number } | null = null; #previews = new Map<string, InterviewPool>(); #companyPreviews = new Map<string, CompanyPreview>();
  #starting = false; #epoch = 0; #sleeping = false;
  constructor(private readonly options: InterviewServiceOptions) { this.#clock = options.clock ?? { wall: Date.now, monotonic: () => performance.now() }; this.tick(); }
  get epoch() { return this.#epoch; }
  get starting() { return this.#starting; }
  active() { this.tick(); return this.options.store().getActiveInterview(); }
  assertChannel(channel: string, args: unknown[] = []) {
    const active = this.active();
    if (this.#starting && !['interview:state','ai:cancel','runner:cancel'].includes(channel)) throw new Error('正在准备面试，请稍候。');
    if (active?.mode === 'strict' && !strictChannels.has(channel)) throw new Error('严格面试进行中，不能访问旧答案、笔记、标签或解题帮助。');
    if (active && ['backup:restore','interview:preview','company:preview','company:commit','company:select-file','company:complete'].includes(channel)) throw new Error('请先结束当前面试。');
    if (active && ['interview:get','interview:save','interview:finish','interview:coach','interview:run'].includes(channel) && args[0] !== active.id) throw new Error('只能访问当前面试。');
    // Legacy workbench/restore/patch entry points cannot mutate an interview-owned scope or final snapshot.
    if (['draft:save','practice:start','practice:workspace','draft:load','run:history','runner:run'].includes(channel)) {
      const scope = channel === 'draft:save' || channel === 'runner:run' ? args[3] : args[2];
      if (typeof scope === 'string' && /^(interview|interview-recap):/.test(scope)) throw new Error('面试草稿请通过面试工作台操作。');
    }
    if (channel === 'ai:apply-patch' && typeof args[0] === 'string') { const request = this.options.store().getAIRequest(args[0]); if (request && this.options.store().getInterviewForAttempt(request.attemptId)) throw new Error('面试代码修改必须通过面试工作台确认保存。'); }
    if (channel === 'practice:finish' && typeof args[0] === 'string' && this.options.store().getInterviewForAttempt(args[0])) throw new Error('请在面试工作台统一结束本场。');
  }
  assertResponse(channel: string, args: unknown[], epoch: number) { this.assertChannel(channel,args); if (epoch !== this.#epoch && !channel.startsWith('interview:')) throw new Error('面试状态已变化，旧页面响应已隔离。'); }
  assertAiContext(context: AiTrustedContext): AiTrustedContext {
    const active = this.active(); if (this.#starting || active?.mode === 'strict') return { ...context, mode: 'strict', isActive: true };
    const interview = this.options.store().getInterviewForAttempt(context.attemptId);
    return interview ? { ...context, mode: interview.mode, isActive: !interview.endedAt } : context;
  }
  preview(input: InterviewRules): { id: string; pool: InterviewPool } {
    if (this.active() || this.#starting) throw new Error('已有面试正在进行。'); const store = this.options.store();
    const rules = validateRules(input), dataset = store.listCompanyDatasets().find(d => d.id === rules.datasetId) ?? null;
    const problems: ProblemListItem[] = [];
    // Read every metadata page. Language/exclusion checks stay in buildPool so no candidate disappears silently.
    for (let offset = 0;; offset += 100) {
      const page = store.listProblemPage({ offset, limit: 100 }); problems.push(...page.items);
      if (!page.hasMore) break;
    }
    const pool = buildPool(problems,store.listAttemptDates(),rules,dataset,iso(this.#clock.wall())); const key = randomUUID();
    if (this.#previews.size >= 20) this.#previews.delete(this.#previews.keys().next().value!); this.#previews.set(key,pool); return { id:key, pool:structuredClone(pool) };
  }
  previewCompany(input: {kind:'csv'|'json';text:string;name:string}) { const result = parseCompanyFile(input,new Set(this.options.store().listProblemIds()),iso(this.#clock.wall())); const key = randomUUID(); if(this.#companyPreviews.size>=10) this.#companyPreviews.delete(this.#companyPreviews.keys().next().value!); this.#companyPreviews.set(key,result); return {id:key,preview:structuredClone(result)}; }
  commitCompany(key: string) { const preview = this.#companyPreviews.get(id(key)); if (!preview) throw new Error('导入预览已失效。'); if (preview.errors.length || !preview.dataset.entries.length) throw new Error('请修正文件错误后重新预览。'); const dataset = this.options.store().saveCompanyDataset(preview.dataset); this.options.changed?.(); return dataset; }
  async start(previewId: string, requestId: string): Promise<InterviewView> {
    id(requestId); const store = this.options.store(); const existing = store.listInterviews().find(s => s.requestId === requestId);
    const pool = this.#previews.get(id(previewId));
    if (existing) { if (pool && canonicalJson(pool) !== canonicalJson(existing.pool)) throw new Error('面试请求标识冲突。'); return this.view(existing.id); }
    if (this.active() || this.#starting) throw new Error('已有面试正在进行。'); if (!pool || Date.parse(pool.evaluatedAt) < this.#clock.wall()-600000) throw new Error('题池预览已失效，请重新检查。');
    if(pool.shortages.length || !pool.selectedIds.length) throw new Error(pool.shortages.join('\n') || '没有可用题目。');
    this.#starting = true; this.#epoch++;
    try {
      await this.options.beforeStart?.(structuredClone(pool));
      const now = this.#clock.wall(), sessionId = randomUUID();
      const session: InterviewSession = { id:sessionId, requestId, pool:structuredClone(pool), initialMode:pool.rules.mode, mode:pool.rules.mode, startedAt:iso(now), deadlineAt:iso(now+pool.rules.durationMinutes*60000), lastObservedAt:iso(now), endedAt:null, endReason:null, clockAnomalies:[], modeChanges:[], help:[],
        items:pool.selectedIds.map(problemId => {
          const candidate = pool.candidates.find(c => c.problem.id === problemId)!.problem;
          // Existing P4 pools may embed complete snapshots. New pools pin metadata versions and load only selected bodies.
          const problem = 'capabilities' in candidate ? store.getProblem(problemId, candidate.version) : candidate;
          if (!problem) throw new Error('预览中的题面版本已不可用，请重新检查题池。');
          const code=problem.content.starter[pool.rules.language]??'';return {problem,attemptId:randomUUID(),scopeId:`interview:${sessionId}`,accepted:{code,codeHash:hash(code),revision:1,savedAt:iso(now),reasoning:''},final:null}; }) };
      store.createInterview(session); this.#base={id:sessionId,wall:now,mono:this.#clock.monotonic()}; this.options.changed?.(); return this.view(sessionId);
    } finally { this.#starting=false; }
  }
  suspend(): void { this.tick(); this.#sleeping = true; }
  tick(resumed = false): void {
    const wokeFromSleep = resumed || this.#sleeping; if (resumed) this.#sleeping = false;
    const store=this.options.store(), session=store.getActiveInterview(); if(!session){this.#base=null;return;}
    const wall=this.#clock.wall(),mono=this.#clock.monotonic(); let effective=wall; let anomaly:string|null=null;
    if(!this.#base || this.#base.id!==session.id){ if(wall<Date.parse(session.lastObservedAt)-2000) anomaly='重启后系统时间早于上次已保存时间'; this.#base={id:session.id,wall:Math.max(wall,Date.parse(session.lastObservedAt)),mono}; }
    else {
      const monotonicWall=this.#base.wall+Math.max(0,mono-this.#base.mono); effective=Math.max(wall,monotonicWall);
      if(wall<monotonicWall-5000) anomaly='系统时间向后变化';
      else if(wall>monotonicWall+5000 && !wokeFromSleep) anomaly='系统时间向前变化或计时来源不一致';
      if(wokeFromSleep) this.#base={id:session.id,wall:effective,mono};
    }
    if(anomaly){session.clockAnomalies.push(`${iso(wall)} ${anomaly}`);this.#freeze(session,'clock-anomaly',Math.min(effective,Date.parse(session.deadlineAt)));return;}
    if(effective>=Date.parse(session.deadlineAt)){this.#freeze(session,'deadline',Date.parse(session.deadlineAt));return;}
    if(effective-Date.parse(session.lastObservedAt)>=5000){session.lastObservedAt=iso(effective);store.updateInterview(session);}
  }
  #now() { const wall=this.#clock.wall(); return this.#base ? Math.max(wall,this.#base.wall+Math.max(0,this.#clock.monotonic()-this.#base.mono)) : wall; }
  #session(key:string){const result=this.options.store().getInterview(id(key));if(!result)throw new Error('面试不存在。');return result;}
  #freeze(session:InterviewSession,reason:NonNullable<InterviewSession['endReason']>,at:number){if(session.endedAt)return session;session.endedAt=iso(Math.max(Date.parse(session.startedAt),at));session.endReason=reason;session.lastObservedAt=iso(Math.max(Date.parse(session.lastObservedAt),at));for(const item of session.items)item.final=structuredClone(item.accepted);const result=this.options.store().freezeInterview(session);this.#base=null;this.options.changed?.();return result;}
  finish(key:string){this.tick();const session=this.#session(key);if(!session.endedAt)this.#freeze(session,'manual',this.#now());return this.view(key);}
  coach(key:string){this.tick();const session=this.#session(key);if(session.endedAt)throw new Error('本场已经结束。');if(session.mode==='strict'){session.mode='coached';session.modeChanges.push({at:iso(this.#now()),from:'strict',to:'coached'});this.options.store().updateInterview(session);this.#epoch++;this.options.changed?.();}return this.view(key);}
  save(key:string,problemId:string,code:unknown,reasoning:unknown):InterviewSaveResult {
    this.tick();const session=this.#session(key),item=session.items.find(i=>i.problem.id===id(problemId));if(!item)throw new Error('题目不属于本场。'); const content=codeText(code);
    if(typeof reasoning!=='string'||reasoning.length>12000)throw new Error('思路记录最多 12000 字。');const store=this.options.store(),language=session.pool.rules.language;
    const recap=()=>{store.saveDraft({problemId,language,scopeId:`interview-recap:${session.id}:reasoning`,code:reasoning});return store.saveDraft({problemId,language,scopeId:`interview-recap:${session.id}`,code:content});};
    if(session.endedAt)return {counted:false,answer:item.final!,recap:recap()};
    // First commit the actual code; only then take the trusted completion time. A late commit never enters accepted.
    const draft=store.saveDraft({problemId,language,scopeId:item.scopeId,code:content}); const completedAt=this.#now(); this.tick();
    const fresh=this.#session(key);
    if(fresh.endedAt||completedAt>=Date.parse(session.deadlineAt)){if(!fresh.endedAt)this.#freeze(fresh,'deadline',Date.parse(session.deadlineAt));return {counted:false,answer:fresh.items.find(i=>i.problem.id===problemId)!.accepted,recap:recap()};}
    const answer:InterviewAnswer={code:content,codeHash:draft.codeHash,revision:draft.revision,savedAt:iso(completedAt),reasoning};fresh.items.find(i=>i.problem.id===problemId)!.accepted=answer;fresh.lastObservedAt=iso(completedAt);store.updateInterview(fresh);
    // Include bookkeeping commit latency in the acknowledgement boundary too.
    if(this.#now()>=Date.parse(session.deadlineAt)){fresh.items.find(i=>i.problem.id===problemId)!.accepted=item.accepted;store.updateInterview(fresh);this.#freeze(fresh,'deadline',Date.parse(session.deadlineAt));return {counted:false,answer:item.accepted,recap:recap()};}
    return {counted:true,answer,recap:null};
  }
  runTarget(key:string,problemId:string,supplement:boolean){this.tick();const session=this.#session(key),item=session.items.find(i=>i.problem.id===id(problemId));if(!item)throw new Error('题目不属于本场。');if(Boolean(session.endedAt)!==supplement)throw new Error(session.endedAt?'面试已结束，请选择冻结快照补测。':'本场尚未结束。');return {session,item,code:(supplement?item.final!:item.accepted).code};}
  recordHelp(kind:string,reference:string|null){const active=this.active();if(!active||active.mode!=='coached')return; const last=active.help.at(-1);if(last?.kind===kind&&last.reference===reference)return;active.help.push({at:iso(this.#now()),kind,reference});this.options.store().updateInterview(active);}
  addReview(key:string,problemId:string){this.tick();const session=this.#session(key);if(!session.endedAt||!session.items.some(i=>i.problem.id===id(problemId)))throw new Error('请先结束本场，再加入复习。');return this.options.store().addReviewItem({problemId,language:session.pool.rules.language,target:'rewrite'});}
  view(key:string):InterviewView {
    this.tick();const session=this.#session(key),store=this.options.store();const active=store.getActiveInterview();if(active?.mode==='strict'&&active.id!==key)throw new Error('严格模式无法访问历史面试。');
    const items=session.items.map(item=>({item,attempt:store.getAttempt(item.attemptId)!,draft:store.getDraft(item.problem.id,session.pool.rules.language,item.scopeId)??null,runs:store.listRuns(item.attemptId),aiHelp:store.listAIRequests(item.attemptId).map(request=>({requestId:request.id,level:request.snapshot.level,status:request.status,createdAt:request.createdAt,finishedAt:request.finishedAt,duringSession:request.status==='completed'&&Boolean(request.finishedAt)&&(!session.endedAt||Date.parse(request.finishedAt!)<=Date.parse(session.endedAt))})),recap:store.getDraft(item.problem.id,session.pool.rules.language,`interview-recap:${session.id}`)??null,recapReasoning:store.getDraft(item.problem.id,session.pool.rules.language,`interview-recap:${session.id}:reasoning`)?.code??null}));
    const result:InterviewView={session,items,remainingMs:session.endedAt?0:Math.max(0,Date.parse(session.deadlineAt)-this.#now())};
    if(!session.endedAt&&session.mode==='strict'){
      session.pool={...session.pool,rules:{...session.pool.rules,tags:[],company:null,datasetId:null},candidates:[],dataset:null,exclusions:[]};
      for(const item of session.items)item.problem.content.tags=[];
      for(const entry of items){const snapshot=entry.attempt.problemSnapshot as Record<string,unknown>;entry.attempt={...entry.attempt,problemSnapshot:{...snapshot,tags:[]} as never};entry.recap=null;entry.recapReasoning=null;}
    }
    return result;
  }
  state(){const active=this.active();return {active:active?this.view(active.id):null,history:active?.mode==='strict'?[]:this.options.store().listInterviews().filter(s=>s.endedAt).map(s=>({id:s.id,mode:s.mode,startedAt:s.startedAt,endedAt:s.endedAt,count:s.items.length,anomalous:s.clockAnomalies.length>0})),datasets:active?.mode==='strict'?[]:this.options.store().listCompanyDatasets()};}
}
