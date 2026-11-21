import { useEffect, useState } from 'react';
import { LANGUAGES, languageLabel } from '../shared/languages';
import type { DesktopBridge, Page } from '../shared/bridge';
import type { InterviewRules, InterviewPool, CompanyPreview } from '../shared/interview';
import { defaultInterviewRules, RECENT_PRACTICE_EXCLUSION } from '../shared/interview';
import { readPracticeMemory } from './practice-memory';
import type { StudyList } from '../shared/library';
import { dateTime, errorText, PageIntro } from './ui';
import { flushPendingSaves, setEditsFrozen } from './pending-saves';
import { InterviewWorkbench } from './InterviewWorkbench';
import { HelpHint } from './HelpHint';

type State = Awaited<ReturnType<DesktopBridge['interviewState']>>;
/** Titles first: a problem the user cannot recognize is no help in deciding what to change. */
function exclusionGroups(pool: InterviewPool) {
  const groups = new Map<string, string[]>();
  for (const item of pool.exclusions) groups.set(item.reason, [...(groups.get(item.reason) ?? []), item.title ?? item.problemId]);
  return [...groups].sort((a, b) => b[1].length - a[1].length);
}
const NO_LISTS: StudyList[] = [];
export function InterviewPage({api,lists=NO_LISTS,onError,onNavigate}:{api:DesktopBridge|undefined;lists?:StudyList[];onError:(message:string)=>void;onNavigate:(page:Page)=>void}) {
  const [state,setState]=useState<State>({active:null,history:[],datasets:[]});
  const [rules,setRules]=useState<InterviewRules>(()=>({...defaultInterviewRules,language:readPracticeMemory().language,counts:{...defaultInterviewRules.counts},seed:crypto.randomUUID()}));
  const [tagText,setTagText]=useState(()=>defaultInterviewRules.tags.join(','));
  const [preview,setPreview]=useState<{id:string;pool:InterviewPool}|null>(null), [company,setCompany]=useState<{id:string;preview:CompanyPreview}|null>(null);
  const [selected,setSelected]=useState(''),[busy,setBusy]=useState(''),[message,setMessage]=useState('');
  const [companyText,setCompanyText]=useState(''),[companyFormat,setCompanyFormat]=useState<'csv'|'json'>('csv');
  async function load(){if(api)setState(await api.interviewState());}
  useEffect(()=>{void load().catch(e=>onError(errorText(e)));},[api]);
  const act=async(name:string,operation:()=>Promise<unknown>)=>{if(busy)return;setBusy(name);setMessage('');try{await operation();}catch(e){onError(errorText(e));}finally{setBusy('');}};
  const update=<K extends keyof InterviewRules>(key:K,value:InterviewRules[K])=>{setRules(r=>({...r,[key]:value}));setPreview(null);};
  const dataset=state.datasets.find(d=>d.id===rules.datasetId);
  // A list removed while this page was open must not stay selected as an invisible scope.
  useEffect(()=>{if(rules.listId&&!lists.some(list=>list.id===rules.listId)){setRules(r=>({...r,listId:null}));setPreview(null);}},[lists,rules.listId]);
  const check=(next:InterviewRules)=>act('preview',async()=>{if(api)setPreview(await api.previewInterview(next));});
  const recentlyPracticed=preview?.pool.exclusions.filter(item=>item.reason===RECENT_PRACTICE_EXCLUSION).length??0;
  if(selected&&api)return <InterviewWorkbench api={api} sessionId={selected} onLeave={()=>{setSelected('');void load();}} />;
  return <section className="interview-page scroll-page"><PageIntro tone="red" icon="timer" title="模拟面试" description="按规则抽题、限时作答，模拟完整面试。" />
    {state.active&&<div className="interview-resume"><div><strong>有一场面试正在进行</strong><p>计时不会因为离开此页而暂停。</p></div><button className="button primary" onClick={()=>location.reload()}>回到本场面试</button></div>}
    {message&&<p role="status" className="success-text">{message}</p>}
    <div className="interview-setup"><form onSubmit={e=>{e.preventDefault();void check(rules);}}>
      <div className="heading-with-help"><h3>本场规则</h3><HelpHint label="面试模式说明">严格模式仅开放题面、代码和本地测试。中途可转为辅导模式，转换记录会永久保留。</HelpHint></div>
      <div className="interview-scope"><label>题目范围<select aria-label="题目范围" value={rules.listId??''} disabled={Boolean(busy||state.active)} onChange={e=>update('listId',e.target.value||null)}><option value="">全部题库</option>{lists.map(list=><option key={list.id} value={list.id}>{list.title} · {new Set(list.items.map(item=>item.problemId)).size} 题</option>)}</select></label>
        <p className="field-help">{rules.listId?'只从这张题单里抽题，数量不够时不会用其他题目补。':'想用一张力扣题单组卷？先导入题单，再回到这里选择它。'}<button type="button" className="text-button" onClick={()=>onNavigate('sources')}>导入题单</button></p></div>
      <div className="interview-fields"><label>面试模式<select aria-label="面试模式" value={rules.mode} disabled={Boolean(busy||state.active)} onChange={e=>update('mode',e.target.value as InterviewRules['mode'])}><option value="strict">严格模式</option><option value="coached">辅导模式</option></select></label>
      <label>作答语言<select aria-label="面试语言" value={rules.language} disabled={Boolean(busy||state.active)} onChange={e=>update('language',e.target.value as InterviewRules['language'])}>{LANGUAGES.map(language => <option key={language} value={language}>{languageLabel(language)}</option>)}</select></label>
      <label>时长（分钟）<input aria-label="面试时长" type="number" min={1} max={240} value={rules.durationMinutes} onChange={e=>update('durationMinutes',Number(e.target.value))} /></label></div>
      <fieldset className="interview-counts"><legend>难度与题数 · 合计最多 10 道</legend>{(['easy','medium','hard'] as const).map(tier=><label key={tier} data-tier={tier}>{{easy:'简单',medium:'中等',hard:'困难'}[tier]}<input aria-label={`${{easy:'简单',medium:'中等',hard:'困难'}[tier]}题数`} type="number" min={0} max={10} value={rules.counts[tier]} onChange={e=>update('counts',{...rules.counts,[tier]:Number(e.target.value)})} /></label>)}</fieldset>
      <label className="p3-field">主题（任选其一，逗号分隔）<input value={tagText} placeholder="留空为全部主题" onChange={e=>{setTagText(e.target.value);update('tags',e.target.value.split(/[,，]/).map(t=>t.trim()).filter(Boolean));}} /></label>
      <details className="interview-advanced"><summary>高级选项 · 排除近期、企业与抽样</summary><div className="interview-fields"><label>排除最近几天练习题<input aria-label="排除近期天数" type="number" min={0} max={365} value={rules.excludeRecentDays} onChange={e=>update('excludeRecentDays',Number(e.target.value))} /></label><label>企业数据集<select aria-label="企业数据集" value={rules.datasetId??''} onChange={e=>{setRules(r=>({...r,datasetId:e.target.value||null,company:null}));setPreview(null);}}><option value="">不限定企业</option>{state.datasets.map(d=><option key={d.id} value={d.id}>{d.name} · {d.fileHash.slice(0,8)}</option>)}</select></label>
      <label>企业<select aria-label="筛选企业" value={rules.company??''} disabled={!dataset} onChange={e=>update('company',e.target.value||null)}><option value="">不限定</option>{[...new Set(dataset?.entries.map(e=>e.normalizedCompany)??[])].map(c=><option key={c}>{c}</option>)}</select></label>
      <label>抽样方式<select aria-label="抽样方式" value={rules.sampling} onChange={e=>update('sampling',e.target.value as InterviewRules['sampling'])}><option value="uniform">按约束均匀抽样</option><option value="frequency">来源频率优先</option></select></label>
      <label>抽样种子<input aria-label="抽样种子" value={rules.seed} maxLength={200} onChange={e=>update('seed',e.target.value)} /></label></div></details>

      <button className="button primary" disabled={!api||Boolean(busy||state.active)} type="submit">{busy==='preview'?'正在检查…':'检查本场题池'}</button>
    </form><aside className="interview-pool" aria-label="题池检查"><div className="heading-with-help"><h3>题池检查</h3><HelpHint label="题池筛选说明">仅链接、缺少语言适配或用例的题目不会入选。题池预览保留 10 分钟；相同题池、规则和种子可复现题序。</HelpHint></div>{preview?<>{preview.pool.scope&&<p className="interview-scope-summary">《{preview.pool.scope.title}》共 {preview.pool.scope.total} 题{preview.pool.scope.cached<preview.pool.scope.total?`，其中 ${preview.pool.scope.total-preview.pool.scope.cached} 题还没有缓存到本机，不能抽取`:''}</p>}
      <p className="interview-pool-count"><strong>{preview.pool.candidates.length}</strong> 道符合条件的 {languageLabel(preview.pool.rules.language)} 题目</p>{preview.pool.shortages.length?<div role="alert" className="interview-shortages"><h4>题池数量不足</h4>{preview.pool.shortages.map(text=><p key={text}>{text}</p>)}
        {recentlyPracticed>0?<><p>有 {recentlyPracticed} 道题因为最近 {preview.pool.rules.excludeRecentDays} 天内练过而没有入选。</p><button type="button" className="button" disabled={Boolean(busy||state.active)} onClick={()=>{const next={...rules,excludeRecentDays:0};setRules(next);void check(next);}}>包含近期练过的题，重新检查</button></>:<p>可以减少题数、放宽难度或主题{preview.pool.scope?'，或换一个题目范围':''}，然后重新检查。</p>}</div>:<><p>本场抽取 {preview.pool.selectedIds.length} 道，持续 {rules.durationMinutes} 分钟。</p><button className="button primary" disabled={Boolean(busy||state.active)||!api} onClick={()=>{void act('start',async()=>{if(!api)return;await flushPendingSaves();setEditsFrozen(true,'interview-start');try{await api.startInterview(preview.id,crypto.randomUUID());location.reload();}finally{setEditsFrozen(false,'interview-start');}});}}>{busy==='start'?'正在进入面试…':'开始本场面试'}</button></>}
      {preview.pool.exclusions.length>0&&<details className="interview-exclusions"><summary>未入选的题目（{preview.pool.exclusions.length}）</summary><ul>{exclusionGroups(preview.pool).map(([reason,titles])=><li key={reason}><strong>{reason.replace(/[。.]$/,'')}</strong> · {titles.length} 题<p>{titles.slice(0,8).join('、')}{titles.length>8?` 等 ${titles.length} 题`:''}</p></li>)}</ul></details>}</>:<><p>请先检查题池</p><button className="text-button" onClick={()=>onNavigate('library')}>查看题库</button></>}</aside></div>
    <details className="interview-company"><summary>企业题单数据（可选）· 需要按企业或出现频率抽题时导入 CSV / JSON</summary>
      <div className="compact-actions"><button className="button" disabled={!api||Boolean(busy||state.active)} onClick={()=>{void act('company-file',async()=>{if(!api)return;const file=await api.selectCompanyFile();if(file){setCompanyText(file.text);setCompanyFormat(file.kind);setCompany(await api.previewCompany(file));}});}}>选择本机企业文件</button><HelpHint label="企业题单格式说明">企业名称和题目 URL 或 problemId 必填。数据日期、统计窗口及频率口径未知时可留空；导入时间不代表数据更新时间。</HelpHint><label>文本格式<select value={companyFormat} onChange={e=>{setCompanyFormat(e.target.value as 'csv'|'json');setCompany(null);}}><option value="csv">CSV</option><option value="json">JSON</option></select></label></div>
      <label className="p3-field">或粘贴企业数据<textarea aria-label="企业数据文本" value={companyText} placeholder={'company,url,dataDate,window,frequency,frequencyMeaning\n示例企业,https://leetcode.cn/problems/two-sum/,,,,'} onChange={e=>{setCompanyText(e.target.value);setCompany(null);}} /></label><button className="button" disabled={!api||!companyText.trim()||Boolean(busy||state.active)} onClick={()=>{void act('company-preview',async()=>{if(api)setCompany(await api.previewCompany({kind:companyFormat,text:companyText,name:'粘贴的企业题单'}));});}}>预览企业数据</button>
      {company&&<div className="interview-company-preview"><p>{company.preview.dataset.entries.length} 条有效记录 · 去除 {company.preview.duplicates} 条完全重复记录 · {company.preview.missingProblemIds.length} 道尚未入库</p>{company.preview.errors.map(text=><p role="alert" className="error-text" key={text}>{text}</p>)}<div className="interview-table-scroll"><table><thead><tr><th>原公司名 → 归一名</th><th>题目</th><th>数据日期 / 窗口</th><th>频率 / 口径</th></tr></thead><tbody>{company.preview.dataset.entries.slice(0,100).map((e,i)=><tr key={i}><td>{e.company} → {e.normalizedCompany}</td><td>{e.problemId}</td><td>{e.dataDate??'未知'} / {e.window??'未知'}</td><td>{e.frequency??'未知'} / {e.frequencyMeaning??'未知'}</td></tr>)}</tbody></table></div>{company.preview.dataset.entries.length>100&&<p className="field-help">预览显示前 100 条，确认后保存全部有效记录。</p>}<div className="compact-actions"><button className="button primary" disabled={Boolean(busy)||company.preview.errors.length>0} onClick={()=>{void act('company-commit',async()=>{if(!api)return;const result=await api.commitCompany(company.id);await load();setMessage(`已保存 ${result.name}。`);});}}>确认导入企业数据</button>{company.preview.dataset.entries.some(entry=>entry.url)&&<button className="text-button" disabled={Boolean(busy)||!state.datasets.some(d=>d.id===company.preview.dataset.id)} onClick={()=>{void act('company-complete',async()=>{if(!api)return;await api.completeCompanyProblems(company.preview.dataset.id,crypto.randomUUID());onNavigate('sources');});}}>补全题面与适配</button>}</div></div>}
    </details>
    <section className="interview-history"><h3>面试档案</h3>{state.history.length?<div className="study-list">{state.history.map(row=><button className="study-row" key={row.id} onClick={()=>setSelected(row.id)}><span>{dateTime(row.startedAt)}</span><span>{row.mode==='strict'?'严格':'辅导'} · {row.count} 道题{row.anomalous?' · 计时异常':''}</span><span>查看报告 →</span></button>)}</div>:<p className="field-help">暂无面试档案</p>}</section>
  </section>;
}
