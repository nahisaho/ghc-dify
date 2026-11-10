"""Signed plugin installation and genuine Dify→provider→pgvector retrieval."""
import json
import select
import subprocess
import time
import uuid

import fixture
from native import Console

PLUGIN = "langgenius/ollama:1.0.3@1086758302d98263d5b7881de8ba95fc219351fdf97831d18a7807378674d203"
PROVIDER = "langgenius/ollama/ollama"
MODEL = "image-embedding"
NEEDLE = "SAPPHIRE_ORBIT_928"

# Test-only local model protocol, not a production service or a downloaded model.
# The two orthogonal document vectors supply an independent ranking oracle.
SERVER = r"""
import http.server,json,sys,threading
counts={'embedding_requests':0,'texts':0}
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def reply(self,value,status=200):
  body=json.dumps(value).encode();self.send_response(status)
  self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(body)
 def do_GET(self):
  if self.path=='/metrics':return self.reply(counts)
  if self.path=='/api/tags':return self.reply({'models':[{'name':'image-embedding'}]})
  if self.path=='/api/version':return self.reply({'version':'0.6.0'})
  self.reply({},404)
 def do_POST(self):
  p=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  if self.path=='/api/show':
   return self.reply({'model_info':{'image.context_length':8192},'parameters':'num_ctx 8192'})
  if self.path not in ('/api/embed','/api/embeddings'):return self.reply({},404)
  texts=p.get('input',p.get('prompt',[]))
  if isinstance(texts,str):texts=[texts]
  counts['embedding_requests']+=1;counts['texts']+=len(texts)
  vectors=[[1.0,0.0,0.0] if 'SAPPHIRE_ORBIT_928' in t else
           [0.0,1.0,0.0] if 'gardening' in t else [0.0,0.0,1.0] for t in texts]
  self.reply({'embeddings':vectors,'embedding':vectors[0],
              'model':'image-embedding','prompt_eval_count':len(texts)})
s=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
t=threading.Thread(target=s.serve_forever);t.start()
print(json.dumps({'port':s.server_port}),flush=True)
try:sys.stdin.buffer.read(1)
finally:s.shutdown();s.server_close();t.join()
"""


