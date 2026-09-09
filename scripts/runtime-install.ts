import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { installRuntime, recoverRuntimeInstallations } from '../src/runner/managed-runtime.ts';
import type { Language } from '../src/runner/types.ts';
export { installRuntime, recoverRuntimeInstallations } from '../src/runner/managed-runtime.ts';
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const args=process.argv.slice(2);let root=process.env.ALGOPRACTICE_RUNTIME_DIR ?? path.join(project,'.runtime'),localArchive:string|undefined,selected='all',recoverOnly=false;
  for(let i=0;i<args.length;i++){
    const flag=args[i];if(flag==='--recover'){recoverOnly=true;continue;}
    if(!['--root','--archive','--language'].includes(flag)||!args[i+1])throw new Error('Usage: runtime-install.ts [--root PATH] [--language python|java|all] [--archive FILE] [--recover]');
    const value=args[++i];if(flag==='--root')root=path.resolve(value);else if(flag==='--archive')localArchive=path.resolve(value);else selected=value;
  }
  if(!['python','java','all'].includes(selected))throw new Error('--language must be python, java, or all');
  if(localArchive&&selected==='all')throw new Error('--archive requires a single --language');
  const controller=new AbortController(),cancel=()=>controller.abort();process.on('SIGINT',cancel);
  try{
    const recovery=await recoverRuntimeInstallations(root);
    if(recoverOnly)console.log(JSON.stringify(recovery,null,2));
    else{
      const evidence=[];const languages:Language[]=selected==='all'?['python','java']:[selected as Language];
      for(const language of languages){let phase='';const result=await installRuntime(language,{root,localArchive,signal:controller.signal,onProgress:p=>{if(phase!==p.phase){phase=p.phase;console.error(`${language}: ${phase}`);}}});evidence.push(result);console.log(result.runtimeVersion);}
      await mkdir(path.join(project,'evidence'),{recursive:true});
      await writeFile(path.join(project,'evidence/runtime-install.json'),JSON.stringify(evidence,null,2)+'\n');
    }
  }finally{process.off('SIGINT',cancel);}
}
