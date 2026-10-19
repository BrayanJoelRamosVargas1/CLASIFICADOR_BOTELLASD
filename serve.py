import http.server
import socketserver
import os
import sys
import socket

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
    socketserver.TCPServer.allow_reuse_address = True
    local_ip = get_local_ip()
    print("========================================================")
    print(f"  Servidor EcoLens AI activo:")
    print(f"  ● PC / Local:     http://localhost:{PORT}")
    print(f"  ● Teléfono / Red:  http://{local_ip}:{PORT}")
    print("  Cabeceras COOP/COEP inyectadas para WASM SIMD y WebGPU")
    print("========================================================")
    with socketserver.TCPServer(("", PORT), CoiHandler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServidor detenido.")
