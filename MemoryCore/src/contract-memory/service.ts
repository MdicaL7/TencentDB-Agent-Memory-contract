import {ContractV2} from './v2.js';
import { join } from 'node:path';
import { readdirSync, existsSync } from 'node:fs';
import { ContractStore, ContractError, hash, validateContent, type Identity } from './store.js';
import { CONTRACT_PROMPT_VERSION, CONTRACT_L1_PROMPT, CONTRACT_L2_PROMPT, CONTRACT_L3_PROMPT, CONTRACT_CONFLICT_PROMPT, CONTRACT_RELEVANCE_PROMPT } from './prompts.js';
import {resolveContractLlm,contractCompletion} from './completion.js';
interface ContractMetadata {getTeamById?(id:string):Promise<any>;verifyAuth(key:string):Promise<any>;getAgentById(id:string):Promise<any>;getTeamMember(team:string,user:string):Promise<any>;getUserById(id:string):Promise<any>;getTaskById(id:string):Promise<any>} 
export interface ContractDeps { controlKey?: string; baseDir: string; meta:(instance:string)=>Promise<ContractMetadata>; llm:(instance:string)=>{baseUrl:string;apiKey:string;model:string;timeoutMs?:number} }
export class ContractMemory {
  versions=new Map<string,ContractV2>(); stores = new Map<string,ContractStore>(); busy=new Set<string>(); timer:ReturnType<typeof setInterval>;
  constructor(public deps:ContractDeps) { const directory=join(deps.baseDir,'contract-memory'); if(existsSync(directory)) for(const item of readdirSync(directory)){ const file=join(directory,item,'contract.sqlite');if(existsSync(file)){const st=new ContractStore(file);const job=st.one('SELECT instance FROM jobs LIMIT 1');if(job){this.stores.set(job.instance,st);this.versions.set(job.instance,new ContractV2(st));}else st.db.close();}} this.timer=setInterval(()=>void this.tick(),3000);this.timer.unref(); }
  store(instance:string) { let s=this.stores.get(instance);if(!s){s=new ContractStore(join(this.deps.baseDir,'contract-memory',hash(instance).slice(0,24),'contract.sqlite'));this.stores.set(instance,s);this.versions.set(instance,new ContractV2(s));}return s; }
  llm(instance:string) {return resolveContractLlm(this.deps.llm(instance));}
  async identity(instance:string,b:any,key:string):Promise<Identity> {
    const meta=await this.deps.meta(instance),u=await meta.verifyAuth(key);
    if(!u || u.status!=='active')throw new ContractError(401,'记忆身份已失效');
    if(!b.team_id || !b.agent_id || (b.user_id && b.user_id!==u.user_id))throw new ContractError(403,'记忆身份或归属不匹配');
    const a=await meta.getAgentById(b.agent_id),m=await meta.getTeamMember(b.team_id,u.user_id);
    if(meta.getTeamById && (await meta.getTeamById(b.team_id))?.status!=='active')throw new ContractError(403,'团队已停用');
    if(!a || a.team_id!==b.team_id || a.status!=='active' || !m || m.status!=='active')throw new ContractError(403,'团队成员关系已失效');
    if(JSON.parse(a.metadata_json || '{}').prompt_mode!=='contract')throw new ContractError(422,'此 Agent 未启用合同记忆');
    return {instance,team:b.team_id,agent:b.agent_id,user:u.user_id,role:m.role};
  }
  async active(c:Identity) {
    const meta=await this.deps.meta(c.instance),u=await meta.getUserById(c.user),m=await meta.getTeamMember(c.team,c.user),a=await meta.getAgentById(c.agent);
    if(meta.getTeamById && (await meta.getTeamById(c.team))?.status!=='active')throw new ContractError(403,'团队已停用');
    if(!u || u.status!=='active' || !m || m.status!=='active' || !a || a.status!=='active' || a.team_id!==c.team)throw new ContractError(403,'团队或账号已失效');
    return {...c,role:m.role};
  }
  async task(c:Identity,tid:string) {const t=await (await this.deps.meta(c.instance)).getTaskById(tid);if(!t || t.team_id!==c.team || t.creator_user_id!==c.user || ['archived','deleted'].includes(t.status))throw new ContractError(403,'合同任务无权访问');}
  async managed(instance:string,b:any) {if(!b?.agent_id)return false;const a=await (await this.deps.meta(instance)).getAgentById(b.agent_id);return !!a && JSON.parse(a.metadata_json || '{}').prompt_mode==='contract';}
  async dispatch(path:string,instance:string,b:any,key:string,controlKey=''):Promise<any> {
    const action=path.replace(/^\/v[23]\//,'');
    if(action==='contract-memory/user-status') {
      const meta=await this.deps.meta(instance),actor=await meta.verifyAuth(key);
      if(!actor || actor.user_type!=='system_admin' || actor.status!=='active' || typeof b.active!=='boolean')throw new ContractError(403,'需要初始化管理员身份');
      const target=await meta.getUserById(b.user_id);
      if(!target || target.user_type!=='normal')throw new ContractError(422,'业务用户不存在');
      await (meta as any).rawStore.updateUser(b.user_id,{status:b.active?'active':'inactive'});
      return {saved:true};
    }
    const readonly=/^(contract-memory\/(list|detail|candidates|proposals|sources|case-list)|(?:conversation|atomic)\/(query|search|count)|scenario\/(ls|read|count)|core\/(read|count))$/.test(action);
    if(!readonly && (!this.deps.controlKey || controlKey!==this.deps.controlKey))throw new ContractError(403,'合同记忆写入需要业务控制端凭据');
    const c=await this.identity(instance,b,key),s=this.store(instance);
    if(b.task_id)await this.task(c,b.task_id);
    if(action.startsWith('contract-memory/')) {
      const op=action.slice('contract-memory/'.length);
      if(op==='capture-tools' || op==='capture-events') {if(!b.task_id)throw new ContractError(422,'缺少合同任务');const result=s.capture(c,b.task_id,b.session_id,b.messages,this.llm(instance).model,CONTRACT_PROMPT_VERSION);setImmediate(()=>void this.tick());return result;}
      const v=this.versions.get(instance)!;
      if(op==='resources')return v.resources(c,b.manifest);
      if(op==='review-events'){if(b.event?.task_id!==b.task_id)throw new ContractError(422,'处置任务不一致');return v.event(c,b.event,this.llm(instance).model);}
      if(op==='case-list')return {items:v.cases(c)};
      if(op==='precedents'){const result=await v.match(c,b.current,b.allowed_case_ids || [],p=>this.completion(instance,CONTRACT_RELEVANCE_PROMPT,p));await this.active(c);return result;}
      if(op==='list')return {items:b.scope==='legacy'?s.all("SELECT * FROM entries WHERE instance=? AND team=? AND agent=? AND (scope='team' OR user=?) AND COALESCE(json_extract(data,'$.schema_version'),1)!=2",...s.scope(c),c.user).map(e=>({...e,data:JSON.parse(e.data),legacy:true})):s.list(c,b.scope || 'personal').filter(e=>v.liveEntry(c,e))};
      if(op==='detail')return {entry:s.entry(c,b.id),versions:s.history(c,b.id)};
      if(op==='candidates')return {items:s.candidates(c,b.session_id),jobs:s.jobs(c),needs_review:[...s.list(c,'personal').filter(e=>!v.liveEntry(c,e)).map(e=>({id:e.id,data:e.data,reason:'来源版本已变化，请重新核对'})),...s.all('SELECT r.id,r.reason,r.data FROM rejected_candidates r JOIN jobs j ON j.id=r.job WHERE j.instance=? AND j.team=? AND j.agent=? AND j.user=?',...s.scope(c),c.user).map(r=>({...r,data:JSON.parse(r.data)}))]};
      if(op==='proposals')return {items:s.proposals(c)};
      if(op==='context') {if(!b.task_id || !b.session_id)throw new ContractError(422,'缺少合同会话');s.context(c,b.task_id,b.session_id,{documents:Array.isArray(b.documents)?b.documents:[],workspace_id:b.workspace_id,perspective:typeof b.perspective==='string'?b.perspective:null});return {saved:true};}
      if(op==='sources') {
        const entry=s.entry(c,b.id),visited=new Set<string>();
        const resolve=(ids:string[]):any[]=>ids.flatMap(sid=>{
          if(visited.has(sid))return [];visited.add(sid);
          const atom=s.one('SELECT * FROM atoms WHERE id=? AND instance=? AND team=? AND agent=? AND user=?',sid,...s.scope(c),c.user);
          if(atom){const data=JSON.parse(atom.data);const sourceId=data.document_refs?.[0]?.source_id || data.source_ids?.[0];const source=s.raw(c,atom.session).find(m=>m.id===sourceId);return [{id:sid,task_id:atom.task,session_id:atom.session,context:source?.data.evidence_context || null,document_refs:data.document_refs || []}];}
          const v=this.versions.get(instance)!;const caseItem=v.cases(c,true).find(x=>x.source_id===sid);if(caseItem)return [{id:sid,task_id:caseItem.task,session_id:caseItem.session,context:{workspace_id:caseItem.workspace,documents:[...new Map(caseItem.data.document_refs.map((r:any)=>[r.document_id,{document_id:r.document_id,version:r.version}])).values()]},document_refs:caseItem.data.document_refs}];
          const preference=v.preferences(c).find(x=>x.id===sid);if(preference){const source=s.raw(c,preference.session).find(x=>preference.source_ids.includes(x.id));return [{id:sid,context:source?.data.evidence_context || null,document_refs:[]}];}
          const parent=s.one("SELECT data FROM entries WHERE id=? AND instance=? AND team=? AND agent=? AND user=? AND scope='personal'",sid,...s.scope(c),c.user);
          return parent?resolve(JSON.parse(parent.data).source_ids):[{restricted:true}];
        });
        return {items:entry.scope==='team'?[]:resolve(entry.data.source_ids)};
      }
      let latest=await this.identity(instance,b,key); // final membership/role check after any asynchronous I/O
      if(op==='review' && b.approved){const p=s.proposals(latest).find(p=>p.id===b.id);if(!p)throw new ContractError(404,'审核申请不存在');const submitter=await this.active({...latest,user:p.user});const original=s.entry(submitter,p.target_id);if(!v.liveEntry(submitter,original))throw new ContractError(409,'共享来源已失效，请重新提交');latest=await this.identity(instance,b,key);}
      return s.mutation(latest,b.operation_id,b,op,b.id || '',()=>{
        if(op==='retry') {const job=s.one("SELECT * FROM jobs WHERE id=? AND instance=? AND team=? AND agent=? AND user=? AND status='failed'",b.id,...s.scope(latest),latest.user);if(!job)throw new ContractError(409,'整理任务不存在或已恢复');s.db.prepare("UPDATE jobs SET status='pending',attempts=0,error=NULL WHERE id=?").run(job.id);return {saved:true};}
        if(op==='create') {const e=s.create(latest,validateContent({...b.data,source_ids:[]}));this.queueProfile(latest,e);return e;}
        if(op==='update' && s.entry(c,b.id,true).data.schema_version!==2)throw new ContractError(409,'旧版内容请依据原始来源重新确认');
        if(op==='update')return s.edit(latest,b.id,b.version,validateContent({...b.data,source_ids:s.entry(latest,b.id,true).data.source_ids}));
        if(op==='delete')return s.edit(latest,b.id,b.version,null);
        if(op==='confirm') {const candidate=s.candidates(latest).find(e=>e.id===b.id);if(!candidate || !candidate.data.source_ids.every((id:string)=>v.sourceValid(latest,id)))throw new ContractError(409,'候选来源已变化，请重新整理');const e=s.confirm(latest,b.id,b.data?validateContent(b.data):undefined);this.queueProfile(latest,e);return e;}
        if(op==='ignore')return s.confirm(latest,b.id,undefined,true);
        if(op==='propose' && !v.liveEntry(c,s.entry(c,b.id)))throw new ContractError(409,'旧版内容不能直接发布为新版');
        if(op==='propose')return s.proposal(latest,b.id,b.operation,b.data?validateContent({...b.data,source_ids:[]}):null,b.version);
        if(op==='review') {if(typeof b.approved!=='boolean')throw new ContractError(422,'审核结果无效');return s.review(latest,b.id,b.approved);}
        throw new ContractError(404,'合同记忆接口不存在');
      });
    }
    if(action==='conversation/add') {
      if(!b.task_id)throw new ContractError(422,'缺少合同任务');
      const result=s.capture(c,b.task_id,b.session_id,b.messages,this.llm(instance).model,CONTRACT_PROMPT_VERSION);
      setImmediate(()=>void this.tick());return result;
    }
    // Legacy writes can never bypass candidate confirmation, even from Hub.
    if(/\/(write|update|delete|rm|clear)$/.test(action))throw new ContractError(403,'合同记忆需通过业务确认或审核流程修改');
    if(action.startsWith('atomic/')) {
      const v=this.versions.get(instance)!;
      const preferences=v.preferences(c).filter(p=>!b.task_id || s.one('SELECT 1 FROM raw WHERE instance=? AND team=? AND agent=? AND user=? AND task=? AND session=?',...s.scope(c),c.user,b.task_id,p.session));
      const formal=s.list(c).filter(e=>e.data.kind==='preference' && v.liveEntry(c,e));
      const active=preferences.filter(p=>formal.some(e=>e.data.source_ids.includes(p.id)));
      const current=(e:any)=>({id:e.id,version:e.version,content:e.data.content,topic:e.data.topic,conditions:e.data.conditions,exceptions:e.data.exceptions});
      // L1 is immutable source evidence. It must never masquerade as the
      // current setting after the user edits the formally confirmed L3.
      return {notice:'L1 是历史用户声明，仅用于溯源；当前工作约定以 current_formal_preferences 的最新正文为准，不能用原始声明覆盖人工修订。',
        current_formal_preferences:formal.map(current),
        items:active.map(p=>({id:p.id,content:'【历史用户声明，不是当前工作约定】'+p.content,type:'preference_statement',metadata:{...p,evidence_role:'historical_source',current_formal_preferences:formal.filter(e=>e.data.source_ids.includes(p.id)).map(current)}})),total:active.length,count:active.length};
    }
    if(action.startsWith('conversation/')) {
      let messages=s.raw(c);if(b.task_id)messages=messages.filter(m=>m.task===b.task_id);if(b.session_id && b.session_id!=='default')messages=messages.filter(m=>m.session===b.session_id);
      if(b.query)messages=messages.filter(m=>m.data.content.toLowerCase().includes(String(b.query).toLowerCase()));
      return {messages:messages.slice(-Math.min(100,b.limit || 30)).map(m=>({id:m.id,...m.data,task_id:m.task,session_id:m.session})),total:messages.length,count:messages.length};
    }
    const entries=[...s.list(c,'personal'),...s.list(c,'team')].filter(e=>this.versions.get(instance)!.liveEntry(c,e));
    if(action==='scenario/ls') {const prefix=String(b.path_prefix || '');const files=entries.filter(e=>e.data.kind==='experience' && (!prefix || e.id.startsWith(prefix) || e.data.topic.includes(prefix) || e.data.title.includes(prefix))).map(e=>({path:e.id,summary:e.data.title,updated_at:e.updated}));return {files,entries:files,items:files,count:files.length};}
    if(action==='scenario/read') {const e=s.entry(c,b.path);if(e.status!=='active'||!this.versions.get(instance)!.liveEntry(c,e))throw new ContractError(404,'经验已删除');return {path:e.id,content:format(e),summary:e.data.title};}
    if(action==='core/read')return {content:entries.filter(e=>e.data.kind==='preference').map(format).join('\n\n')};
    if(action.endsWith('/count'))return {count:entries.length};
    throw new ContractError(404,'合同记忆接口不存在');
  }
  queueProfile(c:Identity,e:any) {
    if(e.data?.kind!=='experience')return;
    this.store(c.instance).db.prepare('INSERT OR IGNORE INTO jobs(id,instance,team,agent,user,task,session,model,prompt_version,created) VALUES(?,?,?,?,?,?,?,?,?,?)').run('confirmed-'+e.id,...this.store(c.instance).scope(c),c.user,'','profile',this.llm(c.instance).model,CONTRACT_PROMPT_VERSION,new Date().toISOString());
  }
  async completion(instance:string,prompt:string,input:any) {
    const cfg=this.llm(instance),stage=prompt===CONTRACT_RELEVANCE_PROMPT?'case_relevance':prompt===CONTRACT_L1_PROMPT?'l1':prompt===CONTRACT_L2_PROMPT?'l2':prompt===CONTRACT_L3_PROMPT?'l3':'conflict';
    const r=await contractCompletion(cfg,stage,prompt,input,hash([Date.now(),Math.random()]));
    const store=this.store(instance);store.db.exec('CREATE TABLE IF NOT EXISTS llm_runs(id TEXT PRIMARY KEY,data TEXT)');
    store.db.prepare('INSERT INTO llm_runs VALUES(?,?)').run(hash([Date.now(),Math.random()]),JSON.stringify({model:cfg.model,prompt_version:CONTRACT_PROMPT_VERSION,prompt,input,output:r.output,...r.trace}));
    return r.output;
  }
  async tick() {
    for(const [instance,s] of this.stores) {
      if(this.busy.has(instance))continue;
      const job=s.one("SELECT * FROM jobs WHERE status IN ('pending','failed') AND attempts<3 ORDER BY created LIMIT 1");if(!job)continue;
      this.busy.add(instance);s.db.prepare("UPDATE jobs SET status='running',attempts=attempts+1 WHERE id=?").run(job.id);
      try {
        let c:Identity={instance,team:job.team,agent:job.agent,user:job.user,role:'member'};c=await this.active(c);if(job.task)await this.task(c,job.task);
        const v=this.versions.get(instance)!,raw=v.messages(c,job.session),events=s.all('SELECT id,data FROM review_events WHERE instance=? AND team=? AND agent=? AND user=?',...s.scope(c),c.user).filter(e=>!s.one('SELECT 1 FROM v2_processed WHERE message_id=?',e.id)).map(e=>({source_id:e.id,...JSON.parse(e.data)}));
        const l1=raw.length || events.length?await this.completion(instance,CONTRACT_L1_PROMPT,{messages:raw.map(m=>({id:m.id,...m.data})),review_events:events,cases:v.cases(c).map(e=>({id:e.source_id,...e.data}))}):{records:[]};
        c=await this.active(c);v.ingest(c,job.session,l1,raw,job.id);for(const e of events)s.db.prepare('INSERT OR IGNORE INTO v2_processed VALUES(?)').run(e.source_id);
        const eligible=v.eligible(c),prefs=v.preferences(c),confirmed=s.list(c).filter(e=>e.data.kind==='experience'&&v.liveEntry(c,e));
        const l2=eligible.length && (events.length || l1.records.some((r:any)=>r.kind==='reuse_instruction'))?await this.completion(instance,CONTRACT_L2_PROMPT,{cases:eligible.map(e=>({id:e.source_id,workspace_id:e.workspace,...e.data})),reuse_instructions:prefs.filter(p=>p.kind==='reuse_instruction'),existing:confirmed}):{entries:[]};
        const l3=(job.session==='profile'||l1.records.some((r:any)=>r.kind==='long_term_preference')) && (prefs.some(p=>p.kind==='long_term_preference')||confirmed.length)?await this.completion(instance,CONTRACT_L3_PROMPT,{preferences:prefs.filter(p=>p.kind==='long_term_preference'),confirmed_experiences:confirmed.map(e=>({id:e.id,...e.data}))}):{entries:[]};
        const validated=[...(l2.entries || []),...(l3.entries || [])];
        // Compare the same canonical scope/topic that publication will store.
        // Model wording such as “称呼偏好” must not bypass “称呼语气” conflicts.
        for(const candidate of validated)v.normalizeCandidate(c,candidate);
        // Compare potential conflicts; never auto-update human-confirmed entries.
        const conflicts:any[]=[];
        for(const candidate of validated)for(const existing of s.list(c,'personal').filter(e=>e.data.topic===candidate.topic && e.data.kind===candidate.kind)) {
          const relation=await this.completion(instance,CONTRACT_CONFLICT_PROMPT,{old:existing.data,new:candidate});
          if(['contradicts','supersedes'].includes(relation.relation))conflicts.push({candidate,existing_id:existing.id,existing_version:existing.version,relation:relation.relation});
        }
        c=await this.active(c);if(job.task)await this.task(c,job.task);
        s.transaction(()=>{v.publishCandidates(c,job,{entries:(l2.entries || []).map((e:any)=>({...e,conflicts:conflicts.filter(x=>x.candidate===e).map(x=>({existing_id:x.existing_id,existing_version:x.existing_version,relation:x.relation}))}))},{entries:(l3.entries || []).map((e:any)=>({...e,conflicts:conflicts.filter(x=>x.candidate===e).map(x=>({existing_id:x.existing_id,existing_version:x.existing_version,relation:x.relation}))}))});s.db.prepare("UPDATE jobs SET status='completed',error=NULL WHERE id=?").run(job.id);});
        s.db.exec('CREATE TABLE IF NOT EXISTS extraction_runs(job TEXT PRIMARY KEY,data TEXT)');
        s.db.prepare('INSERT OR REPLACE INTO extraction_runs VALUES(?,?)').run(job.id,JSON.stringify({model:job.model,prompt_version:CONTRACT_PROMPT_VERSION,input:raw,l1,l2,l3,conflicts}));
      } catch(e) {s.db.prepare("UPDATE jobs SET status='failed',error=? WHERE id=?").run(String((e as Error).message).slice(0,400),job.id);}
      finally{this.busy.delete(instance);}
    }
  }
  close(){clearInterval(this.timer);for(const s of this.stores.values())if(!this.busy.size)s.db.close();}
}
function format(e:any) {return `[${e.scope==='team'?'团队工作经验':'个人已确认记忆'}；仅作参考，不代表合同批准] ${e.data.title}\n${e.data.content}\n适用条件：${e.data.conditions.join('；') || '未知，请核对'}\n例外：${e.data.exceptions.join('；') || '未提供'}\n版本：${e.version}`;}

function matches(content:string,query:string) {const text=content.toLowerCase();return query.toLowerCase().split(/[\s/|,，、]+/).filter(Boolean).some(token=>text.includes(token) || (token.length>=4 && [...token].slice(0,-1).some((_,i)=>text.includes(token.slice(i,i+2)))));}
