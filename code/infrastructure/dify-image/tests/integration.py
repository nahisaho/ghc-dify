"""Native final-image admission, workflow and MCP qualification."""
import json
import secrets
import urllib.request
from html.parser import HTMLParser

import fixture
from native import Console

ROLES = {"postgres", "redis", "api", "worker", "beat", "web", "plugin", "sandbox",
         "agent", "shellctl", "shell_broker", "squid", "agent_squid", "nginx", "sshd"}


def executions(state, app):
    """Count actual workflow runs; negative admission must not execute a graph."""
    code = """import json,sys
from common import env_for,run
app=json.loads(sys.stdin.read())
assert all(c in '0123456789abcdef-' for c in app)
r=run('postgres',['psql','-h','/run/dify/postgres','-U','dify_postgres',
 '-d','dify','-Atc',"select count(*) from workflow_runs where app_id='"+app+"'"],
 env=env_for('postgres'))
print(r.stdout.strip())
"""
    return int(fixture.execute(state, code, data=json.dumps(app)).stdout.strip())


def denied(client, state, app, code, require, tool):
    """Require both protocol denial and unchanged persisted execution count."""
    before = executions(state, app)
    status, result = client.mcp(code, "tools/call",
                               {"name": tool, "arguments": {}})
    require(status >= 400 or "error" in result or result.get("result", {}).get("isError"),
            "Invalid MCP access was admitted")
    require(executions(state, app) == before, "Denied MCP request executed a workflow")


def mcp(state, require):
    """Exercise all native MCP states without any external model credentials."""
    client = Console(state)
    app = client.workflow()
    server = client.server(app)
    tool = client.call_fixed(server)
    require(bool(tool), "Native workflow MCP handshake/list/call did not complete")
    old = server["server_code"]
    denied(client, state, app, secrets.token_urlsafe(32), require, tool)
    status, _ = client.request(f"/console/api/apps/{app}/server",
                               {"id": server["id"], "status": "inactive",
                                "description": "Fixed workflow verification", "parameters": {}}, method="PUT")
    require(status == 200, "Native MCP disable failed")
    denied(client, state, app, old, require, tool)
    status, _ = client.request(f"/console/api/apps/{app}/server",
                               {"id": server["id"], "status": "active",
                                "description": "Fixed workflow verification", "parameters": {}}, method="PUT")
    require(status == 200, "Native MCP reactivation failed")
    status, _ = client.request(f"/console/api/apps/{app}/server/refresh", {})
    require(status == 200, "Native MCP credential rotation failed")
    status, updated = client.request(f"/console/api/apps/{app}/server")
    require(status == 200 and updated["server_code"] != old, "Native MCP credential unchanged")
    denied(client, state, app, old, require, tool)
    client.call_fixed(updated)
    require(executions(state, app) == 2, "Unexpected native workflow execution count")
    unpublished = client.workflow(publish=False)
    status, response = client.request(f"/console/api/apps/{unpublished}/server",
                                      {"description": "Unpublished denial", "parameters": {}})
    if status in (200, 201):
        active_status, _ = client.request(f"/console/api/apps/{unpublished}/server",
                                         {"id": response["id"], "status": "active",
                                          "description": "Unpublished denial", "parameters": {}}, method="PUT")
        if active_status == 200:
            list_status, listing = client.mcp(response["server_code"], "tools/list")
            if list_status == 200 and "result" in listing:
                unpublished_tool = listing["result"]["tools"][0]["name"]
                denied(client, state, unpublished, response["server_code"], require, unpublished_tool)
            else:
                require(list_status >= 400 or "error" in listing, "Unpublished tools admitted")
        else:
            require(active_status >= 400, "Unpublished activation had no clear verdict")
    else:
        require(status >= 400, "Unpublished MCP was not rejected")
    require(executions(state, unpublished) == 0, "Unpublished workflow executed")
    logs = fixture.docker(["logs", state["container"]]).stdout
    require(all(code not in logs for code in (old, updated["server_code"])),
            "Credential-bearing native MCP path leaked to logs")


def services(state, require):
    """Every role needs its own actual protocol oracle, not merely an HTTP page."""
    code = """import json
from common import IDS,env_for
from probes import check
envs={r:env_for(r) for r in IDS}
roles=json.load(open('/run/dify/readiness.json'))['roles']
print(json.dumps({r:check(r,envs) for r in roles}))
"""
    roles = json.loads(fixture.execute(state, code, timeout=60).stdout)
    require(set(roles) == ROLES, "Required role omitted from actual readiness")
    for role, ready in roles.items():
        require(ready is True, "Native readiness failed: " + role)
    sharp = fixture.docker(["exec", state["container"], "/usr/local/bin/node", "-e",
                            ("require('/opt/sharp/node_modules/sharp')({create:{width:1,height:1,"
                            "channels:3,background:'#fff'}}).png().toBuffer().then(b=>"
                            "{if(b.length<50)process.exit(1);console.log('SHARP_PNG_OK')})")])
    require(sharp.stdout.strip() == "SHARP_PNG_OK", "glibc Sharp execution failed")
    class RuntimeHTML(HTMLParser):
        def handle_starttag(self, tag, attrs):
            if tag == "html":
                self.settings = dict(attrs)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    endpoint = "http://localhost:" + str(state.get("http_port", 8080)) + "/signin"
    with opener.open(endpoint, timeout=30) as response:
        require(response.status == 200, "Native web sign-in did not render")
        rendered = RuntimeHTML()
        rendered.feed(response.read().decode())
    settings = getattr(rendered, "settings", {})
    require(settings.get("data-api-prefix") == "/console/api"
            and settings.get("data-public-api-prefix") == "/api",
            "Browser API prefixes fall back to an unpublished port or double their paths")
    proxy = """import os,urllib.request,urllib.error
for name in ('NO_PROXY','no_proxy'):os.environ.pop(name,None)
for port in (3128,3129):
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({
  'http':'http://127.0.0.1:'+str(port),'https':'http://127.0.0.1:'+str(port)}))
 with opener.open('https://example.com/',timeout=30) as r:
  assert r.status==200;r.read(1024)
 try:opener.open('http://127.0.0.1:80/',timeout=5)
 except urllib.error.HTTPError as error:assert error.code==403
 else:raise AssertionError('private loopback proxy access admitted')
print('BOTH_PROXY_ALLOW_DENY_OK')
"""
    require(fixture.execute(state, proxy, timeout=75).stdout.strip() == "BOTH_PROXY_ALLOW_DENY_OK",
            "Cooperative proxy positive/negative controls failed")
    from jobs import call
    for role, payload in (
        ("sandbox", {"language": "python3", "code": "print(42,flush=True)", "enable_network": True}),
        ("sandbox", {"language": "nodejs", "code": "console.log(42)", "enable_network": True}),
        ("shellctl", {"script": "printf 42", "cwd": "/data/shellctl/home", "mode": "stdio"})):
        result = call(state, role, payload)
        body = result["body"]["data"] if role == "sandbox" else result["body"]
        require(result["http"] == 200 and not body.get("error")
                and body.get("exit_code", 0) == 0
                and body.get("stdout", body.get("output", "")).strip() == "42",
                "Required native job result failed: " + role)
    from rag import verify as rag_checks
    rag_checks(state, require)
    from failure import verify as failure_checks
    failure_checks(state, require)


def verify(number, require):
    """Each requirement dispatch executes only its own complete acceptance checks."""
    state = fixture.get()
    if number == "004":
        mcp(state, require)
    else:
        services(state, require)
