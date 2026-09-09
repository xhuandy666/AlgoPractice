import test from 'node:test';
import assert from 'node:assert/strict';
import { previewImport } from '../../src/source/index.ts';
import { runCode } from '../../src/runner/index.ts';
import type { Adapter, RunRequest } from '../../src/runner/types.ts';

for(const language of ['python','java'] as const){
 test(`${language}: explicit void JSON adapter compares changed array and empty array`,async()=>{
  const file={id:'void-array',title:'Original in-place sort',description:'Sort the supplied array in place.',mode:'function',adapter:{method:'solve',params:[{array:'int'}],returns:'void',inPlaceArg:0},cases:[{args:[[3,1,2]],expected:[1,2,3]},{args:[[]],expected:[]}],starter:{python:'class Solution:\n    def solve(self,x):\n        x.sort()',java:'class Solution {public void solve(int[] x){Arrays.sort(x);}}'}};
  const preview=await previewImport({kind:'json',text:JSON.stringify([file])});assert.equal(preview.complete,true,JSON.stringify(preview.errors));const content=preview.items[0].content!;assert.equal(content.adapter!.returns,'void');
  const request:RunRequest={language,mode:'function',code:content.starter[language]!,adapter:content.adapter,cases:content.cases};
  const result=await runCode(request);assert.equal(result.status,'passed',JSON.stringify(result));assert.deepEqual(result.caseResults.map(c=>c.actual),[[1,2,3],[]]);
  request.cases=[{args:[[3,1,2]],expected:[3,1,2]}];assert.equal((await runCode(request)).status,'wrong_answer','Must compare the mutated parameter rather than a void return');
 });
 test(`${language}: explicit void list adapter observes fixed interval and remains unjudged without expected`,async()=>{
  const adapter:Adapter={method:'solve',params:[{list:'string'}],returns:'void',inPlaceArg:0,inPlaceRange:{start:1,end:3}};
  const result=await runCode({language,mode:'function',adapter,code:language==='python'?'class Solution:\n    def solve(self,x):\n        x.reverse()':'class Solution {public void solve(List<String> x){Collections.reverse(x);}}',cases:[{args:[['a','b','c','d']],expected:['c','b']},{args:[['a','b','c','d']]}]});
  assert.equal(result.status,'completed',JSON.stringify(result));assert.deepEqual(result.caseResults.map(c=>c.status),['passed','completed']);assert.deepEqual(result.caseResults.map(c=>c.actual),[['c','b'],['c','b']]);
 });
}
const invalidAdapters=[
 {method:'solve',params:[{array:'int'}],returns:'void'},
 {method:'solve',params:['int'],returns:'void',inPlaceArg:0},
 {method:'solve',params:['void'],returns:'void',inPlaceArg:0},
 {method:'solve',params:[{array:'void'}],returns:'void',inPlaceArg:0},
 {method:'solve',params:[{array:'int'}],returns:'void',inPlaceArg:0,inPlaceRange:{end:'return'}},
 {method:'solve',params:[{array:'int'}],returns:'void',inPlaceArg:2},
];
test('void is rejected without a valid observed collection, and cannot provide a return-derived prefix',async()=>{
 for(const adapter of invalidAdapters){const result=await runCode({language:'python',mode:'function',code:'',adapter:adapter as Adapter,cases:[{args:[[]]}]});assert.equal(result.status,'invalid_request',JSON.stringify(adapter));}
});
test('JSON import rejects ambiguous void, void inputs and invalid observation bounds',async()=>{
 for(const adapter of invalidAdapters){const result=await previewImport({kind:'json',text:JSON.stringify([{title:'Original invalid fixture',description:'Original',adapter,cases:[{args:[[]]}]}])});assert.equal(result.complete,false,JSON.stringify(adapter));assert.equal(result.items.length,0);assert.equal(result.errors[0].code,'INVALID_IMPORT');}
});
