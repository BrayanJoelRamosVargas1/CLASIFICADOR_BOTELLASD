import http.server
import socketserver
import os
import sys
import socket

# Force UTF-8 stdout if possible on Windows cmd
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080

def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

class CoiHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    local_ip = get_local_ip()
    print("========================================================")
    print("  Servidor EcoLens AI activo (ThreadingHTTPServer):")
    print(f"  [-] PC / Local:     http://localhost:{PORT}")
    print(f"  [-] Movil / Red:    http://{local_ip}:{PORT}")
    print("  Cabeceras COOP/COEP inyectadas para WASM SIMD y WebGPU")
    print("========================================================")
    server_class = getattr(http.server, "ThreadingHTTPServer", http.server.HTTPServer)
    server_class.allow_reuse_address = True
    with server_class(("", PORT), CoiHandler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServidor detenido.")