def verify(state, require):
    """Keep signing enabled and all credential-bearing responses in memory only."""
    client = Console(state)
    status, result = client.request("/console/api/workspaces/current/plugin/install/marketplace",
                                    {"plugin_unique_identifiers": [PLUGIN]})
    require(status == 200 and ("task_id" in result or result.get("all_installed")),
            "Native marketplace installation was not accepted")
    deadline = time.monotonic() + 150
    installed = None
    while time.monotonic() < deadline:
        status, result = client.request("/console/api/workspaces/current/plugin/list?page=1&page_size=100")
        installed = next((p for p in result.get("plugins", [])
                          if p["plugin_unique_identifier"] == PLUGIN), None)
        if installed:
            break
        time.sleep(0.5)
    require(status == 200 and installed is not None, "Signed provider installation deadline")
    require(installed["source"] == "marketplace" and installed["declaration"]["verified"] is True,
            "Installed provider lacks native signature verification")
    server = subprocess.Popen(
        ["docker", "exec", "-i", "--user", "2000:2000", state["container"],
         "/usr/local/bin/python3", "-u", "-c", SERVER],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        require(bool(select.select([server.stdout], [], [], 10)[0]), "Embedding fixture startup deadline")
        port = json.loads(server.stdout.readline())["port"]
        endpoint = "http://127.0.0.1:" + str(port)
        credential_path = "/console/api/workspaces/current/model-providers/" + PROVIDER + "/models/credentials"
        _, current = client.request(credential_path + "?model=" + MODEL +
                                    "&model_type=text-embedding&config_from=custom-model")
        payload = {"model": MODEL, "model_type": "text-embedding", "name": "local qualification",
                   "credentials": {"base_url": endpoint, "context_size": "8192"}}
        credential_id = current.get("current_credential_id")
        if credential_id:
            payload["credential_id"] = credential_id
        status, _ = client.request(credential_path, payload, method="PUT" if credential_id else "POST")
        require(status in (200, 201), "Native model credential/protocol validation failed")
        status, _ = client.request("/console/api/workspaces/current/default-model",
            {"model_settings": [{"model_type": "text-embedding", "model": MODEL, "provider": PROVIDER}]})
        require(status == 200, "Native default embedding selection failed")
        status, dataset = client.request("/console/api/datasets",
                                         {"name": "ImageRAG" + uuid.uuid4().hex[:8],
                                          "indexing_technique": "high_quality"})
        require(status in (200, 201) and bool(dataset.get("id")), "Native dataset creation failed")
        dataset_id = dataset["id"]
        status, key = client.request("/console/api/datasets/api-keys", {"dataset_ids": [dataset_id]})
        require(status == 200 and bool(key.get("token")), "Native scoped dataset API key failed")
        documents = []
        nonce = uuid.uuid4().hex
        for index, text in enumerate((
                NEEDLE + " identifies the astronomy control document. " + nonce,
                "gardening soil and green vegetables identify the negative control. " + nonce)):
            status, result = client.request(f"/v1/datasets/{dataset_id}/document/create-by-text",
                {"name": "control-" + str(index), "text": text, "indexing_technique": "high_quality",
                 "embedding_model": MODEL, "embedding_model_provider": PROVIDER,
                 "process_rule": {"mode": "automatic"}},
                headers={"Authorization": "Bearer " + key["token"]})
            require(status == 200 and bool(result.get("document")), "Native text indexing admission failed")
            documents.append(result["document"]["id"])
        require(len(set(documents)) == 2, "Native same-name upsert replaced a RAG control")
        for document in documents:
            deadline = time.monotonic() + 120
            while time.monotonic() < deadline:
                status, result = client.request(
                    f"/console/api/datasets/{dataset_id}/documents/{document}/indexing-status")
                if result.get("indexing_status") in ("completed", "error"):
                    break
                time.sleep(0.5)
            require(status == 200 and result.get("indexing_status") == "completed",
                    "Native asynchronous vector indexing failed")
        # A 0.5 threshold independently separates orthogonal cosine scores1/0.
        # Query both directions: excluding a zero-score result is correct native
        # behavior, not a missing document. Nonces prevent cross-run cache hits.
        for wanted, unwanted in ((NEEDLE, "gardening"), ("gardening", NEEDLE)):
            status, result = client.request(f"/console/api/datasets/{dataset_id}/hit-testing",
                {"query": wanted + " " + nonce, "retrieval_model": {"search_method": "semantic_search",
                 "reranking_enable": False, "top_k": 2, "score_threshold_enabled": True,
                 "score_threshold": 0.5}})
            records = result.get("records", [])
            require(status == 200, "Native retrieval HTTP failure: " + str(status))
            require(len(records) == 1, "Orthogonal retrieval threshold did not separate the controls")
            require(wanted in records[0]["segment"]["content"] and records[0]["score"] > 0.99
                    and unwanted not in records[0]["segment"]["content"],
                    "Orthogonal-vector retrieval differs from independent ranking oracle")
        code = """import json,sys,urllib.request
from common import run,env_for
port=json.load(sys.stdin)
metrics=json.load(urllib.request.urlopen('http://127.0.0.1:'+str(port)+'/metrics'))
assert metrics['texts']>=5 and metrics['embedding_requests']>=5
r=run('postgres',['psql','-h','/run/dify/postgres','-U','dify_postgres','-d','dify','-Atc',
 "select count(*) from pg_attribute a join pg_class c on c.oid=a.attrelid "
 "join pg_type t on t.oid=a.atttypid where t.typname='vector' and c.relkind='r'"],
 env=env_for('postgres'))
assert int(r.stdout.strip())>0
print('NATIVE_PGVECTOR_RAG_OK')
"""
        require(fixture.execute(state, code, data=json.dumps(port)).stdout.strip() == "NATIVE_PGVECTOR_RAG_OK",
                "Embedding or actual PostgreSQL vector column evidence absent")
    finally:
        server.stdin.close()
        try:
            server.wait(timeout=15)
        except subprocess.TimeoutExpired:
            # Closing the Docker exec stdin must end this bounded helper.
            server.terminate()
            server.wait(timeout=5)
            raise RuntimeError("Embedding helper did not stop on EOF") from None
