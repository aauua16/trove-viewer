# Trove（オーストラリア国立図書館）の新聞記事について、
# 年ごとの「検索語に一致した件数」と「総記事数」を集めて data/hits.csv を作るスクリプト。
#
# 使い方（学生が自分のターミナルで実行する。Claude は実行しない）：
#   1. Trove の API キーを自分で取得する（Trove のサイトで申請する）
#   2. キーを「環境変数」に入れる（ファイルには書かない！）
#        Windows (PowerShell) :  $env:TROVE_API_KEY = "ここにキー"
#        Mac / Linux          :  export TROVE_API_KEY="ここにキー"
#   3. このフォルダで  python fetch_trove.py   （Mac は python3）
#
# 標準ライブラリだけで動く（pip install は不要）。
#
# 参考：Trove API v3 技術ガイド
#   https://trove.nla.gov.au/about/create-something/using-api/v3/api-technical-guide

import csv
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

# ===================== 設定（ここを書き換えて使う） =====================

# 検索語。 {表示名: 検索式}
# 表記ゆれ（Kanematsu / Kanematzu など）は OR で 1 つの式にまとめる。
# 足し算で合算すると同じ記事を二重に数えるため、OR を使う。
# ★検索式は暫定。綴りの候補（OCR の誤読形を含む）は、近読で見つけたものを足していくこと。
# 表示名にカンマは使えない（CSV の簡易パーサーが対応していないため）。
#
# "Kanematsu" と "F. Kanematsu"（兼松房治郎の名前の形）を並べて、違いを見る。
# 推測：Trove は記号を無視して語を照合するため、"F. Kanematsu" の記事は "kanematsu" にも含まれると思われる
#      （＝ F. Kanematsu ≦ Kanematsu）。実際にそうなっているかは、取得結果で確かめること。
#
# 検索語は「グループ」に分ける。会社名の語と、日本に関する言説の語では件数の桁が違うため、
# 画面ではグループごとにグラフを切り替えて表示する。
# 表示名は、グループをまたいで重複させないこと（画面とメタデータが表示名で対応づけているため）。
QUERY_GROUPS = {
    "会社": {
        "Kanematsu": '"kanematsu"',
        "F. Kanematsu": '"F. Kanematsu"',
    },
    # 日本に関する言説の語（暫定の 4 語）。当時の記事で実際に使われた語は、近読で確かめて足していくこと。
    # フレーズ検索（" "で囲む）なので、語順や間に別の語が入ると拾えない。
    "言説": {
        "Yellow Peril": '"Yellow Peril"',                         # 黄禍論
        "Japanese buyers": '"Japanese buyers"',                   # 羊毛などの日本人買い付け（商社史に直結）
        "Japanese competition": '"Japanese competition"',         # 日本製品との競合
        "Anglo-Japanese Alliance": '"Anglo-Japanese Alliance"',   # 日英同盟（1902〜1923 年）
    },
}

# 以下は変更しない：グループを平らにした {表示名: 検索式}
QUERIES = {name: expr for members in QUERY_GROUPS.values() for name, expr in members.items()}
assert len(QUERIES) == sum(len(m) for m in QUERY_GROUPS.values()), "表示名がグループをまたいで重複しています"

# 取得する年代。 188 = 1880 年代、 194 = 1940 年代。
FIRST_DECADE = 188
LAST_DECADE = 194

# 新聞と官報(gazette)を分けるための指定。パラメータ名・値は資料によって
# 表記が揺れているため、実行の最初に「本当に効いているか」を自動で検査する。
ART_TYPE_PARAM = "l-artType"
ART_TYPE_NEWSPAPER = "newspapers"
ART_TYPE_GAZETTE = "gazette"

# 総記事数（分母）を取るときの「空の検索」の書き方の候補。
# 実測で件数がいちばん多いものを採用する。
EMPTY_QUERY_CANDIDATES = ["", "*", " "]

# 追加の絞り込み（分子と分母に同じものを必ず適用される）。
# 例：広告を除く → {"l-category": "Article"}   ※除くこと自体が分析上の選択なので注記すること
EXTRA_FILTERS = {}

WAIT_SECONDS = 0.3  # リクエストの間隔（相手のサーバーへの配慮）

# ========================================================================

ENDPOINT = "https://api.trove.nla.gov.au/v3/result"
OUT_CSV = os.path.join("data", "hits.csv")
OUT_META = os.path.join("data", "hits_meta.json")
JST = timezone(timedelta(hours=9))


def get_key():
    key = os.environ.get("TROVE_API_KEY")
    if not key:
        sys.exit(
            "環境変数 TROVE_API_KEY が設定されていません。冒頭の使い方を読んでください。"
        )
    return key


def call_api(params, key):
    """Trove API を呼んで JSON を返す。一時的な失敗は少し待ってやり直す。"""
    query = urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
    url = ENDPOINT + "?" + query
    # キーは URL ではなくヘッダで送る（URL は記録に残りやすいため）
    req = urllib.request.Request(url, headers={"X-API-KEY": key})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                time.sleep(WAIT_SECONDS)
                return json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:300]
            if e.code in (429, 500, 502, 503, 504) and attempt < 3:
                time.sleep(2 * (attempt + 1))
                continue
            sys.exit(f"API エラー HTTP {e.code}: {body}\n  パラメータ: {params}")
        except urllib.error.URLError as e:
            if attempt < 3:
                time.sleep(2 * (attempt + 1))
                continue
            sys.exit(f"通信エラー: {e}")


