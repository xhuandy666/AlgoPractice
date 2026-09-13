import { useEffect, useState } from 'react';
import { App } from './App';
import { InterviewWorkbench } from './InterviewWorkbench';
import { errorText } from './ui';
export function DesktopRoot(){
  const api=window.algo;const [state,setState]=useState<'loading'|'normal'|string>(api?'loading':'normal'),[error,setError]=useState('');
  useEffect(()=>{if(api)void api.interviewState().then(s=>setState(s.active?.session.id??'normal')).catch(e=>setError(errorText(e)));},[api]);
  if(state==='normal')return <App/>;
  if(state==='loading')return <main className="scroll-page"><p role="status">正在读取本机状态…</p>{error&&<p role="alert">{error}</p>}</main>;
  return <div className="interview-shell"><header className="interview-shell-header"><span className="wordmark"><span className="brand-symbol">a.</span>题炼</span><span>文本模拟面试 · 本机存储</span></header><InterviewWorkbench api={api!} sessionId={state} onLeave={()=>{sessionStorage.setItem('algo-page','interview');location.reload();}}/></div>;
}
