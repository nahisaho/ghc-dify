"""Native console and MCP behavioral fixtures; never emit credential URLs."""
import base64
import http.cookiejar
import json
import secrets
import urllib.error
import urllib.parse
import urllib.request

FIXED = "DIFY_IMAGE_OK"


class Console:
    """Use actual setup/login cookies and CSRF rather than bypassing admission."""
    def __init__(self, state):
        self.state = state
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                                  urllib.request.HTTPCookieProcessor(self.jar))
        status, result = self.request("/console/api/setup")
        assert status == 200
        if result["step"] == "not_started":
            status, _ = self.request("/console/api/setup", {
                "email": "image-check@example.com", "name": "Image validation",
                "password": state["admin_password"], "language": "en-US"})
            assert status in (200, 201), "Native manual setup failed"
        status, result = self.request("/console/api/login", {
            "email": "image-check@example.com",
            "password": base64.b64encode(state["admin_password"].encode()).decode(),
            "remember_me": False})
        assert status == 200 and result.get("result") == "success", "Native login failed"

    def request(self, path, body=None, method=None, headers=None):
        """Return response data privately; exception messages never contain URLs."""
        data = json.dumps(body).encode() if body is not None else None
        h = {"Content-Type": "application/json", "Accept": "application/json"}
        h.update(headers or {})
        for cookie in self.jar:
            if cookie.name.endswith("csrf_token"):
                h["X-CSRF-Token"] = urllib.parse.unquote(cookie.value)
        base = "http://localhost:" + str(self.state["http_port"])
        req = urllib.request.Request(base + path, data=data,
                                     headers=h, method=method)
        try:
            with self.opener.open(req, timeout=90) as response:
                raw, status = response.read(), response.status
        except urllib.error.HTTPError as error:
            raw, status = error.read(), error.code
        try:
            return status, json.loads(raw) if raw else {}
        except ValueError:
            raise RuntimeError("Unexpected native API response format") from None

    def workflow(self, publish=True):
        """Import an upstream-shaped Start→Python Code→End non-LLM workflow."""
        nodes = []
        specifications = [
            ("100", {"type": "start", "title": "Start", "variables": []}),
            ("200", {"type": "code", "title": "Constant", "code_language": "python3",
                     "code": f"def main() -> dict:\n    return {{'answer': '{FIXED}'}}\n",
                     "variables": [], "outputs": {"answer": {"type": "string", "children": None}}}),
            ("300", {"type": "end", "title": "End",
                     "outputs": [{"variable": "answer", "value_selector": ["200", "answer"]}]})]
        for i, (identifier, data) in enumerate(specifications):
            nodes.append({"id": identifier, "type": "custom", "data": dict(data, desc="", selected=False),
                          "position": {"x": i * 300, "y": 0}, "width": 244, "height": 90,
                          "sourcePosition": "right", "targetPosition": "left"})
        edges = [{"id": a + "-" + b, "source": a, "target": b,
                  "sourceHandle": "source", "targetHandle": "target", "type": "custom",
                  "data": {"sourceType": s, "targetType": t, "isInLoop": False}}
                 for a, b, s, t in [("100", "200", "start", "code"), ("200", "300", "code", "end")]]
        dsl = {"kind": "app", "version": "0.7.0", "dependencies": [],
               "app": {"name": "ImageCheck" + secrets.token_hex(3), "mode": "workflow",
                       "icon": "🤖", "icon_type": "emoji", "icon_background": "#FFEAD5",
                       "description": "Provider-free image verification"},
               "workflow": {"conversation_variables": [], "environment_variables": [],
                            "features": {}, "graph": {"nodes": nodes, "edges": edges}}}
        status, result = self.request("/console/api/apps/imports",
                                      {"mode": "yaml-content", "yaml_content": json.dumps(dsl, ensure_ascii=False)})
        if status == 202 or result.get("status") == "pending":
            status, result = self.request("/console/api/apps/imports/" + result["id"] + "/confirm", {})
        assert status == 200 and result.get("app_id"), "Native workflow import failed"
        app = result["app_id"]
        if publish:
            status, _ = self.request(f"/console/api/apps/{app}/workflows/publish", {})
            assert status in (200, 201), "Native workflow publication failed"
        return app

    def server(self, app):
        """Enable the native app MCP endpoint, without a third-party server."""
        status, result = self.request(f"/console/api/apps/{app}/server",
                                      {"description": "Fixed workflow verification", "parameters": {}})
        assert status in (200, 201), "Native MCP creation failed"
        update = {"id": result["id"], "description": "Fixed workflow verification",
                  "parameters": {}, "status": "active"}
        status, result = self.request(f"/console/api/apps/{app}/server", update, method="PUT")
        assert status == 200, "Native MCP activation failed"
        return result

    def mcp(self, code, method, params=None):
        """Actual JSON-RPC transport through the same localhost nginx endpoint."""
        return self.request("/mcp/server/" + code + "/mcp",
                            {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}},
                            headers={"MCP-Protocol-Version": "2025-03-26"})

    def call_fixed(self, server):
        """Initialize, enumerate and call the native tool; require exact output."""
        code = server["server_code"]
        status, result = self.mcp(code, "initialize", {
            "protocolVersion": "2025-03-26", "capabilities": {},
            "clientInfo": {"name": "image-validation", "version": "1"}})
        assert status == 200 and "result" in result, "Native MCP initialize failed"
        status, result = self.mcp(code, "tools/list")
        assert status == 200 and len(result["result"]["tools"]) == 1, "Native MCP tools/list failed"
        tool = result["result"]["tools"][0]["name"]
        status, result = self.mcp(code, "tools/call", {"name": tool, "arguments": {}})
        assert status == 200 and "result" in result and not result["result"].get("isError"), "Native MCP execution failed"
        content = result["result"]["content"]
        output = json.loads(next(item["text"] for item in content if item["type"] == "text"))
        assert output == {"answer": FIXED}, "Native MCP output differs from fixed oracle"
        return tool
