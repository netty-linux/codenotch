"""Real LiteLLM Router + local HTTP 429 fixture; no external provider calls."""
import json
import threading
import os
import pathlib
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error
import yaml
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
os.environ.setdefault('LITELLM_LOCAL_MODEL_COST_MAP', 'True')
from litellm import Router

seen = []
class Provider(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        seen.append(body['model'])
        if body['model'] == 'primary':
            self.send_response(429)
            result = {'error': {'message': 'Synthetic rate limit', 'type': 'rate_limit_error', 'code': 'rate_limit_exceeded'}}
        else:
            self.send_response(200)
            result = {'id':'fixture','object':'chat.completion','created':1,'model':'backup','choices':[{'index':0,'message':{'role':'assistant','content':'fallback ok'},'finish_reason':'stop'}],'usage':{'prompt_tokens':1,'completion_tokens':2,'total_tokens':3}}
        self.send_header('Content-Type','application/json')
        self.end_headers()
        self.wfile.write(json.dumps(result).encode())

server = ThreadingHTTPServer(('127.0.0.1',0), Provider)
threading.Thread(target=server.serve_forever,daemon=True).start()
try:
    router = Router(model_list=[{'model_name':name,'litellm_params':{'model':f'openai/{name}','api_base':f'http://127.0.0.1:{server.server_port}/v1','api_key':'fixture-only'}} for name in ['primary','backup']],fallbacks=[{'primary':['backup']}],num_retries=0,timeout=5)
    response = router.completion(model='primary',messages=[{'role':'user','content':'test'}])
    assert response.choices[0].message.content == 'fallback ok'
    assert 'primary' in seen and 'backup' in seen
    print('PASS: actual HTTP 429 -> LiteLLM fallback -> backup response')
    if '--proxy' in sys.argv:
        # Start the real gateway using the shipped config and local model fixtures.
        config = yaml.safe_load((pathlib.Path(__file__).parents[1] / 'litellm_config.yaml').read_text())
        for index, model in enumerate(config['model_list']):
            model['litellm_params'] = {'model': 'openai/primary' if index == 0 else 'openai/backup', 'api_key':'fixture-only', 'api_base':f'http://127.0.0.1:{server.server_port}/v1'}
        config['router_settings']['num_retries'] = 0
        with socket.socket() as port_socket:
            port_socket.bind(('127.0.0.1',0))
            proxy_port = port_socket.getsockname()[1]
        with tempfile.TemporaryDirectory(prefix='codenotch-proxy-test-') as temp:
            config_file = pathlib.Path(temp) / 'config.yaml'
            config_file.write_text(yaml.safe_dump(config))
            env = {k:v for k,v in os.environ.items() if k.upper() in {'PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','HOME','APPDATA','LOCALAPPDATA'}}
            env['LITELLM_MASTER_KEY'] = 'sk-' + secrets.token_hex(24)
            env['LITELLM_LOCAL_MODEL_COST_MAP'] = 'True'
            env['PYTHONUTF8'] = '1'
            env['PYTHONIOENCODING'] = 'utf-8'
            with open(pathlib.Path(temp) / 'proxy.log','w+',encoding='utf-8') as log:
                process = subprocess.Popen([sys.executable,'-c','from litellm import run_server; run_server()','--config',str(config_file),'--host','127.0.0.1','--port',str(proxy_port)],env=env,stdout=log,stderr=log,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
                try:
                    base=f'http://127.0.0.1:{proxy_port}'
                    headers={'Authorization':'Bearer '+env['LITELLM_MASTER_KEY'],'Content-Type':'application/json'}
                    deadline=time.monotonic()+90
                    while time.monotonic()<deadline:
                        if process.poll() is not None:
                            log.seek(0)
                            raise RuntimeError('Proxy exited: '+log.read()[-5000:].replace(env['LITELLM_MASTER_KEY'],'[redacted]'))
                        try:
                            with urllib.request.urlopen(urllib.request.Request(base+'/v1/models',headers=headers),timeout=2) as reply:
                                models=json.load(reply)
                            break
                        except OSError:
                            time.sleep(0.5)
                    else:
                        raise TimeoutError('Proxy startup timed out')
                    assert any(m['id']=='nvidia-nim' for m in models['data'])
                    payload=json.dumps({'model':'nvidia-nim','messages':[{'role':'user','content':'fixture test'}]}).encode()
                    with urllib.request.urlopen(urllib.request.Request(base+'/v1/chat/completions',data=payload,headers=headers),timeout=30) as reply:
                        completion=json.load(reply)
                    assert completion['choices'][0]['message']['content']=='fallback ok'
                    for _ in range(20):
                        with urllib.request.urlopen(urllib.request.Request(base+'/metrics',headers=headers),timeout=10) as reply:
                            metrics=reply.read().decode()
                        if any(line.startswith('litellm_proxy_total_requests_metric_total{') for line in metrics.splitlines()):
                            break
                        time.sleep(0.25)
                    else:
                        raise AssertionError('Request counter was not exported')
                    try:
                        urllib.request.urlopen(base+'/metrics',timeout=5).close()
                    except urllib.error.HTTPError as error:
                        assert error.code in (401,403)
                    else:
                        raise AssertionError('Metrics unexpectedly allowed unauthenticated access')
                    print('PASS: real proxy /v1/models, HTTP fallback completion and authenticated /metrics')
                finally:
                    if os.name == 'nt' and process.poll() is None:
                        # The LiteLLM CLI owns a uvicorn child; reap the entire owned tree.
                        subprocess.run(['taskkill','/PID',str(process.pid),'/T','/F'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=False,creationflags=subprocess.CREATE_NO_WINDOW)
                    elif process.poll() is None:
                        process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
                    time.sleep(0.25)
finally:
    server.shutdown()
    server.server_close()
