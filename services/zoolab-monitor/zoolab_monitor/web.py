"""HTTP API and Hungarian dashboard."""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from . import __version__
from .database import Database, utc_now
from .monitor import Monitor


DASHBOARD = r"""<!doctype html>
<html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZooLab Monitor</title><style>
:root{color-scheme:dark;--bg:#07111f;--panel:#111d2e;--line:#26364d;--text:#e7edf7;--muted:#91a0b6;--good:#40d98b;--bad:#ff647c;--accent:#7dd3fc}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#132a42,var(--bg) 55%);color:var(--text);font:15px system-ui,sans-serif;min-height:100vh}
main{width:min(1120px,92vw);margin:auto;padding:42px 0}header{display:flex;align-items:end;justify-content:space-between;gap:20px;margin-bottom:24px}h1{font-size:clamp(28px,5vw,44px);margin:0;letter-spacing:-.04em}header p{margin:7px 0 0;color:var(--muted)}button{border:0;border-radius:9px;background:var(--accent);color:#082032;font-weight:750;padding:11px 16px;cursor:pointer}button:disabled{opacity:.55}
.summary{display:flex;gap:12px;margin-bottom:20px}.metric,.card{background:#111d2ee8;border:1px solid var(--line);border-radius:14px}.metric{padding:13px 18px}.metric b{font-size:20px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(285px,1fr));gap:16px}.card{padding:19px}.top{display:flex;justify-content:space-between;gap:10px;align-items:start}.top h2{margin:0;font-size:18px}.badge{font-size:12px;font-weight:800;padding:5px 9px;border-radius:99px}.online{color:var(--good);background:#40d98b1a}.offline{color:var(--bad);background:#ff647c1a}.unknown{color:var(--muted);background:#91a0b61a}
dl{display:grid;grid-template-columns:1fr 1fr;gap:8px 12px}dt{color:var(--muted)}dd{margin:0;text-align:right}.error{color:#ff9cab;min-height:1.3em;word-break:break-word}.history{display:flex;gap:5px;margin-top:15px}.dot{width:9px;height:9px;border-radius:50%;background:var(--bad)}.dot.ok{background:var(--good)}footer{color:var(--muted);margin-top:22px;font-size:13px}@media(max-width:560px){header{align-items:start;flex-direction:column}.summary{flex-wrap:wrap}main{padding-top:25px}}
</style></head><body><main><header><div><h1>ZooLab Monitor</h1><p>Központi szolgáltatásfigyelő</p></div><button id="check">Ellenőrzés most</button></header><section class="summary" id="summary"></section><section class="cards" id="cards"><p>Adatok betöltése…</p></section><footer>Automatikus frissítés 10 másodpercenként · UTC időbélyegek</footer></main>
<script>
const esc=v=>String(v??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=v=>v?new Date(v).toLocaleString('hu-HU',{timeZone:'UTC'})+' UTC':'—';
async function load(){try{const r=await fetch('/api/services',{cache:'no-store'});if(!r.ok)throw Error('HTTP '+r.status);const d=await r.json();document.querySelector('#summary').innerHTML=`<div class="metric"><b>${d.summary.total}</b> összes</div><div class="metric online"><b>${d.summary.online}</b> online</div><div class="metric offline"><b>${d.summary.offline}</b> offline</div>`;document.querySelector('#cards').innerHTML=d.services.map(s=>{const x=s.current;const state=!x?'unknown':x.online?'online':'offline';const label=!x?'Nincs adat':x.online?'Online':'Offline';const hist=s.history.map(h=>`<i class="dot ${h.online?'ok':''}" title="${esc(time(h.checked_at))}"></i>`).join('');return `<article class="card"><div class="top"><h2>${esc(s.name)}</h2><span class="badge ${state}">${label}</span></div><p class="error">${esc(x?.error||'')}</p><dl><dt>Típus</dt><dd>${esc(s.type.toUpperCase())}</dd><dt>Válaszidő</dt><dd>${x?x.response_time_ms+' ms':'—'}</dd><dt>Utolsó ellenőrzés</dt><dd>${time(x?.checked_at)}</dd><dt>Utolsó siker</dt><dd>${time(x?.last_success_at)}</dd><dt>Egymást követő hibák</dt><dd>${x?.consecutive_failures??0}</dd><dt>HTTP-státusz</dt><dd>${x?.http_status??'—'}</dd></dl><div class="history" aria-label="Legutóbbi ellenőrzések">${hist}</div></article>`}).join('')}catch(e){document.querySelector('#cards').innerHTML=`<p class="error">Betöltési hiba: ${esc(e.message)}</p>`}}
document.querySelector('#check').onclick=async e=>{e.target.disabled=true;try{await fetch('/api/check-now',{method:'POST'});await load()}finally{e.target.disabled=false}};load();setInterval(load,10000);
</script></body></html>"""


