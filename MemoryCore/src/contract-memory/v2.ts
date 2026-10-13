import {ContractStore,ContractError,hash,canonicalTopic,validateContent,type Identity} from './store.js';
const version=2;
const decisions=['待处理','要求修改','接受风险','升级审批','补充材料','判断有误'];
const longTerm=/(以后|今后|长期|每次|始终|一直|今后的|请记住|from now on|always|going forward|every (?:time|report))/i;
const temporary=/(仅本次|仅限本次|只在本次|这次.*(?:称呼|叫我|格式)|just this time|today only)/i;
export class ContractV2 {
 constructor(public store:ContractStore) {
  const s=store;s.db.exec(`CREATE TABLE IF NOT EXISTS contract_v2_state(key TEXT PRIMARY KEY,value TEXT);
   CREATE TABLE IF NOT EXISTS review_events(id TEXT PRIMARY KEY,case_id TEXT,instance TEXT,team TEXT,agent TEXT,user TEXT,data TEXT,created TEXT);
   CREATE TABLE IF NOT EXISTS review_cases(id TEXT PRIMARY KEY,instance TEXT,team TEXT,agent TEXT,user TEXT,task TEXT,session TEXT,workspace TEXT,status TEXT,version INTEGER,data TEXT,created TEXT);
   CREATE TABLE IF NOT EXISTS case_history(id TEXT,version INTEGER,data TEXT,PRIMARY KEY(id,version));
   CREATE TABLE IF NOT EXISTS preference_statements(id TEXT PRIMARY KEY,instance TEXT,team TEXT,agent TEXT,user TEXT,session TEXT,data TEXT);
   CREATE TABLE IF NOT EXISTS v2_processed(message_id TEXT PRIMARY KEY);
   CREATE TABLE IF NOT EXISTS rejected_candidates(id TEXT PRIMARY KEY,job TEXT,reason TEXT,data TEXT,created TEXT);`);
  if(!s.one("SELECT value FROM contract_v2_state WHERE key='cutover_row'"))s.db.prepare('INSERT INTO contract_v2_state VALUES(?,?)').run('cutover_row',String(s.one('SELECT MAX(rowid) AS n FROM raw')?.n || 0));
  s.db.prepare("UPDATE jobs SET status='legacy' WHERE prompt_version!='contract-v2' AND status IN ('pending','failed')").run();
 }
 cases(c:Identity,includeInactive=false) {return this.store.all('SELECT * FROM review_cases WHERE instance=? AND team=? AND agent=? AND user=?'+(includeInactive?'':" AND status='active'"),...this.store.scope(c),c.user).map(r=>({...r,data:JSON.parse(r.data),source_id:r.id+'@'+r.version}));}
 resources(c:Identity,manifest:any[]) {
  if(!Array.isArray(manifest)||manifest.length>10000)throw new ContractError(422,'来源清单无效');
  const visible=new Map(manifest.map(w=>[w.workspace_id,new Set((w.documents || []).map((d:any)=>d.document_id+':'+d.version))]));
  for(const x of this.cases(c,true)) {
   const docs=visible.get(x.workspace),refs=x.data.document_refs;
   const valid=!!docs && refs.every((r:any)=>docs.has(r.document_id+':'+r.version)) && manifest.some(w=>w.workspace_id===x.workspace&&w.primary_version===x.data.document_version);
   if(!valid&&x.status==='active')this.store.db.prepare("UPDATE review_cases SET status='source_changed' WHERE id=?").run(x.id);
   if(valid&&x.status==='source_changed')this.store.db.prepare("UPDATE review_cases SET status='active' WHERE id=?").run(x.id);
  }
  return {saved:true};
 }
 event(c:Identity,e:any,model="") {
  const s=this.store;
  if(!e || typeof e.event_id!=='string' || e.actor_user_id!==c.user || !decisions.includes(e.decision) || !Number.isInteger(e.revision)||e.revision<1 || !Array.isArray(e.document_refs) || !e.workspace_id || !e.document_version || !e.task_id || !e.session_id || !e.report_id || !e.risk_id || !e.risk_definition_hash || typeof e.note!=='string' || typeof e.created!=='string' || !Number.isFinite(Date.parse(e.created)))throw new ContractError(422,'处置事件来源、版本或内容无效');
  if(e.note.length>1000 || e.document_refs.length>100 || JSON.stringify(e).length>100000)throw new ContractError(422,'处置事件过大');
  const prior=s.one('SELECT * FROM review_events WHERE id=?',e.event_id);
  if(prior){if(hash(JSON.parse(prior.data))!==hash(e)||prior.user!==c.user)throw new ContractError(409,'同一事件标识对应不同内容');return {saved:true,case_id:prior.case_id,duplicate:true};}
  const key='case_'+hash([...s.scope(c),c.user,e.workspace_id,e.document_version,e.risk_id,e.risk_definition_hash]).slice(0,32);
  return s.transaction(()=>{
   s.db.prepare('INSERT INTO review_events VALUES(?,?,?,?,?,?,?,?)').run(e.event_id,key,...s.scope(c),c.user,JSON.stringify(e),e.created);
   const old=s.one('SELECT * FROM review_cases WHERE id=?',key),current=old?JSON.parse(old.data):null;
   if(current && (e.report_id===current.report_id?e.revision<=current.revision:Date.parse(e.created)<Date.parse(current.created)))return {saved:true,case_id:key,older_event:true};
   const v=(old?.version || 0)+1,data={...e,schema_version:version,kind:'risk_disposition',topic:canonicalTopic(e.topic || e.risk_name || ''),content:e.note,conditions:[],exceptions:[],execution_status:'not_verified',approval_status:'not_verified'};
   if(old)s.db.prepare('INSERT INTO case_history VALUES(?,?,?)').run(key,old.version,old.data);
   s.db.prepare('INSERT INTO review_cases VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET task=excluded.task,session=excluded.session,status=excluded.status,version=excluded.version,data=excluded.data,created=excluded.created').run(key,...s.scope(c),c.user,e.task_id,e.session_id,e.workspace_id,e.decision==='待处理'?'withdrawn':'active',v,JSON.stringify(data),e.created);
   s.db.prepare('INSERT OR IGNORE INTO jobs(id,instance,team,agent,user,task,session,model,prompt_version,created) VALUES(?,?,?,?,?,?,?,?,?,?)').run('event-'+hash(e.event_id),...s.scope(c),c.user,e.task_id,e.session_id,model, 'contract-v2',new Date().toISOString());
   return {saved:true,case_id:key,version:v,pipeline_status:'pending'};
  });
 }
 messages(c:Identity,session:string) {
  const cutoff=Number(this.store.one("SELECT value FROM contract_v2_state WHERE key='cutover_row'").value);
  const allowed=new Set(this.store.all('SELECT id FROM raw WHERE rowid>?',cutoff).map(r=>r.id));
  return this.store.raw(c,session).filter(r=>r.data.role==='user'&&allowed.has(r.id)&&!this.store.one('SELECT 1 FROM v2_processed WHERE message_id=?',r.id));
 }
 preferences(c:Identity) {return this.store.all('SELECT id,session,data FROM preference_statements WHERE instance=? AND team=? AND agent=? AND user=?',...this.store.scope(c),c.user).map(r=>({id:r.id,session:r.session,...JSON.parse(r.data)}));}
 reject(job:string,data:any,reason:string) {this.store.db.prepare('INSERT OR IGNORE INTO rejected_candidates VALUES(?,?,?,?,?)').run(hash([job,data,reason]),job,reason,JSON.stringify(data),new Date().toISOString());}
 ingest(c:Identity,session:string,result:any,messages:any[],job:string) {
  if(!Array.isArray(result.records))throw new ContractError(422,'L1 输出格式无效');
  const sources=new Map(messages.map(m=>[m.id,m]));
  for(const r of result.records)try {
   if(!Array.isArray(r.source_ids)||!r.source_ids.length||typeof r.content!=='string'||!Array.isArray(r.conditions)||!Array.isArray(r.exceptions))throw new Error('L1 来源或结构无效');
   if(r.kind==='risk_disposition') {
    for(const sid of r.source_ids) {
     const e=this.store.one('SELECT * FROM review_events WHERE id=? AND instance=? AND team=? AND agent=? AND user=?',sid,...this.store.scope(c),c.user);if(!e)throw new Error('处置来源不是业务事件');
     const row=this.cases(c,true).find(x=>x.id===e.case_id);if(!row || row.data.event_id!==sid)continue;
     row.data={...row.data,content:r.content,conditions:r.conditions,exceptions:r.exceptions};this.store.db.prepare('UPDATE review_cases SET data=? WHERE id=?').run(JSON.stringify(row.data),row.id);
    }
   } else if(['long_term_preference','reuse_instruction'].includes(r.kind)) {
    const text=String(r.evidence_quote || ''),proof=r.source_ids.map((id:string)=>sources.get(id)).filter(Boolean);
    if(!proof.length || !proof.some(m=>m.data.content.includes(text)) || !text || !longTerm.test(text) || temporary.test(text))throw new Error('缺少用户明确长期意图原话');
    if(r.kind==='long_term_preference'&&!['review_principle','delivery_preference','communication_preference'].includes(r.subtype))throw new Error('偏好类别无效');
    const caseIds=new Set(this.cases(c).map(x=>x.source_id));
    if(r.source_ids.some((id:string)=>!sources.has(id)&&!caseIds.has(id)))throw new Error('声明来源无效');
    if(r.kind==='reuse_instruction'&&!r.source_ids.some((id:string)=>caseIds.has(id)))throw new Error('复用要求没有已保存案例');
    const id='pref_'+hash([...this.store.scope(c),c.user,r]).slice(0,32);
    this.store.db.prepare('INSERT OR IGNORE INTO preference_statements VALUES(?,?,?,?,?,?,?)').run(id,...this.store.scope(c),c.user,session,JSON.stringify({...r,schema_version:2}));
   } else throw new Error('L1 不接受裸条款或助手叙述');
  }catch(e){this.reject(job,r,String((e as Error).message));}
  for(const m of messages)this.store.db.prepare('INSERT OR IGNORE INTO v2_processed VALUES(?)').run(m.id);
 }
 eligible(c:Identity) {
  const cases=this.cases(c),reuse=this.preferences(c).filter(p=>p.kind==='reuse_instruction');
  return cases.filter(x=>new Set(cases.filter(y=>y.data.topic===x.data.topic).map(y=>y.workspace)).size>=2 || reuse.some(p=>p.source_ids.includes(x.source_id)));
 }
 sourceValid(c:Identity,id:string) {
  if(id.startsWith('case_'))return this.cases(c).some(x=>x.source_id===id);
  if(id.startsWith('pref_'))return this.preferences(c).some(x=>x.id===id);
  const e=this.store.one("SELECT data,status FROM entries WHERE id=? AND instance=? AND team=? AND agent=? AND user=?",id,...this.store.scope(c),c.user);
  return !!e && e.status==='active' && JSON.parse(e.data).schema_version===2 && JSON.parse(e.data).source_ids.every((sid:string)=>this.sourceValid(c,sid));
 }
 liveEntry(c:Identity,e:any) {return e.data.schema_version===2 && (e.scope==='team' || e.data.source_ids.every((id:string)=>this.sourceValid(c,id)||(!id.startsWith('case_')&&!id.startsWith('pref_')&&!this.store.one('SELECT 1 FROM entries WHERE id=?',id))));}
 publishCandidates(c:Identity,job:any,l2:any,l3:any) {
  const eligible=this.eligible(c),prefs=this.preferences(c),formal=this.store.list(c).filter(e=>e.data.kind==='experience'&&this.liveEntry(c,e));
  for(const data of [...(l2.entries || []),...(l3.entries || [])])try{
   const v=validateContent(data);if(!v.source_ids.length)throw new Error('候选缺少来源');
   if(v.kind==='experience') {
    const matched=eligible.filter(x=>v.source_ids.includes(x.source_id)),reuse=prefs.filter(p=>p.kind==='reuse_instruction'&&v.source_ids.includes(p.id));
    if(matched.length && new Set(matched.map(x=>x.data.topic)).size===1)v.topic=matched[0].data.topic;
    if(v.source_ids.some(id=>!matched.some(x=>x.source_id===id)&&!reuse.some(p=>p.id===id)))throw new Error('经验不能引用偏好或助手内容');
    if(new Set(matched.map(x=>x.workspace)).size<2 && !reuse.some(p=>p.source_ids.some((id:string)=>matched.some(x=>x.source_id===id))))throw new Error('经验缺少不同合同案例或复用指令');
    if(v.content.length>240 || /风险主题与方法|助手在本次|确认前|建议卡片|本次对话|称呼用户|叫我|敬语/.test(v.title+' '+v.content))throw new Error('经验不精炼或包含偏好/流程说明');
   } else {
    const selected=prefs.filter(p=>p.kind==='long_term_preference'&&v.source_ids.includes(p.id)),experiences=formal.filter(e=>v.source_ids.includes(e.id));
    if(selected.length){if(new Set(selected.map(p=>p.subtype)).size>1)throw new Error('不同偏好应分别确认');v.subtype=selected[0].subtype;v.topic=v.subtype==='communication_preference'?'称呼语气':canonicalTopic(selected[0].topic);}
    if(v.source_ids.some(id=>!selected.some(p=>p.id===id)&&!experiences.some(e=>e.id===id)))throw new Error('L3 来源未确认或不是长期声明');
    if(!selected.length && new Set(experiences.map(e=>e.data.topic)).size<2)throw new Error('L3 缺少跨场景原则依据');
    if(v.content.length>80 || /助手在本次|确认前|建议卡片|仅在本次对话/.test(v.content))throw new Error('工作约定不精炼或含流程说明');
   }
   this.store.proposeCandidate(c,job.task,job.session,{...v,conflicts:data.conflicts || []} as any);
  }catch(e){this.reject(job.id,data,String((e as Error).message));}
 }
 async match(c:Identity,current:any,allowed:string[],complete:(p:any)=>Promise<any>) {
  const text=String(current.risk_name || '')+' '+String(current.topic || '')+' '+String(current.clause_text || '');
  const candidates=this.cases(c).filter(x=>allowed.includes(x.id)&&x.workspace!==current.workspace_id)
   .map(x=>({x,score:(x.data.risk_definition_hash===current.risk_definition_hash?4:0)+(x.data.topic===canonicalTopic(current.topic || current.risk_name)?2:0)+[...new Set(text.match(/[\u4e00-\u9fff]{2}/g)||[])].filter(t=>JSON.stringify(x.data).includes(t)).length})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,20).map(x=>x.x);
  if(!candidates.length)return {items:[],schema_version:2};
  const r=await complete({current,cases:candidates.map(x=>({case_id:x.id,version:x.version,...x.data}))});if(!Array.isArray(r.matches))throw new ContractError(502,'历史案例相关性结果无效');
  const items=[];const seen=new Set();
  for(const m of r.matches){const x=candidates.find(x=>x.id===m.case_id&&x.version===m.version);if(Object.keys(m).some(k=>!['case_id','version','relation','matching_points','differences','reason'].includes(k))||!x||seen.has(x.id)||!['applicable','conditional','incompatible','insufficient'].includes(m.relation)||!Array.isArray(m.matching_points)||!Array.isArray(m.differences)||typeof m.reason!=='string')throw new ContractError(502,'相关性来源或结构无效');seen.add(x.id);
   const live=this.cases(c).find(y=>y.id===x.id&&y.version===x.version);if(!live || ['incompatible'].includes(m.relation))continue;
   const role=(x:any)=>/采购|买方|需方|买受|客户/.test(x||'')?'buyer':/供货|供应|卖方|出卖/.test(x||'')?'seller':/委托/.test(x||'')?'client':/受托|服务方/.test(x||'')?'service':null;
   const a=role(current.our_role),b=role(x.data.our_role);if((a==='buyer'&&b==='seller')||(a==='seller'&&b==='buyer')||(a==='client'&&b==='service')||(a==='service'&&b==='client'))continue;
   if(m.relation==='applicable'&&current.risk_definition_hash!==x.data.risk_definition_hash){m.relation='conditional';m.differences.push('当前风险定义或标准已有变化');}
   if(m.relation==='applicable'&&(!a || !b || /(?:仅限|仅|只限).*(项目|合同)/.test(x.data.note))){m.relation='conditional';m.differences.push('须核对我方角色与原项目限制');}
   items.push({case_id:x.id,version:x.version,workspace_id:x.workspace,report_id:x.data.report_id,risk_id:x.data.risk_id,decision:x.data.decision,note:x.data.note,conditions:x.data.conditions,exceptions:x.data.exceptions,document_version:x.data.document_version,...m});
  }
  return {items:items.slice(0,3),schema_version:2};
 }
}
