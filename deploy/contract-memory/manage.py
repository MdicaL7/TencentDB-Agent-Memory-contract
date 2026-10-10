#!/usr/bin/env python3
"""Isolated local stack. Secrets remain in ignored owner-readable state files."""
import argparse,json,os,secrets,subprocess,time,urllib.request,urllib.error,hashlib,re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2];STATE=Path(__file__).resolve().parent/'state'
CORE='tdai-contract-core';PROXY='tdai-contract-proxy'
def run(args,**kw):
 result=subprocess.run(args,**kw)
 if result.returncode:raise RuntimeError('Docker operation failed; arguments suppressed to protect credentials')
 return result
def start(source):
 os.umask(0o077);STATE.mkdir(exist_ok=True)
 for orig,name in [('.memory-core-config/tdai-gateway.yaml','core.yaml'),('.proxy-config/config.yaml','proxy.yaml')]:
  p=STATE/name
  if not p.exists():
   text=(source/orig).read_text().replace('http://memory-core:8420','http://tdai-contract-core:8420').replace('http://127.0.0.1:8096','http://127.0.0.1:8106');p.write_text(text);p.chmod(0o600)
 control=STATE/'control.key'
 if not control.exists():control.write_text(secrets.token_urlsafe(48));control.chmod(0o600)
 value=control.read_text().strip();env=STATE/'core.env';env.write_text('CONTRACT_MEMORY_CONTROL_KEY='+value+'\n');env.chmod(0o600)
 proxy=STATE/'proxy.yaml';text=proxy.read_text();text=re.sub(r'(^tdai:\n[\s\S]*?\n  apiKey:)\s*[^\n]+',lambda m:m.group(1)+' '+json.dumps(value),text,count=1,flags=re.MULTILINE);proxy.write_text(text);proxy.chmod(0o600)
 run(['docker','network','create','tdai-contract-stack'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL) if subprocess.run(['docker','network','inspect','tdai-contract-stack'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode else None
 for name,dockerfile,base in [(CORE,'core','local/tdai-memory-core:8b86874a'),(PROXY,'proxy','local/tdai-memory-proxy:8b86874a')]:
  run(['docker','build','-f',str(STATE.parent/('Dockerfile.'+dockerfile)),'--label','org.opencontainers.image.base.revision=8b86874a2daea49e3ff0fb53d699203146c5c77d','-t','local/'+name+':contract-v1',str(ROOT)])
 # Reuse the independent experiment volumes across restarts, never the old stack's volumes.
 for name,port,inside,config,data in [(CORE,8430,8420,'core.yaml','/data/tdai-memory'),(PROXY,8106,8096,'proxy.yaml','/data/tdai-memory-proxy')]:
  if subprocess.run(['docker','inspect',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:run(['docker','rm','-f',name],stdout=subprocess.DEVNULL)
  env=['--env-file',str(STATE/'core.env'),'-e','STORE_MODE=sqlite','-e','TDAI_METADATA_BACKEND=sqlite','-e','TDAI_METADATA_SQLITE_PATH=/data/tdai-memory/metadata.sqlite'] if name==CORE else []
  run(['docker','run','-d','--name',name,'--network','tdai-contract-stack','--restart','unless-stopped','-p',f'127.0.0.1:{port}:{inside}','-v',f'{STATE/config}:/data/config/tdai-gateway.yaml:ro' if name==CORE else f'{STATE/config}:/data/config.yaml:ro','-v',f'{name}-data:{data}',*env,'local/'+name+':contract-v1'],stdout=subprocess.DEVNULL)
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
  item=json.loads(subprocess.check_output(['docker','image','inspect','local/'+name+':contract-v1']))[0];images.append({'name':name,'id':item['Id'],'base_revision':'8b86874a'})
 (STATE/'deployment.json').write_text(json.dumps({'images':images,'ports':{'core':8430,'proxy':8106},'source_sha256':hashlib.sha256(b''.join(p.read_bytes() for p in sorted(ROOT.glob('Memory*/src/**/*.ts')))).hexdigest(),'git':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()},indent=2))
 print('Contract Memory ready: Core 8430 / Proxy 8106; initialization credential in ignored state/admin.key')
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('action',choices=['start','stop','restart']);p.add_argument('--source',type=Path,default=Path('/Users/dicam/CodeDir/TencentDB-Agent-Memory/deploy/global-images'));a=p.parse_args()
 if a.action=='start':start(a.source)
 else:run(['docker',a.action,CORE,PROXY])
