"""One-shot localhost HTTP fixture for ARM64 txiki raw-socket regression tests.

Run on the QEMU host, bound to 127.0.0.1; guest connects through 10.0.2.2.
Never point a production proxy or an AList credential at this test server.
"""

import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_PUT(self):
        self.handle_test()

    def do_COPY(self):
        self.handle_test()

    def do_MOVE(self):
        self.handle_test()

    def handle_test(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length < 0 or length > 128:
            self.send_error(413)
            return
        body = self.rfile.read(length)
        if self.path.startswith("/status/") and self.command == "PUT":
            status = int(self.path.removeprefix("/status/"))
            if status not in (204, 205, 304):
                self.send_error(404)
                return
            self.send_response(status)
            self.send_header("Content-Length", "12" if status == 304 else "0")
            self.send_header("X-Boundary", str(status))
        elif self.path == "/dav/source" and self.command in ("COPY", "MOVE"):
            reply = json.dumps({
                "method": self.command,
                "host": self.headers.get("Host"),
                "destination": self.headers.get("Destination"),
                "body": body.decode("utf-8"),
            }).encode("utf-8")
            self.send_response(201)
            self.send_header("Content-Length", str(len(reply)))
        else:
            self.send_error(404)
            return
        self.send_header("Connection", "close")
        self.end_headers()
        if self.path == "/dav/source":
            self.wfile.write(reply)
        self.wfile.flush()
        self.close_connection = True

    def log_message(self, format, *args):
        return


if __name__ == "__main__":
    port = int(sys.argv[1])
    if not (1024 <= port <= 65535):
        raise ValueError("pass an unprivileged local fixture port")
    server = HTTPServer(("127.0.0.1", port), Handler)
    server.timeout = 4
    print(f"TARGET_FIXTURE_READY {port}", flush=True)
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()
