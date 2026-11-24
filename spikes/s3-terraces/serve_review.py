"""Tiny local server for the terrace review page: serves this folder and accepts POST /save.

  python serve_review.py          # http://127.0.0.1:5180/review.html

Saves the reviewer's corrections to data/reference.reviewed.json; data/reference.json (my first drawing) is never touched.
"""
import json
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).parent
OUT = HERE / "data" / "reference.reviewed.json"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(HERE), **kw)

    def do_POST(self):
        if self.path != "/save":
            self.send_error(404)
            return
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        try:
            data = json.loads(body)
            OUT.write_text(json.dumps(data, indent=1, ensure_ascii=False))
        except Exception as e:
            self.send_error(400, str(e))
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"saved": len(data)}).encode())

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if self.path == "/save":
            sys.stderr.write("saved reviewed.json\n")


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 5180), Handler).serve_forever()
