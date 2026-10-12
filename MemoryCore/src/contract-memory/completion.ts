import {readFileSync} from 'node:fs';
export interface ContractLlm {baseUrl:string;apiKey:string;model:string;timeoutMs?:number;provider?:'openai_compatible'|'codex_subscription';adapterUrl?:string;adapterToken?:string}
/** Opt-in contract-only settings; code/chat and Proxy conversation configuration remain independent. */
export function resolveContractLlm(fallback:ContractLlm,env:NodeJS.ProcessEnv=process.env):ContractLlm {
  if(!env.CONTRACT_MEMORY_MODEL_CONFIG)return fallback;
  const config=JSON.parse(readFileSync(env.CONTRACT_MEMORY_MODEL_CONFIG,'utf8')).roles?.memory_extraction;
  if(!config?.model || !['codex_subscription','openai_compatible'].includes(config.provider))throw new Error('合同提炼模型配置无效');
  if(config.provider==='codex_subscription') {
    const token=env[config.token_env || 'CONTRACT_EXTRACTION_ADAPTER_TOKEN'];
    if(!config.adapter_url || !token)throw new Error('合同订阅模型适配器未配置');
    const url=new URL(config.adapter_url);
    if(!['127.0.0.1','localhost','host.docker.internal','::1','[::1]'].includes(url.hostname) || !['http:','https:'].includes(url.protocol))throw new Error('合同订阅适配器仅支持本机地址');
    return {...fallback,model:config.model,provider:'codex_subscription',adapterUrl:config.adapter_url,adapterToken:token,timeoutMs:(config.timeout_seconds ?? 180)*1000};
  }
  const key=env[config.api_key_env || 'DEEPSEEK_API_KEY'];
  if(!config.base_url || !key)throw new Error('合同 API 模型配置无效');
  return {...fallback,provider:'openai_compatible',baseUrl:config.base_url,apiKey:key,model:config.model,timeoutMs:(config.timeout_seconds ?? 180)*1000};
}
export async function contractCompletion(cfg:ContractLlm,stage:'l1'|'l2'|'l3'|'conflict',prompt:string,input:unknown,requestId:string,fetcher:typeof fetch=fetch) {
  if(cfg.provider==='codex_subscription') {
    const response=await fetcher(cfg.adapterUrl!,{method:'POST',headers:{Authorization:'Bearer '+cfg.adapterToken,'Content-Type':'application/json'},signal:AbortSignal.timeout((cfg.timeoutMs ?? 180000)+10000),body:JSON.stringify({role:'memory_extraction',model:cfg.model,stage,request_id:requestId,prompt,input})});
    if(!response.ok)throw new Error('合同订阅提炼失败 HTTP '+response.status);
    const result:any=await response.json();
    if(result.status!=='completed' || result.request_id!==requestId || result.metadata?.requested_model!==cfg.model || result.metadata?.role!=='memory_extraction' || result.metadata?.stage!==stage || !result.output)throw new Error('合同订阅提炼结果或模型标识不匹配');
    return {output:result.output,trace:{...result.metadata,request_id:requestId,finish_reason:'stop'}};
  }
  const response=await fetcher(cfg.baseUrl.replace(/\/$/,'')+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+cfg.apiKey,'Content-Type':'application/json'},signal:AbortSignal.timeout(cfg.timeoutMs ?? 120000),body:JSON.stringify({model:cfg.model,messages:[{role:'system',content:prompt},{role:'user',content:JSON.stringify(input)}],temperature:0,max_tokens:16000,...(new URL(cfg.baseUrl).hostname==='api.deepseek.com'?{thinking:{type:'disabled'}}:{})})});
  if(!response.ok)throw new Error('提炼模型响应失败 HTTP '+response.status);
  const result:any=await response.json(),choice=result.choices?.[0];
  if(choice?.finish_reason==='length')throw new Error('提炼输出达到长度上限，未发布候选');
  const output=JSON.parse((choice?.message?.content || '').replace(/^\s*```(?:json)?\s*/,'').replace(/\s*```\s*$/,''));
  return {output,trace:{provider:'openai_compatible',requested_model:cfg.model,actual_model:result.model ?? null,model_verified:!!result.model,request_id:requestId,stage,role:'memory_extraction',finish_reason:choice?.finish_reason,usage:result.usage ?? null}};
}
