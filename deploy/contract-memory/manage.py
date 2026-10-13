#!/usr/bin/env python3
"""Isolated local stack. Secrets remain in ignored owner-readable state files."""
import argparse,json,os,secrets,subprocess,time,urllib.request,urllib.error,hashlib,re
import yaml
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2];STATE=Path(__file__).resolve().parent/'state'
CORE='tdai-contract-core';PROXY='tdai-contract-proxy'
def run(args,**kw):
 result=subprocess.run(args,**kw)
 if result.returncode:raise RuntimeError('Docker operation failed; arguments suppressed to protect credentials')
 return result
def start(source,model_config=None):
 os.umask(0o077);STATE.mkdir(exist_ok=True)
 revision=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
 prompt=(ROOT/'MemoryCore/src/contract-memory/prompts.ts').read_text()
 version=re.search(r"CONTRACT_PROMPT_VERSION = ['\"]([^'\"]+)",prompt).group(1)
 source_digest=hashlib.sha256(b''.join(p.read_bytes() for p in sorted(ROOT.glob('Memory*/src/**/*.ts')))).hexdigest()
 image_tag=version+'-'+revision[:8]+'-'+source_digest[:8]
 for orig,name in [('.memory-core-config/tdai-gateway.yaml','core.yaml'),('.proxy-config/config.yaml','proxy.yaml')]:
  p=STATE/name
  if not p.exists():
   text=(source/orig).read_text().replace('http://memory-core:8420','http://tdai-contract-core:8420').replace('http://127.0.0.1:8096','http://127.0.0.1:8106');p.write_text(text);p.chmod(0o600)
 control=STATE/'control.key'
 if not control.exists():control.write_text(secrets.token_urlsafe(48));control.chmod(0o600)
 value=control.read_text().strip();env=STATE/'core.env';env_lines=['CONTRACT_MEMORY_CONTROL_KEY='+value]
 # Explicit opt-in only; this script is not run during test-pack preparation.
 selected_model=STATE/'contract-model.json'
 if model_config:
  model_text=model_config.read_text();model=json.loads(model_text)['roles']['memory_extraction']
  if model['provider'] not in ['codex_subscription','openai_compatible']:raise ValueError('Unsupported contract model provider')
  secret_name=model.get('token_env','CONTRACT_EXTRACTION_ADAPTER_TOKEN') if model['provider']=='codex_subscription' else model.get('api_key_env','DEEPSEEK_API_KEY')
  if not re.fullmatch('[A-Z][A-Z0-9_]*',secret_name) or not os.environ.get(secret_name):raise ValueError('Model credential environment variable is missing')
  if '\n' in os.environ[secret_name]:raise ValueError('Invalid model credential')
  selected_model.write_text(model_text);selected_model.chmod(0o600)
  env_lines += ['CONTRACT_MEMORY_MODEL_CONFIG=/data/config/contract-model.json',secret_name+'='+os.environ[secret_name]]
 elif selected_model.exists():
  # Keep the previously opted-in private model settings across a rebuild.
  prior=env.read_text().splitlines() if env.exists() else []
  env_lines += [line for line in prior if not line.startswith('CONTRACT_MEMORY_CONTROL_KEY=')]
 env.write_text('\n'.join(env_lines)+'\n');env.chmod(0o600)
 proxy=STATE/'proxy.yaml';text=proxy.read_text();text=re.sub(r'(^tdai:\n[\s\S]*?\n  apiKey:)\s*[^\n]+',lambda m:m.group(1)+' '+json.dumps(value),text,count=1,flags=re.MULTILINE);proxy.write_text(text);proxy.chmod(0o600)
 # OpenHarvey owns its contract Skills. This dedicated stack only supplies
 # memory; upstream auto-generated cloud Skills must not duplicate them.
 proxy_config=yaml.safe_load(proxy.read_text())
 proxy_config.setdefault('injection',{})['injectors']=['tdai-memory']
 proxy_config.setdefault('extraction',{})['extractors']=['tdai-memory']
 proxy.write_text(yaml.safe_dump(proxy_config,allow_unicode=True,sort_keys=False));proxy.chmod(0o600)
 run(['docker','network','create','tdai-contract-stack'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL) if subprocess.run(['docker','network','inspect','tdai-contract-stack'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode else None
 for name,dockerfile,base in [(CORE,'core','local/tdai-memory-core:8b86874a'),(PROXY,'proxy','local/tdai-memory-proxy:8b86874a')]:
  run(['docker','build','-f',str(STATE.parent/('Dockerfile.'+dockerfile)),'--label','org.opencontainers.image.base.revision=8b86874a2daea49e3ff0fb53d699203146c5c77d','--label','org.opencontainers.image.revision='+revision,'--label','org.opencontainers.image.version='+version,'--label','contract.source.digest='+source_digest,'-t','local/'+name+':'+image_tag,str(ROOT)])
 # Reuse the independent experiment volumes across restarts, never the old stack's volumes.
 for name,port,inside,config,data in [(CORE,8430,8420,'core.yaml','/data/tdai-memory'),(PROXY,8106,8096,'proxy.yaml','/data/tdai-memory-proxy')]:
  if subprocess.run(['docker','inspect',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:run(['docker','rm','-f',name],stdout=subprocess.DEVNULL)
  env=['--env-file',str(STATE/'core.env'),'-e','STORE_MODE=sqlite','-e','TDAI_METADATA_BACKEND=sqlite','-e','TDAI_METADATA_SQLITE_PATH=/data/tdai-memory/metadata.sqlite'] if name==CORE else []
  if name==CORE and selected_model.exists():env+=['-v',f'{selected_model}:/data/config/contract-model.json:ro']
  run(['docker','run','-d','--name',name,'--network','tdai-contract-stack','--restart','unless-stopped','-p',f'127.0.0.1:{port}:{inside}','-v',f'{STATE/config}:/data/config/tdai-gateway.yaml:ro' if name==CORE else f'{STATE/config}:/data/config.yaml:ro','-v',f'{name}-data:{data}',*env,'local/'+name+':'+image_tag],stdout=subprocess.DEVNULL)
  # Core must be healthy before Proxy starts accepting model requests.
  port_to_wait=port
  for _ in range(60):
   try:
    with urllib.request.urlopen(f'http://127.0.0.1:{port_to_wait}/health',timeout=2) as r:assert r.status==200
    break
   except Exception:time.sleep(1)
  else:raise SystemExit(f'Health failed on {port_to_wait}; inspect private docker logs')
 for port in [8430,8106]:
  for _ in range(45):
   try:
    with urllib.request.urlopen(f'http://127.0.0.1:{port}/health',timeout=2) as r:assert r.status==200
    break
   except Exception:time.sleep(1)
  else:raise SystemExit(f'Health failed on {port}; inspect docker logs')
 keyfile=STATE/'admin.key'
 if not keyfile.exists():keyfile.write_text('sk-mem-'+secrets.token_urlsafe(36));keyfile.chmod(0o600)
 req=urllib.request.Request('http://127.0.0.1:8430/v3/internal/meta/user/init-admin',data=json.dumps({'username':'contract-admin','user_key':keyfile.read_text().strip()}).encode(),headers={'Content-Type':'application/json','x-tdai-service-id':'default'},method='POST')
 try:
  with urllib.request.urlopen(req) as r:result=json.load(r)
 except urllib.error.HTTPError as e:
  if e.code!=409:raise
  verify=urllib.request.Request('http://127.0.0.1:8430/v3/meta/auth/verify',data=json.dumps({'user_key':keyfile.read_text().strip()}).encode(),headers={'Content-Type':'application/json','x-tdai-service-id':'default'},method='POST')
  with urllib.request.urlopen(verify) as r:existing=json.load(r)
  if not existing.get('data',{}).get('valid'):raise RuntimeError('Existing initialization credential is invalid')
 images=[]
 for name in [CORE,PROXY]:
  item=json.loads(subprocess.check_output(['docker','image','inspect','local/'+name+':'+image_tag]))[0];images.append({'name':name,'id':item['Id'],'tag':image_tag,'base_revision':'8b86874a'})
 (STATE/'deployment.json').write_text(json.dumps({'images':images,'ports':{'core':8430,'proxy':8106},'prompt_version':version,'source_sha256':source_digest,'git':revision,'config_sha256':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in [STATE/'core.yaml',STATE/'proxy.yaml',selected_model] if p.exists()}},indent=2))
 print('Contract Memory ready: Core 8430 / Proxy 8106; initialization credential in ignored state/admin.key')
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('action',choices=['start','stop','restart']);p.add_argument('--source',type=Path,default=Path('/Users/dicam/CodeDir/TencentDB-Agent-Memory/deploy/global-images'));p.add_argument('--contract-model-config',type=Path);a=p.parse_args()
 if a.action=='start':start(a.source,a.contract_model_config)
 elif a.contract_model_config:p.error('Model settings require explicit start/rebuild; restart does not change configuration')
 else:run(['docker',a.action,CORE,PROXY])
