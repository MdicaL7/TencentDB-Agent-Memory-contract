import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {resolveContractLlm,contractCompletion} from '../src/contract-memory/completion.js';
const fallback={baseUrl:'https://api.deepseek.com',apiKey:'dummy',model:'deepseek-flash'};
test('existing contract HTTP configuration is preserved without opt-in',()=>assert.deepEqual(resolveContractLlm(fallback,{}),fallback));
test('subscription config is contract-only and cannot use remote adapter or absent credential',()=>{
 const dir=mkdtempSync(join(tmpdir(),'contract-model-')),p=join(dir,'model.json');
 const save=(url:string)=>writeFileSync(p,JSON.stringify({roles:{memory_extraction:{provider:'codex_subscription',model:'gpt-6.1-sol',adapter_url:url}}}));
 save('http://host.docker.internal:8766/v1/structured-completions');
 assert.throws(()=>resolveContractLlm(fallback,{CONTRACT_MEMORY_MODEL_CONFIG:p}));
 const value=resolveContractLlm(fallback,{CONTRACT_MEMORY_MODEL_CONFIG:p,CONTRACT_EXTRACTION_ADAPTER_TOKEN:'private-test'});assert.equal(value.model,'gpt-6.1-sol');assert.equal(value.provider,'codex_subscription');assert.equal(fallback.model,'deepseek-flash');
 save('http://remote.example/v1/structured-completions');assert.throws(()=>resolveContractLlm(fallback,{CONTRACT_MEMORY_MODEL_CONFIG:p,CONTRACT_EXTRACTION_ADAPTER_TOKEN:'private-test'}));rmSync(dir,{recursive:true});
});
test('subscription sends extraction stage only and preserves unverified actual model metadata',async()=>{
 const cfg={...fallback,provider:'codex_subscription' as const,adapterUrl:'http://localhost:8766/v1/structured-completions',adapterToken:'dummy',model:'gpt-6.1-sol'};
 let sent:any;const fake:any=async(_url:any,init:any)=>{sent=JSON.parse(init.body);return new Response(JSON.stringify({status:'completed',request_id:'r1',output:{records:[]},metadata:{requested_model:cfg.model,actual_model:null,model_verified:false,role:'memory_extraction',stage:'l1'}}));};
 const result=await contractCompletion(cfg,'l1','contract prompt',{messages:[]},'r1',fake);
 assert.equal(sent.role,'memory_extraction');assert.equal(sent.stage,'l1');assert.equal(result.trace.actual_model,null);assert.deepEqual(result.output,{records:[]});
});
test('HTTP/model mismatch errors never fall back to another provider',async()=>{
 const cfg={...fallback,provider:'codex_subscription' as const,adapterUrl:'http://localhost:8766/v1/structured-completions',adapterToken:'dummy'};
 let calls=0;await assert.rejects(()=>contractCompletion(cfg,'l2','p',[],'r', (async()=>{calls++;return new Response('{}',{status:429});}) as any));assert.equal(calls,1);
 await assert.rejects(()=>contractCompletion(cfg,'l2','p',[],'r',(async()=>new Response(JSON.stringify({status:'completed',request_id:'other',output:{entries:[]}}))) as any));
});
test('API path records actual model and rejects truncated extraction',async()=>{
 let body:any;const fake:any=async(_url:any,init:any)=>{body=JSON.parse(init.body);return new Response(JSON.stringify({model:'deepseek-flash',choices:[{finish_reason:'stop',message:{content:'{"entries":[]}'}}]}));};
 const value=await contractCompletion(fallback,'l3','p',[],'r',fake);assert.deepEqual(body.thinking,{type:'disabled'});assert.equal(value.trace.actual_model,'deepseek-flash');
 await assert.rejects(()=>contractCompletion(fallback,'l1','p',[],'r',(async()=>new Response(JSON.stringify({choices:[{finish_reason:'length'}]}))) as any));
});
