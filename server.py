# 授業用の簡易 Web サーバー（Python の標準機能だけで動く）
# 使い方：このフォルダで  python3 server.py（Windows は python server.py）と打ち、
#         ブラウザで http://localhost:3000/ を開く
# 止めるとき：Ctrl + C
# このファイルは授業用です。書き換えないでください。

import functools
import http.server
import os
import sys
import urllib.parse

HOST = "127.0.0.1"  # 自分の PC からだけ見られるようにする
PORT = 3000
ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    # 日本語のテキストが文字化けしないように、文字コードを付ける
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".txt": "text/plain; charset=utf-8",
        ".md": "text/markdown; charset=utf-8",
        ".csv": "text/csv; charset=utf-8",
    }

    def _hidden(self):
        # 名前が「.」で始まるもの（.claude、.git など）は見せない
        path = urllib.parse.unquote(self.path.split("?", 1)[0].split("#", 1)[0])
        return any(part.startswith(".") for part in path.split("/") if part)

    def do_GET(self):
        if self._hidden():
            self.send_error(403, "Forbidden")
            return
        super().do_GET()

    def do_HEAD(self):
        if self._hidden():
            self.send_error(403)
            return
        super().do_HEAD()

    def list_directory(self, path):
        # 一覧にも隠しファイルを出さない
        real_listdir = os.listdir
        os.listdir = lambda p: [n for n in real_listdir(p) if not n.startswith(".")]
        try:
            return super().list_directory(path)
        finally:
            os.listdir = real_listdir

    def end_headers(self):
        # 変更がすぐ見えるように、ブラウザに保存させない
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    handler = functools.partial(Handler, directory=ROOT)
    try:
        server = http.server.ThreadingHTTPServer((HOST, PORT), handler)
    except OSError:
        print(f"ポート {PORT} はほかのプログラムが使っています。もう1つのターミナルでサーバーが動いていないか確かめてください。")
        sys.exit(1)
    print(f"サーバーを起動しました： http://localhost:{PORT}/")
    print("止めるときは Ctrl + C")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nサーバーを止めました")


if __name__ == "__main__":
    main()
