import { join } from 'node:path';
import { readdirSync, existsSync } from 'node:fs';
import { ContractStore, ContractError, hash, validateContent, type Identity } from './store.js';
import { CONTRACT_PROMPT_VERSION, CONTRACT_L1_PROMPT, CONTRACT_L2_PROMPT, CONTRACT_L3_PROMPT, CONTRACT_CONFLICT_PROMPT } from './prompts.js';
import {resolveContractLlm,contractCompletion} from './completion.js';
interface ContractMetadata {getTeamById?(id:string):Promise<any>;verifyAuth(key:string):Promise<any>;getAgentById(id:string):Promise<any>;getTeamMember(team:string,user:string):Promise<any>;getUserById(id:string):Promise<any>;getTaskById(id:string):Promise<any>} 
export interface ContractDeps { controlKey?: string; baseDir: string; meta:(instance:string)=>Promise<ContractMetadata>; llm:(instance:string)=>{baseUrl:string;apiKey:string;model:string;timeoutMs?:number} }
export class ContractMemory {
  stores = new Map<string,ContractStore>(); busy=new Set<string>(); timer:ReturnType<typeof setInterval>;
  constructor(public deps:ContractDeps) { const directory=join(deps.baseDir,'contract-memory'); if(existsSync(directory)) for(const item of readdirSync(directory)){ const file=join(directory,item,'contract.sqlite');if(existsSync(file)){const st=new ContractStore(file);const job=st.one('SELECT instance FROM jobs LIMIT 1');if(job)this.stores.set(job.instance,st);else st.db.close();}} this.timer=setInterval(()=>void this.tick(),3000);this.timer.unref(); }
  store(instance:string) { let s=this.stores.get(instance);if(!s){s=new ContractStore(join(this.deps.baseDir,'contract-memory',hash(instance).slice(0,24),'contract.sqlite'));this.stores.set(instance,s);}return s; }
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
  async task(c:Identity,tid:string) {const t=await (await this.deps.meta(c.instance)).getTaskById(tid);if(!t || t.team_id!==c.team || t.creator_user_id!==c.user)throw new ContractError(403,'合同任务无权访问');}
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
    const readonly=/^(contract-memory\/(list|detail|candidates|proposals|sources)|(?:conversation|atomic)\/(query|search|count)|scenario\/(ls|read|count)|core\/(read|count))$/.test(action);
    if(!readonly && (!this.deps.controlKey || controlKey!==this.deps.controlKey))throw new ContractError(403,'合同记忆写入需要业务控制端凭据');
    const c=await this.identity(instance,b,key),s=this.store(instance);
    if(b.task_id)await this.task(c,b.task_id);
    if(action.startsWith('contract-memory/')) {
      const op=action.slice('contract-memory/'.length);
      if(op==='capture-tools' || op==='capture-events') {if(!b.task_id)throw new ContractError(422,'缺少合同任务');const result=s.capture(c,b.task_id,b.session_id,b.messages,this.llm(instance).model,CONTRACT_PROMPT_VERSION);setImmediate(()=>void this.tick());return result;}
      if(op==='list')return {items:s.list(c,b.scope || 'personal')};
      if(op==='detail')return {entry:s.entry(c,b.id),versions:s.history(c,b.id)};
      if(op==='candidates')return {items:s.candidates(c,b.session_id),jobs:s.jobs(c)};
      if(op==='proposals')return {items:s.proposals(c)};
      if(op==='context') {if(!b.task_id || !b.session_id)throw new ContractError(422,'缺少合同会话');s.context(c,b.task_id,b.session_id,{documents:Array.isArray(b.documents)?b.documents:[],workspace_id:b.workspace_id,perspective:typeof b.perspective==='string'?b.perspective:null});return {saved:true};}
      if(op==='sources') {
        const entry=s.entry(c,b.id),visited=new Set<string>();
        const resolve=(ids:string[]):any[]=>ids.flatMap(sid=>{
          if(visited.has(sid))return [];visited.add(sid);
          const atom=s.one('SELECT * FROM atoms WHERE id=? AND instance=? AND team=? AND agent=? AND user=?',sid,...s.scope(c),c.user);
          if(atom){const data=JSON.parse(atom.data);const sourceId=data.document_refs?.[0]?.source_id || data.source_ids?.[0];const source=s.raw(c,atom.session).find(m=>m.id===sourceId);return [{id:sid,task_id:atom.task,session_id:atom.session,context:source?.data.evidence_context || null,document_refs:data.document_refs || []}];}
          const parent=s.one("SELECT data FROM entries WHERE id=? AND instance=? AND team=? AND agent=? AND user=? AND scope='personal'",sid,...s.scope(c),c.user);
          return parent?resolve(JSON.parse(parent.data).source_ids):[{restricted:true}];
        });
        return {items:entry.scope==='team'?[]:resolve(entry.data.source_ids)};
      }
      const latest=await this.identity(instance,b,key); // final membership/role check after any asynchronous I/O
      return s.mutation(latest,b.operation_id,b,op,b.id || '',()=>{
        if(op==='retry') {const job=s.one("SELECT * FROM jobs WHERE id=? AND instance=? AND team=? AND agent=? AND user=? AND status='failed'",b.id,...s.scope(latest),latest.user);if(!job)throw new ContractError(409,'整理任务不存在或已恢复');s.db.prepare("UPDATE jobs SET status='pending',attempts=0,error=NULL WHERE id=?").run(job.id);return {saved:true};}
        if(op==='create') {const e=s.create(latest,validateContent({...b.data,source_ids:[]}));this.queueProfile(latest,e);return e;}
        if(op==='update')return s.edit(latest,b.id,b.version,validateContent({...b.data,source_ids:s.entry(latest,b.id,true).data.source_ids}));
        if(op==='delete')return s.edit(latest,b.id,b.version,null);
        if(op==='confirm') {const e=s.confirm(latest,b.id,b.data?validateContent(b.data):undefined);this.queueProfile(latest,e);return e;}
        if(op==='ignore')return s.confirm(latest,b.id,undefined,true);
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
      const confirmedSources=new Set(s.list(c,'personal').flatMap(e=>e.data.source_ids));
      let items=s.atoms(c).filter(a=>a.data.kind!=='preference' || confirmedSources.has(a.id));if(b.type){const kind=['persona','instruction'].includes(b.type)?'preference':b.type;items=items.filter(a=>a.data.kind===kind);}if(b.task_id)items=items.filter(a=>a.task===b.task_id);
      if(b.query)items=items.filter(a=>matches(JSON.stringify(a.data),String(b.query)));
      return {items:items.slice(0,Math.min(100,b.limit || 30)).map(a=>({id:a.id,content:a.data.content,type:a.data.kind,metadata:a.data,task_id:a.task,source_message_ids:a.data.source_ids})),total:items.length,count:items.length};
    }
    if(action.startsWith('conversation/')) {
      let messages=s.raw(c);if(b.task_id)messages=messages.filter(m=>m.task===b.task_id);if(b.session_id && b.session_id!=='default')messages=messages.filter(m=>m.session===b.session_id);
      if(b.query)messages=messages.filter(m=>m.data.content.toLowerCase().includes(String(b.query).toLowerCase()));
      return {messages:messages.slice(-Math.min(100,b.limit || 30)).map(m=>({id:m.id,...m.data,task_id:m.task,session_id:m.session})),total:messages.length,count:messages.length};
    }
    const entries=[...s.list(c,'personal'),...s.list(c,'team')];
    if(action==='scenario/ls') {const prefix=String(b.path_prefix || '');const files=entries.filter(e=>e.data.kind==='experience' && (!prefix || e.id.startsWith(prefix) || e.data.topic.includes(prefix) || e.data.title.includes(prefix))).map(e=>({path:e.id,summary:e.data.title,updated_at:e.updated}));return {files,entries:files,items:files,count:files.length};}
    if(action==='scenario/read') {const e=s.entry(c,b.path);if(e.status!=='active')throw new ContractError(404,'经验已删除');return {path:e.id,content:format(e),summary:e.data.title};}
    if(action==='core/read')return {content:entries.filter(e=>e.data.kind==='preference').map(format).join('\n\n')};
    if(action.endsWith('/count'))return {count:entries.length};
    throw new ContractError(404,'合同记忆接口不存在');
  }
  queueProfile(c:Identity,e:any) {
    if(e.data?.kind!=='experience')return;
    this.store(c.instance).db.prepare('INSERT OR IGNORE INTO jobs(id,instance,team,agent,user,task,session,model,prompt_version,created) VALUES(?,?,?,?,?,?,?,?,?,?)').run('confirmed-'+e.id,...this.store(c.instance).scope(c),c.user,'','profile',this.llm(c.instance).model,CONTRACT_PROMPT_VERSION,new Date().toISOString());
  }
  async completion(instance:string,prompt:string,input:any) {
    const cfg=this.llm(instance),stage=prompt===CONTRACT_L1_PROMPT?'l1':prompt===CONTRACT_L2_PROMPT?'l2':prompt===CONTRACT_L3_PROMPT?'l3':'conflict';
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
        const raw=s.raw(c,job.session).filter(m=>m.data.role!=='tool' || (m.data.tool_name==='read' && m.data.evidence_context?.documents?.some((d:any)=>m.data.tool_path===d.read_path && d.paragraphs?.some((p:any)=>m.data.content.includes(p.citation)))) || /"saved"\s*:\s*true/.test(m.data.content)), l1=raw.length?await this.completion(instance,CONTRACT_L1_PROMPT,{messages:raw.map(m=>({id:m.id,...m.data})),prior_records:s.atoms(c).filter(a=>a.task===job.task).map(a=>({id:a.id,...a.data}))}):{records:[]};
        if(!Array.isArray(l1.records))throw new Error('L1 输出格式无效');
        c=await this.active(c);s.transaction(()=>s.saveAtoms(c,job.task,job.session,l1.records));
        const atoms=s.atoms(c).filter(a=>a.session===job.session),input=atoms.filter(a=>a.data.validity==='active').map(a=>({id:a.id,...a.data}));
        const experienceInput=input.filter(a=>a.kind!=="preference" && (a.kind!=="contract_fact" || a.evidence_status==="verified_document"));
        const l2=experienceInput.length?await this.completion(instance,CONTRACT_L2_PROMPT,experienceInput):{entries:[]};
        for(const e of l2.entries ?? [])if(e.kind!=="experience" || e.source_ids?.some((sid:string)=>!experienceInput.some(a=>a.id===sid)))throw new Error("经验候选不应重复工作偏好");
        const preferences=input.filter(a=>a.kind==='preference');
        const confirmed=s.list(c,'personal').filter(e=>e.data.kind==='experience').map(e=>({id:e.id,...e.data,confirmed:true}));
        const l3=preferences.length || confirmed.length?await this.completion(instance,CONTRACT_L3_PROMPT,[...preferences,...confirmed]):{entries:[]};
        const candidates=[...(l2.entries ?? []),...(l3.entries ?? [])],sources=new Set([...input.map(a=>a.id),...confirmed.map(a=>a.id)]);
        const validated=candidates.map(x=>{const v=validateContent(x);if(!v.source_ids.length || v.source_ids.some(s=>!sources.has(s)))throw new Error('候选来源无效');if(v.kind==='preference' && v.source_ids.some(s=>!preferences.some(a=>a.id===s) && !confirmed.some(a=>a.id===s)))throw new Error('工作原则没有长期偏好或确认经验依据');return v;});
        // Compare potential conflicts; never auto-update human-confirmed entries.
        const conflicts:any[]=[];
        for(const candidate of validated)for(const existing of s.list(c,'personal').filter(e=>e.data.topic===candidate.topic && e.data.kind===candidate.kind)) {
          const relation=await this.completion(instance,CONTRACT_CONFLICT_PROMPT,{old:existing.data,new:candidate});
          if(['contradicts','supersedes'].includes(relation.relation))conflicts.push({candidate,existing_id:existing.id,relation:relation.relation});
        }
        c=await this.active(c);if(job.task)await this.task(c,job.task);
        s.transaction(()=>{for(const v of validated)s.proposeCandidate(c,job.task,job.session,{...v,conflicts:conflicts.filter(x=>x.candidate===v).map(x=>({existing_id:x.existing_id,relation:x.relation}))} as any);s.db.prepare("UPDATE jobs SET status='completed',error=NULL WHERE id=?").run(job.id);});
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