def base_params(q, art_type):
    p = {"q": q, "category": "newspaper", "encoding": "json", "n": 0}
    if art_type:
        p[ART_TYPE_PARAM] = art_type
    p.update(EXTRA_FILTERS)
    return p


def total_of(data):
    """レスポンスから全体の一致件数を取り出す。"""
    try:
        return int(data["category"][0]["records"]["total"])
    except (KeyError, IndexError, TypeError, ValueError):
        sys.exit(
            "レスポンスの構造が想定と違います（total が見つかりません）:\n"
            + json.dumps(data, ensure_ascii=False)[:800]
        )


def year_counts(data):
    """年ファセットから {年: 件数} を取り出す。"""
    try:
        terms = data["category"][0]["facets"]["facet"][0]["term"]
    except (KeyError, IndexError, TypeError):
        # 該当が 0 件の年代ではファセット自体が無いことがある
        if total_of(data) == 0:
            return {}
        sys.exit(
            "レスポンスの構造が想定と違います（年ファセットが見つかりません）:\n"
            + json.dumps(data, ensure_ascii=False)[:800]
        )
    return {int(t["search"]): int(t["count"]) for t in terms}


def check_filter_works(key, q_nonempty):
    """新聞/官報のフィルタが本当に効いているかを検査する。
    効いていない指定は、エラーにならず黙って無視されることがあるため。"""
    a = total_of(call_api(base_params(q_nonempty, None), key))
    b = total_of(call_api(base_params(q_nonempty, ART_TYPE_NEWSPAPER), key))
    c = total_of(call_api(base_params(q_nonempty, ART_TYPE_GAZETTE), key))
    print(f"[検査] フィルタなし={a:,} / 新聞のみ={b:,} / 官報のみ={c:,}")
    ok = a > 0 and b < a and c < a and abs(a - (b + c)) <= 0.01 * a
    if not ok:
        sys.exit(
            "新聞/官報のフィルタが効いていない可能性があります（フィルタなし ≒ 新聞 + 官報 になっていません）。\n"
            "fetch_trove.py の ART_TYPE_PARAM / ART_TYPE_NEWSPAPER / ART_TYPE_GAZETTE を見直してください\n"
            "（候補：'l-artType' + 'newspapers' / 'newspaper'、'l-articleType' など）。\n"
            "公式の技術ガイドで現行の書き方を確認するか、先生に相談してください。"
        )


def choose_empty_query(key):
    """総記事数（分母）を取る『空の検索』の書き方を、実測で選ぶ。"""
    best, best_n = None, -1
    for cand in EMPTY_QUERY_CANDIDATES:
        try:
            n = total_of(call_api(base_params(cand, ART_TYPE_NEWSPAPER), key))
        except SystemExit:
            n = -1
        print(f"[検査] 空の検索 q={cand!r} → {n:,}")
        if n > best_n:
            best, best_n = cand, n
    if best_n <= 0:
        sys.exit("総記事数を取れる『空の検索』の書き方が見つかりませんでした。")
    return best


def fetch_year_series(q, key):
    """検索式 q について、全対象期間の {年: 件数} を返す。"""
    result = {}
    for decade in range(FIRST_DECADE, LAST_DECADE + 1):
        p = base_params(q, ART_TYPE_NEWSPAPER)
        p.update({"facet": "year", "l-decade": decade})
        result.update(year_counts(call_api(p, key)))
    return result


def main():
    key = get_key()
    now = datetime.now(JST)
    os.makedirs("data", exist_ok=True)

    first_q = next(iter(QUERIES.values()))
    check_filter_works(key, first_q)
    empty_q = choose_empty_query(key)

    print("[取得] 総記事数（分母）…")
    totals = fetch_year_series(empty_q, key)

    series = {}
    for name, q in QUERIES.items():
        print(f"[取得] {name}: {q}")
        series[name] = fetch_year_series(q, key)

    years = sorted(totals)
    with open(OUT_CSV, "w", encoding="utf-8", newline="") as f:
        f.write(
            f"# 出典：Trove API v3（オーストラリア国立図書館）。取得日：{now.strftime('%Y-%m-%d')}。"
            f"新聞のみ（官報は除外）。ヒット件数と総記事数は同じ絞り込み条件。\n"
        )
        f.write(
            "# 件数は『現在デジタル化され検索可能な記事』の中での一致数であり、当時の報道量そのものではない。\n"
        )
        w = csv.writer(f)
        w.writerow(["year", "group", "query", "hits", "total"])
        for group, members in QUERY_GROUPS.items():
            for name in members:
                for y in years:
                    w.writerow([y, group, name, series[name].get(y, 0), totals[y]])

    with open(__file__, "rb") as sf:
        sha = hashlib.sha256(sf.read()).hexdigest()
    meta = {
        "api": "Trove API v3",
        "endpoint": ENDPOINT,
        "queries": QUERIES,
        "query_groups": QUERY_GROUPS,
        "denominator_query": empty_q,
        "fixed_params": {
            "category": "newspaper",
            ART_TYPE_PARAM: ART_TYPE_NEWSPAPER,
            "n": 0,
            **EXTRA_FILTERS,
        },
        "decades": [FIRST_DECADE, LAST_DECADE],
        "retrieved_at": now.isoformat(timespec="seconds"),
        "script": "fetch_trove.py",
        "script_sha256": sha,
        "notes": "新聞のみ。分子・分母に同一フィルタ。APIキーは記録しない。",
    }
    with open(OUT_META, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print(
        f"完了：{OUT_CSV} と {OUT_META} を作りました。ブラウザを再読み込みしてください。"
    )


if __name__ == "__main__":
    main()
