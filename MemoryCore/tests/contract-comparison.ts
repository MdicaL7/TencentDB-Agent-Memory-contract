/** Same synthetic messages/model/parameters, different extraction prompt families. */
import {readFileSync,writeFileSync} from 'node:fs';
import YAML from 'yaml';
import {getExtractMemoriesSystemPrompt} from '../src/core/prompts/l1-extraction.js';
import {CONTRACT_L1_PROMPT,CONTRACT_PROMPT_VERSION} from '../src/contract-memory/prompts.js';
const cfg=YAML.parse(readFileSync(process.argv[2],'utf8')).llm;
const messages=[{id:'msg-60-days',role:'user',content:'合同 A 这次我提出可以接受60天账期，但必须收取20%预付款，仅限本项目。这是我的意见，没有正式审批。'},{id:'msg-style',role:'user',content:'以后给我的报告请先列风险，再列依据，最后列建议。'},{id:'msg-draft',role:'assistant',content:'我建议接受60天账期，并可以生成建议稿。目前没有实际保存回执。'}];
const input={messages,prior_records:[]};
const results:any={model:cfg.model,prompt_version:CONTRACT_PROMPT_VERSION,input,recorded_at:new Date().toISOString()};
for(const mode of ['code','contract'] as const){const prompt=mode==='code'?getExtractMemoriesSystemPrompt('code'):CONTRACT_L1_PROMPT;const response=await fetch(cfg.baseUrl.replace(/\/$/,'')+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+cfg.apiKey},signal:AbortSignal.timeout(120000),body:JSON.stringify({model:cfg.model,messages:[{role:'system',content:prompt},{role:'user',content:JSON.stringify(input)}],thinking:{type:'disabled'},temperature:0,max_tokens:8000})});if(!response.ok)throw new Error('LLM HTTP '+response.status);const r:any=await response.json();const output=r.choices[0].message.content;results[mode]={output:JSON.parse(output.replace(/^\s*```(?:json)?\s*/,'').replace(/\s*```\s*$/,'')),finish_reason:r.choices[0].finish_reason,usage:r.usage};}
const serialized=JSON.stringify(results.contract.output);results.contract_checks={preserves_sixty_days:serialized.includes('60'),preserves_prepayment:serialized.includes('20%'),preserves_project_limit:serialized.includes('本项目'),structured_conditions:Array.isArray(results.contract.output.records?.[0]?.conditions),no_formal_approval:results.contract.output.records?.every((r:any)=>!['approved','executed'].includes(r.business_state)),assistant_suggestion:results.contract.output.records?.some((r:any)=>r.kind==='agent_suggestion')};
writeFileSync(process.argv[3],JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(results.contract_checks));
