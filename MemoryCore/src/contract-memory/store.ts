import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Identity { instance: string; team: string; agent: string; user: string; role: string }
export interface Content { kind: 'experience' | 'preference'; title: string; content: string; topic: string; conditions: string[]; exceptions: string[]; source_ids: string[]; schema_version?:number; subtype?:string; conflicts?:any[] }
export class ContractError extends Error { constructor(public status: number, message: string) { super(message); } }
export const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const now = () => new Date().toISOString();
const id = () => randomUUID();
const parse = (r: any) => r ? { ...r, data: JSON.parse(r.data), ...(r.before_data ? { before: JSON.parse(r.before_data) } : {}) } : undefined;
export function canonicalTopic(topic:string) {for(const [pattern,name] of [[/付款|账期|预付/,'付款'],[/验收|交付/,'验收'],[/责任|违约|赔偿/,'责任限制'],[/解除|终止/,'解除'],[/报告|格式|结构/,'报告风格'],[/证据|引用|依据/,'证据要求']] as const)if(pattern.test(topic))return name;return topic;}
export function validateContent(input: any): Content {
  if (!input || !['experience','preference'].includes(input.kind) || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 160 || typeof input.content !== 'string' || !input.content.trim() || input.content.length > 12000) throw new ContractError(422,'请填写完整的标题和内容');
  if(input.kind==='preference' && input.content.length>80)throw new ContractError(422,'工作约定请拆成单条（正文最多80字），条件和例外另列');
  if(input.kind==='experience' && input.content.length>240)throw new ContractError(422,'请精炼处置方法（正文最多240字），完整限制放入条件和例外');
  if(input.subtype && !['disposition_method','review_principle','delivery_preference','communication_preference'].includes(input.subtype))throw new ContractError(422,'内容类别无效');
  if(input.kind==='preference' && /称呼用户|称呼为|叫我|称呼偏好|call me/i.test(input.content))input={...input,subtype:'communication_preference'};
  for (const k of ['conditions','exceptions','source_ids']) if (!Array.isArray(input[k]) || input[k].length > 100 || input[k].some((v: unknown) => typeof v !== 'string' || v.length > 1000)) throw new ContractError(422,'条件或来源格式无效');
  return { kind: input.kind, title: input.title.trim(), content: input.content.trim(), topic: canonicalTopic(String(input.topic ?? '').slice(0,120)), conditions: input.conditions, exceptions: input.exceptions, source_ids: input.source_ids, schema_version:2, subtype:input.subtype || (input.kind==='experience'?'disposition_method':'delivery_preference'), ...(Array.isArray(input.conflicts)?{conflicts:input.conflicts}: {}) };
}
/** Canonical SQLite plane. Profiles and recall are views of confirmed live entries. */
export class ContractStore {
  db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true }); this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS contexts(instance TEXT,team TEXT,agent TEXT,user TEXT,task TEXT,session TEXT,data TEXT,PRIMARY KEY(instance,team,agent,user,session));
      CREATE TABLE IF NOT EXISTS raw(id TEXT PRIMARY KEY,instance TEXT,team TEXT,agent TEXT,user TEXT,task TEXT,session TEXT,data TEXT,fingerprint TEXT UNIQUE,created TEXT);
      CREATE TABLE IF NOT EXISTS atoms(id TEXT PRIMARY KEY,instance TEXT,team TEXT,agent TEXT,user TEXT,task TEXT,session TEXT,data TEXT,fingerprint TEXT UNIQUE,created TEXT);
      CREATE TABLE IF NOT EXISTS atom_revisions(id TEXT,data TEXT,changed_by TEXT,created TEXT);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,instance TEXT,team TEXT,agent TEXT,user TEXT,task TEXT,session TEXT,status TEXT DEFAULT 'pending',attempts INTEGER DEFAULT 0,error TEXT,model TEXT,prompt_version TEXT,created TEXT);
      CREATE TABLE IF NOT EXISTS entries(id TEXT PRIMARY KEY,instance TEXT,team TEXT,agent TEXT,user TEXT,scope TEXT,status TEXT,data TEXT,version INTEGER,protected INTEGER DEFAULT 0,created TEXT,updated TEXT);
      CREATE TABLE IF NOT EXISTS candidates(id TEXT PRIMARY KEY,instance TEXT,team TEXT,agent TEXT,user TEXT,task TEXT,session TEXT,status TEXT,data TEXT,fingerprint TEXT UNIQUE,target_id TEXT,created TEXT);
      CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY,instance TEXT,team TEXT,agent TEXT,user TEXT,target_id TEXT,target_version INTEGER,operation TEXT,status TEXT,data TEXT,before_data TEXT,created TEXT,updated TEXT);
      CREATE TABLE IF NOT EXISTS revisions(id TEXT,version INTEGER,data TEXT,status TEXT,actor TEXT,created TEXT,PRIMARY KEY(id,version));
      CREATE TABLE IF NOT EXISTS tombstones(instance TEXT,team TEXT,agent TEXT,user TEXT,fingerprint TEXT,created TEXT,PRIMARY KEY(instance,team,agent,user,fingerprint));
      CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,instance TEXT,team TEXT,agent TEXT,user TEXT,action TEXT,target TEXT,created TEXT);
      CREATE TABLE IF NOT EXISTS operations(instance TEXT,user TEXT,key TEXT,fingerprint TEXT,result TEXT,PRIMARY KEY(instance,user,key));
      CREATE INDEX IF NOT EXISTS entries_scope ON entries(instance,team,agent,user,scope,status);
    `);
    this.db.prepare("UPDATE jobs SET status='pending' WHERE status='running'").run();
    this.db.exec("UPDATE jobs SET status='superseded' WHERE status='pending' AND id NOT IN (SELECT MIN(id) FROM jobs WHERE status='pending' GROUP BY instance,team,agent,user,task,session)");
  }
  all(sql: string, ...args: any[]): any[] { return this.db.prepare(sql).all(...args) as any[]; }
  one(sql: string, ...args: any[]): any { return this.db.prepare(sql).get(...args); }
  scope(c: Identity) { return [c.instance,c.team,c.agent]; }
  transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const r=fn();this.db.exec('COMMIT');return r; } catch(e) { this.db.exec('ROLLBACK');throw e; } }
  mutation(c: Identity, key: string, request: unknown, action: string, target: string, fn: () => any) {
    if (!key || key.length > 160) throw new ContractError(422,'缺少操作标识');
    return this.transaction(() => {
      const prior=this.one('SELECT * FROM operations WHERE instance=? AND user=? AND key=?',c.instance,c.user,key), fingerprint=hash([c.team,c.agent,request]);
      if(prior) { if(prior.fingerprint!==fingerprint)throw new ContractError(409,'操作标识已用于其他请求');return JSON.parse(prior.result); }
      const result=fn();
      this.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)').run(id(),...this.scope(c),c.user,action,target,now());
      this.db.prepare('INSERT INTO operations VALUES(?,?,?,?,?)').run(c.instance,c.user,key,fingerprint,JSON.stringify(result));
      return result;
    });
  }
  list(c: Identity, scope='personal') {
    if(!['personal','team'].includes(scope))throw new ContractError(422,'范围无效');
    return this.all("SELECT * FROM entries WHERE instance=? AND team=? AND agent=? AND scope=? AND status='active' AND json_extract(data,'$.schema_version')=2 AND (scope='team' OR user=?) ORDER BY updated DESC",...this.scope(c),scope,c.user).map(parse);
  }
  entry(c: Identity, eid: string, edit=false) {
    const e=parse(this.one('SELECT * FROM entries WHERE id=? AND instance=? AND team=? AND agent=?',eid,...this.scope(c)));
    if(!e || (e.scope==='personal' && e.user!==c.user))throw new ContractError(404,'内容不存在');
    if(edit && e.scope!=='personal')throw new ContractError(403,'团队内容需要提交审核');
    return e;
  }
  history(c: Identity, eid: string) { this.entry(c,eid);return this.all('SELECT * FROM revisions WHERE id=? ORDER BY version DESC',eid).map(parse); }
  revision(e: any,c: Identity) { this.db.prepare('INSERT INTO revisions VALUES(?,?,?,?,?,?)').run(e.id,e.version,JSON.stringify(e.data),e.status,c.user,now()); }
  create(c: Identity, data: Content) {
    data={...data,schema_version:2};
    const eid=id(),ts=now();this.db.prepare('INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(eid,...this.scope(c),c.user,'personal','active',JSON.stringify(data),1,1,ts,ts);
    const e=this.entry(c,eid);this.revision(e,c);return e;
  }
  edit(c: Identity,eid: string,version: number,data: Content|null) {
    const e=this.entry(c,eid,true);if(data && data.kind!==e.data.kind)throw new ContractError(422,'编辑不能改变记忆层级，请按新的来源重新整理');if(data)data={...data,schema_version:2,subtype:data.subtype || e.data.subtype};if(e.version!==version || e.status!=='active')throw new ContractError(409,'内容已更新，请刷新后重试');
    this.db.prepare('UPDATE entries SET data=?,status=?,version=version+1,protected=1,updated=? WHERE id=?').run(JSON.stringify(data ?? e.data),data?'active':'deleted',now(),eid);
    if(!data) this.block(c,e.data);
    const next=this.entry(c,eid);this.revision(next,c);return next;
  }
  fingerprint(c: Identity,data: Content) {
    const sources=data.source_ids.flatMap(sid=>{
      const atom=this.one('SELECT data,task FROM atoms WHERE id=? AND instance=? AND team=? AND agent=? AND user=?',sid,...this.scope(c),c.user);
      if(!atom)return [sid];const d=JSON.parse(atom.data);
      return d.document_refs?.length?d.document_refs.map((r:any)=>'doc:'+atom.task+':'+r.document_id+':'+r.version+':'+r.paragraph_id):(d.source_ids || [sid]);
    });
    return hash([...this.scope(c),c.user,data.kind,[...new Set(sources)].sort(),canonicalTopic(data.topic)]);
  }
  block(c: Identity,data: Content) { this.db.prepare('INSERT OR IGNORE INTO tombstones VALUES(?,?,?,?,?,?)').run(...this.scope(c),c.user,this.fingerprint(c,data),now()); }
  candidates(c: Identity,session?:string) { return this.all("SELECT * FROM candidates WHERE instance=? AND team=? AND agent=? AND user=? AND status='pending' AND json_extract(data,'$.schema_version')=2"+(session?' AND session=?':'')+' ORDER BY created',...this.scope(c),c.user,...(session?[session]:[])).map(parse); }
  proposeCandidate(c: Identity,task:string,session:string,data:Content) {
    data={...data,schema_version:2};
    const fingerprint=this.fingerprint(c,data);
    if(this.one('SELECT 1 FROM tombstones WHERE instance=? AND team=? AND agent=? AND user=? AND fingerprint=?',...this.scope(c),c.user,fingerprint))return;
    // Never overwrite a human decision. New sources may create a separate suggestion.
    if(this.all('SELECT data FROM candidates WHERE instance=? AND team=? AND agent=? AND user=?',...this.scope(c),c.user).some(row=>this.fingerprint(c,JSON.parse(row.data))===fingerprint))return;
    this.db.prepare('INSERT INTO candidates VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id(),...this.scope(c),c.user,task,session,'pending',JSON.stringify(data),fingerprint,null,now());
  }
  confirm(c:Identity,cid:string,data?:Content,ignore=false) {
    const p=parse(this.one('SELECT * FROM candidates WHERE id=? AND instance=? AND team=? AND agent=? AND user=?',cid,...this.scope(c),c.user));
    if(!p || p.status!=='pending')throw new ContractError(409,'建议已处理或不存在');
    if(data && data.kind!==p.data.kind)throw new ContractError(422,'候选确认不能改变记忆层级');
    if(data && hash(data.source_ids)!==hash(p.data.source_ids))throw new ContractError(422,'来源不能由编辑内容替换');
    this.db.prepare('UPDATE candidates SET status=? WHERE id=?').run(ignore?'ignored':'confirmed',cid);
    if(ignore){this.block(c,p.data);return {ignored:true};}
    const confirmed=data ?? p.data;const targets=(p.data.conflicts || []).filter((x:any)=>x.relation==='supersedes'||x.relation==='contradicts');
    if(targets.length===1){const old=this.entry(c,targets[0].existing_id,true);if(old.version!==targets[0].existing_version || old.status!=='active')throw new ContractError(409,'被更新内容已变化');return this.edit(c,old.id,old.version,{...confirmed,conflicts:[]});}
    return this.create(c,confirmed);
  }
  proposal(c:Identity,eid:string,operation:string,data:Content|null,version:number) {
    const e=this.entry(c,eid);if(!['share','update','delete'].includes(operation) || (operation==='share' && e.scope!=='personal') || (operation!=='share' && e.scope!=='team'))throw new ContractError(422,'共享操作无效');
    if(e.status!=='active' || e.version!==version)throw new ContractError(409,'内容已更新，请刷新');
    // A shared copy never carries private source IDs into a public payload.
    const published=operation==='delete'?e.data:data;
    if((e.data.kind==='preference'&&e.data.subtype==='communication_preference')||(published?.kind==='preference'&&(/称呼用户|叫我|称呼偏好|call me/i.test(published.content)||published.subtype==='communication_preference')))throw new ContractError(422,'个人称呼和语气不能共享到团队');
    if(!published)throw new ContractError(422,'请提供最终发布内容');
    const pid=id(),ts=now();this.db.prepare('INSERT INTO proposals VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(pid,...this.scope(c),c.user,eid,version,operation,'pending',JSON.stringify({...published,schema_version:2,source_ids:[]}),JSON.stringify(e.scope==='team'?e.data:null),ts,ts);
    return parse(this.one('SELECT * FROM proposals WHERE id=?',pid));
  }
  proposals(c:Identity) { return this.all("SELECT * FROM proposals WHERE instance=? AND team=? AND agent=? AND (user=? OR ?='admin') ORDER BY created DESC",...this.scope(c),c.user,c.role).map(parse); }
  review(c:Identity,pid:string,approved:boolean) {
    if(c.role!=='admin')throw new ContractError(403,'需要团队管理员审核');
    const p=parse(this.one('SELECT * FROM proposals WHERE id=? AND instance=? AND team=? AND agent=?',pid,...this.scope(c)));
    if(!p || p.status!=='pending')throw new ContractError(409,'申请已处理或不存在');
    // Original personal entry is not inspected by reviewer; version is checked internally.
    const original=this.one('SELECT * FROM entries WHERE id=?',p.target_id);
    if(approved && original && JSON.parse(original.data).schema_version!==2)throw new ContractError(409,'旧版共享需重新复核');
    if(approved && (!original || original.version!==p.target_version || original.status!=='active'))throw new ContractError(409,'来源版本已改变，请重新提交');
    if(approved) {
      if(p.operation==='share') {
        const eid=id(),ts=now();this.db.prepare('INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(eid,...this.scope(c),'','team','active',JSON.stringify(p.data),1,1,ts,ts);this.revision(this.entry(c,eid),c);
      } else {
        this.db.prepare('UPDATE entries SET data=?,status=?,version=version+1,protected=1,updated=? WHERE id=?').run(JSON.stringify(p.data),p.operation==='delete'?'deleted':'active',now(),p.target_id);this.revision(this.entry(c,p.target_id),c);
      }
    }
    this.db.prepare('UPDATE proposals SET status=?,updated=? WHERE id=?').run(approved?'approved':'rejected',now(),pid);
    return {id:pid,status:approved?'approved':'rejected'};
  }
  context(c:Identity,task:string,session:string,data:any) { this.db.prepare('INSERT INTO contexts VALUES(?,?,?,?,?,?,?) ON CONFLICT(instance,team,agent,user,session) DO UPDATE SET data=excluded.data').run(...this.scope(c),c.user,task,session,JSON.stringify(data)); }
  capture(c:Identity,task:string,session:string,messages:any[],model:string,promptVersion:string) {
    if(!session || !task || !Array.isArray(messages) || messages.length>100 || messages.some(m=>!['user','assistant','tool','system'].includes(m.role)||typeof m.content!=='string'||m.content.length>20000))throw new ContractError(422,'原始对话格式无效');
    return this.transaction(()=>{
      let count=0;
      for(const m of messages) {
        const fp=hash([...this.scope(c),c.user,task,session,m.source_event_id || null,m.role,m.content]),mid='msg_'+fp.slice(0,32);
        const n=this.db.prepare('INSERT OR IGNORE INTO raw VALUES(?,?,?,?,?,?,?,?,?,?)').run(mid,...this.scope(c),c.user,task,session,JSON.stringify({role:m.role,content:m.content,source_event_id:m.source_event_id,tool_name:m.tool_name,tool_path:m.tool_path,chunk_group:m.chunk_group,chunk_index:m.chunk_index,chunk_count:m.chunk_count,evidence_context:JSON.parse(this.one('SELECT data FROM contexts WHERE instance=? AND team=? AND agent=? AND user=? AND session=?',...this.scope(c),c.user,session)?.data || '{}')}),fp,now());count+=Number(n.changes);
      }
      if(count && !this.one("SELECT 1 FROM jobs WHERE instance=? AND team=? AND agent=? AND user=? AND session=? AND status='pending'",...this.scope(c),c.user,session))this.db.prepare('INSERT INTO jobs(id,instance,team,agent,user,task,session,model,prompt_version,created) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id(),...this.scope(c),c.user,task,session,model,promptVersion,now());
      return {messages_added:count,session_id:session,pipeline_status:count?'pending':'unchanged'};
    });
  }
  raw(c:Identity,session?:string) {
    const rows=this.all('SELECT * FROM raw WHERE instance=? AND team=? AND agent=? AND user=?'+(session?' AND session=?':'')+' ORDER BY created,rowid',...this.scope(c),c.user,...(session?[session]:[])).map(parse);
    const groups=new Map<string,any[]>(),result:any[]=[];
    for(const row of rows){if(!row.data.chunk_group){result.push(row);continue;}const key=row.session+':'+row.data.chunk_group;const parts=groups.get(key)||[];parts.push(row);groups.set(key,parts);}
    for(const parts of groups.values()){parts.sort((a,b)=>a.data.chunk_index-b.data.chunk_index);if(parts.length!==parts[0].data.chunk_count)continue;result.push({...parts[0],data:{...parts[0].data,content:parts.map(p=>p.data.content).join('')}});}
    return result.sort((a,b)=>a.created.localeCompare(b.created));
  }
  atoms(c:Identity) {return this.all('SELECT * FROM atoms WHERE instance=? AND team=? AND agent=? AND user=?',...this.scope(c),c.user).map(parse);}
  saveAtoms(c:Identity,task:string,session:string,records:any[]) {
    const sources=new Set(this.raw(c,session).map(r=>r.id));
    const kinds=['contract_fact','human_opinion','decision','agent_suggestion','execution_result','preference','open_issue'];
    for(const r of records) {
      if(!kinds.includes(r.kind)||typeof r.content!=='string'||!Array.isArray(r.source_ids)||!r.source_ids.length||r.source_ids.some((s:string)=>!sources.has(s))||!Array.isArray(r.conditions)||!Array.isArray(r.exceptions))throw new ContractError(422,'抽取结果缺少有效依据或条件');
      // Decisions from speech are not approval; executing a tool is not approval either.
      const safe:any={content:r.content,kind:r.kind,topic:canonicalTopic(String(r.topic || '')),conditions:r.conditions,exceptions:r.exceptions,source_ids:r.source_ids,business_state:r.business_state==='confirmed'?'confirmed':'proposed',validity:['active','withdrawn','superseded'].includes(r.validity)?r.validity:'active',perspective:typeof r.perspective==='string'?r.perspective:null};
      const refs=Array.isArray(r.document_refs)?r.document_refs:[];
      for(const ref of refs){
        const raw=this.raw(c,session).find(m=>m.id===ref.source_id);
        const doc=raw?.data.evidence_context?.documents?.find((d:any)=>d.document_id===ref.document_id && d.version===ref.version);
        const p=doc?.paragraphs?.find((p:any)=>p.id===ref.paragraph_id);
        const normalized=raw?.data.content.replace(/^\s*\d+\s*[:|] ?/gm,'') || '';
        const at=p?normalized.indexOf(p.citation):-1;
        const tail=at>=0?normalized.slice(at+p.citation.length):'';
        const quote=tail.split(/\n(?:【D[^】]+:B\d+】|<\/(?:content|file)>|\(End of file)/)[0].trim();
        if(!raw || raw.data.role!=='tool' || raw.data.tool_name!=='read' || (doc?.read_path && raw.data.tool_path!==doc.read_path) || !r.source_ids.includes(ref.source_id) || !p || at<0 || createHash('sha256').update(quote).digest('hex')!==p.hash)throw new ContractError(422,'文档版本或段落引用无法核验');
      }
      const roles=r.source_ids.map((sid:string)=>this.raw(c,session).find(m=>m.id===sid)?.data.role);
      if(roles.every((role:string)=>role==='assistant') && ['contract_fact','human_opinion','decision','execution_result','preference'].includes(safe.kind))safe.kind='agent_suggestion';
      safe.document_refs=refs;
      safe.evidence_status=refs.length?'verified_document':'message_only';
      const supersedes=Array.isArray(r.supersedes_ids)?r.supersedes_ids:[];
      for(const previousId of supersedes){
        const previous=this.one('SELECT * FROM atoms WHERE id=? AND instance=? AND team=? AND agent=? AND user=? AND task=?',previousId,...this.scope(c),c.user,task);
        if(!previous)throw new ContractError(422,'撤回或替代来源无效');
        this.db.prepare('INSERT INTO atom_revisions VALUES(?,?,?,?)').run(previous.id,previous.data,r.source_ids[0],now());
        this.db.prepare('UPDATE atoms SET data=? WHERE id=?').run(JSON.stringify({...JSON.parse(previous.data),validity:r.validity==='withdrawn'?'withdrawn':'superseded'}),previous.id);
      }
      const fp=hash([...this.scope(c),c.user,task,safe]);this.db.prepare('INSERT OR IGNORE INTO atoms VALUES(?,?,?,?,?,?,?,?,?,?)').run('atom_'+fp.slice(0,32),...this.scope(c),c.user,task,session,JSON.stringify(safe),fp,now());
    }
  }
  jobs(c:Identity) {return this.all('SELECT id,status,attempts,error,model,prompt_version,session,created FROM jobs WHERE instance=? AND team=? AND agent=? AND user=? ORDER BY created DESC',...this.scope(c),c.user);}
}