def create_handler(config: dict, database: Database, monitor: Monitor) -> type[BaseHTTPRequestHandler]:
    services = config["services"]
    by_id = {service["id"]: service for service in services}

    class RequestHandler(BaseHTTPRequestHandler):
        server_version = "ZooLabMonitor/1.0"

        def _send(self, status: int, content_type: str, body: bytes) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, status: int, payload: object) -> None:
            body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            self._send(status, "application/json; charset=utf-8", body)

        def do_GET(self) -> None:  # noqa: N802
            parsed = urlsplit(self.path)
            if parsed.path == "/":
                self._send(200, "text/html; charset=utf-8", DASHBOARD.encode("utf-8"))
            elif parsed.path == "/health":
                self._json(200, {"status": "ok", "service": "zoolab-monitor", "version": __version__})
            elif parsed.path == "/api/services":
                payload_services = []
                online = 0
                offline = 0
                for service in services:
                    current = database.latest(service["id"])
                    if current and current["online"]:
                        online += 1
                    else:
                        offline += 1
                    payload_services.append({
                        "id": service["id"],
                        "name": service["name"],
                        "type": service["type"],
                        "current": current,
                        "history": database.history(service["id"], 10),
                    })
                self._json(200, {
                    "generated_at": utc_now(),
                    "summary": {"total": len(services), "online": online, "offline": offline},
                    "services": payload_services,
                })
            elif parsed.path == "/api/history":
                query = parse_qs(parsed.query)
                service_id = query.get("service", [""])[0]
                if service_id not in by_id:
                    self._json(404, {"error": "Unknown service"})
                    return
                try:
                    limit = int(query.get("limit", ["20"])[0])
                    if not 1 <= limit <= 100:
                        raise ValueError
                except ValueError:
                    self._json(400, {"error": "limit must be between 1 and 100"})
                    return
                self._json(200, {"service": service_id, "history": database.history(service_id, limit)})
            else:
                self._json(404, {"error": "Not found"})

        def do_POST(self) -> None:  # noqa: N802
            parsed = urlsplit(self.path)
            if parsed.path != "/api/check-now":
                self._json(404, {"error": "Not found"})
                return
            try:
                content_length = int(self.headers.get("Content-Length", "0") or 0)
                if content_length < 0:
                    raise ValueError
            except ValueError:
                self._json(400, {"error": "Invalid Content-Length"})
                return
            if content_length:
                self.rfile.read(min(content_length, 65536))
                self._json(400, {"error": "Request body is not accepted"})
                return
            results = monitor.check_all()
            self._json(200, {"checked": len(results), "results": results})

        def log_message(self, format_string: str, *args: object) -> None:
            return

    return RequestHandler


def create_server(config: dict, database: Database, monitor: Monitor) -> ThreadingHTTPServer:
    handler = create_handler(config, database, monitor)
    return ThreadingHTTPServer((config["listen_host"], config["listen_port"]), handler)
