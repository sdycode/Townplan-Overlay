#!/usr/bin/env python3
"""Local server: serves the app + resolves Google Maps links to coordinates.

    python3 server.py [port]     (default 8000)

GET /api/resolve?url=<google maps link>
  -> {"lat", "lng", "zoom"?, "name"?, "url"}   or   {"error"}
GET /api/fetch?url=<pdf/image link>
  -> the file's bytes (avoids CORS); file name in the X-Filename header (URL-encoded)
"""
import html
import json
import re
import shutil
import sys
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

UA = {"User-Agent": "curl/8.0", "Accept-Language": "en"}
ALLOWED_HOST = re.compile(r"(^|\.)(goo\.gl|google\.[a-z.]+)$")
NUM = r"(-?\d+(?:\.\d+)?)"


def fetch(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=15) as r:
        return r.geturl(), r.read().decode("utf-8", "replace")


def coords_from_url(url):
    """Coordinates embedded in a full Google Maps URL, most precise first."""
    u = urllib.parse.unquote(url)
    zoom = re.search(r"@-?\d+\.\d+,-?\d+\.\d+,([\d.]+)z", u)
    zoom = float(zoom.group(1)) if zoom else None
    m = re.search(rf"!3d{NUM}!4d{NUM}", u)                                   # place pin
    if not m:
        m = re.search(rf"[?&](?:q|query|ll|center|destination)={NUM},\s*\+?{NUM}", u)
    if not m:
        m = re.search(rf"/(?:place|search|dir)/{NUM},\s*\+?{NUM}", u)
    if not m:
        m = re.search(rf"@{NUM},{NUM}", u)                                    # viewport centre
    if m:
        return {"lat": float(m.group(1)), "lng": float(m.group(2)), "zoom": zoom}
    return None


def coords_from_place_page(page):
    """Place link without coordinates: ask Google's place preview data (unofficial, may break)."""
    m = re.search(r'(/maps/preview/place\?[^"\\]+)', page)
    if not m:
        return None
    _, data = fetch("https://www.google.com" + html.unescape(m.group(1)))
    m = re.search(rf'\[null,null,{NUM},{NUM}\],"0x[0-9a-f]+:0x[0-9a-f]+"', data)
    if not m:
        m = re.search(rf"\[\[[\d.]+,{NUM},{NUM}\],\[0,0,0\]", data)            # [dist, lng, lat]
        if m:
            return {"lat": float(m.group(2)), "lng": float(m.group(1))}
        return None
    return {"lat": float(m.group(1)), "lng": float(m.group(2))}


def place_name(url):
    u = urllib.parse.unquote_plus(url)
    m = re.search(r"/place/([^/@?]+)", u) or re.search(r"[?&]q=([^&]+)", u)
    return m.group(1).strip() if m else None


def resolve(url):
    host = urllib.parse.urlparse(url).hostname or ""
    if not ALLOWED_HOST.search(host):
        return {"error": "Only Google Maps links are supported"}
    final, page = fetch(url)
    res = coords_from_url(final)
    if not res:
        try:
            res = coords_from_place_page(page)
        except Exception:
            res = None
    if not res:
        name = place_name(final)
        return {"name": name, "url": final} if name else {"error": "No location found in link", "url": final}
    res.update(url=final, name=place_name(final))
    return res


def download_name(resp):
    cd = resp.headers.get("Content-Disposition", "")
    m = re.search(r"filename\*\s*=\s*[^']*''([^;]+)", cd) or re.search(r'filename\s*=\s*"?([^";]+)"?', cd)
    if m:
        return urllib.parse.unquote(m.group(1)).strip()
    name = urllib.parse.unquote(urllib.parse.urlparse(resp.geturl()).path.rstrip("/").split("/")[-1])
    return name or "download"


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        url = urllib.parse.parse_qs(parsed.query).get("url", [""])[0]
        if parsed.path == "/api/resolve":
            try:
                body = resolve(url)
            except Exception as e:
                body = {"error": f"Could not open link: {e}"}
            return self.send_json(200, body)
        if parsed.path == "/api/fetch":
            return self.proxy_file(url)
        return super().do_GET()

    def send_json(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def proxy_file(self, url):
        if not re.match(r"^https?://", url):
            return self.send_json(400, {"error": "Link must start with http:// or https://"})
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Macintosh) OverlayAligner"})
            resp = urllib.request.urlopen(req, timeout=60)
        except Exception as e:
            return self.send_json(502, {"error": f"Download failed: {e}"})
        with resp:
            self.send_response(200)
            self.send_header("Content-Type", resp.headers.get("Content-Type", "application/octet-stream"))
            if resp.headers.get("Content-Length"):
                self.send_header("Content-Length", resp.headers["Content-Length"])
            self.send_header("X-Filename", urllib.parse.quote(download_name(resp)))
            self.end_headers()
            shutil.copyfileobj(resp, self.wfile, 1 << 16)

    def log_message(self, fmt, *args):
        if "/api/" in self.path:
            super().log_message(fmt, *args)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    root = str(Path(__file__).resolve().parent)
    server = ThreadingHTTPServer(("127.0.0.1", port), lambda *a, **k: Handler(*a, directory=root, **k))
    print(f"Serving on http://localhost:{port}")
    server.serve_forever()
