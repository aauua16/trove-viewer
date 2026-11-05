// 新聞ヒット数の推移ビューア
// やっていること：
//   1. data/hits.csv を読み込む
//   2. 検索語ごとに「年 → 件数」の表を作る
//   3. Chart.js で折れ線グラフにする（生の件数 / 100万記事あたり を切り替え）

// ---- 画面の部品を取得する ----
const queryListEl = document.getElementById("query-list");
const noteEl = document.getElementById("data-note");
const messageEl = document.getElementById("message");
const canvas = document.getElementById("chart");

// ---- 状態（いま何が選ばれているか） ----
let rows = [];          // CSV の全行 [{year, query, hits, total}, ...]
let chart = null;       // Chart.js のグラフ本体
let selected = new Set(); // チェックが入っている検索語
let group = null;        // いま表示しているグループ（例：会社 / 言説）

// ヒットが何件未満の年を「比率が不安定」とみなすか（分子が少ないと、100万あたりの値が大きくぶれる）
const LOW_COUNT = 5;

// 折れ線の色（色覚の違いでも区別しやすい組み合わせ）
const COLORS = ["#0072B2", "#D55E00", "#009E73", "#CC79A7", "#E69F00", "#56B4E9"];

// ---- スパイク（突出した年）の見つけ方の設定 ----
// 次の 3 つを全部満たす年を「スパイク」とする（あくまで目安。index.html の説明文の数字も合わせて直すこと）
//   1. ヒットが LOW_COUNT 件以上ある
//   2. 100万記事あたりの値が、前後 SPIKE_WINDOW 年（自分を除く）の中央値の SPIKE_RATIO 倍以上
//   3. 前後 1 年のどちらよりも低くない（山の頂点である）
const SPIKE_RATIO = 2;   // 3 だと兼松の 1896 年（系列で最大）を取りこぼしたため 2 にした。大きくすると厳しくなる
const SPIKE_WINDOW = 5;
const SPIKE_TOP = 5;     // 1 つの検索語につき、目立つ順に最大いくつまで印を付けるか

// ---- CSV を読み込む ----
// 注意：この簡易パーサーは「カンマを含む項目」や「"で囲んだ項目」には対応していない。
//       検索語にカンマを入れない前提。
function parseCsv(text) {
  const notes = [];
  const data = [];
  const lines = text.split(/\r?\n/);
  let header = null;
  for (const line of lines) {
    if (line.trim() === "") continue;
    if (line.startsWith("#")) {            // # で始まる行は注記として扱う
      notes.push(line.replace(/^#\s*/, ""));
      continue;
    }
    const cells = line.split(",");
    if (!header) { header = cells; continue; }   // 最初の通常行は見出し
    const rec = {};
    header.forEach((h, i) => (rec[h.trim()] = cells[i] ? cells[i].trim() : ""));
    data.push({
      year: Number(rec.year),
      group: rec.group || "（なし）",   // group 列が無い古い CSV でも動くようにする
      query: rec.query,
      hits: Number(rec.hits),
      total: Number(rec.total),
    });
  }
  return { notes, data };
}

// ---- グラフ用データを作る ----
function currentMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

function buildDatasets() {
  const mode = currentMode();
  const groupRows = rows.filter((r) => r.group === group);   // いま選ばれているグループの行だけ
  const years = [...new Set(groupRows.map((r) => r.year))].sort((a, b) => a - b);
  const queries = [...new Set(groupRows.map((r) => r.query))];
  const datasets = [];
  queries.forEach((q, i) => {
    if (!selected.has(q)) return;
    const values = years.map((y) => {
      const r = rows.find((x) => x.year === y && x.query === q);
      if (!r) return null;                        // データのない年は途切れさせる
      if (mode === "raw") return r.hits;
      // 総記事数が 0 または不明のときは計算できないので null
      return r.total > 0 ? (r.hits / r.total) * 1e6 : null;
    });
    // 各年の元データ（ツールチップと少数件の判定に使う）
    const rowsByYear = years.map((y) => rows.find((x) => x.year === y && x.query === q) || null);
    const color = COLORS[i % COLORS.length];
    const isLow = (idx) => rowsByYear[idx] && rowsByYear[idx].hits < LOW_COUNT;
    const spikes = findSpikes(q);                               // この検索語のスパイク
    const spikeYears = new Set(spikes.map((sp) => sp.year));
    const isSpike = (idx) => rowsByYear[idx] && spikeYears.has(rowsByYear[idx].year);
    datasets.push({
      label: q,
      data: values,
      _rows: rowsByYear,
      _spikes: spikes,
      _spikeYears: spikeYears,
      borderColor: color,
      backgroundColor: color,
      tension: 0.2,
      spanGaps: false,
      // 少数件の年に触れる線分は破線にする（100万あたり表示のときだけ）
      segment: {
        borderDash: (c) => (mode === "norm" && (isLow(c.p0DataIndex) || isLow(c.p1DataIndex)) ? [5, 4] : undefined),
      },
      // 少数件の年の点は白抜きにする
      pointBackgroundColor: (c) => (mode === "norm" && isLow(c.dataIndex) ? "#fff" : color),
      pointBorderColor: color,
      // スパイクの点は大きな三角にする（形でも区別できるので、色が見分けにくい人にも分かる）
      pointStyle: (c) => (isSpike(c.dataIndex) ? "triangle" : "circle"),
      pointRadius: (c) => (isSpike(c.dataIndex) ? 8 : 3),
      pointHitRadius: 14,   // 点の周り 14px 以内を押せば反応する（スマホやタブレットでも押しやすくする）
    });
  });
  return { years, datasets };
}

// ---- 近読パネル（点をクリックしたとき） ----
const closeReadEl = document.getElementById("close-read");
let meta = null;   // data/hits_meta.json（検索式の記録）。無くても動く

// 検索語の表示名 → 取得時に使った検索式（例："kanematsu"）。記録が無ければ表示名そのまま
function exprOf(query) {
  return (meta && meta.queries && meta.queries[query]) || query;
}

// Trove の検索ページの URL を作る。
//   l-artType=newspapers … 新聞だけに絞る（取得時の絞り込みと同じ。官報を除く）
//   l-decade と l-year    … 年で絞る。Trove の画面では「年代」と「年」を一緒に指定する（例：1914 年 → 191 と 1914）
// ※ URL の書き方は Trove 側の仕様変更で変わる可能性がある。開けない・年が絞れないときは Trove で手動検索する
function troveUrl(query, year) {
  const decade = Math.floor(year / 10);
  return "https://trove.nla.gov.au/search/category/newspapers?keyword=" +
    encodeURIComponent(exprOf(query)) + "&l-artType=newspapers&l-decade=" + decade + "&l-year=" + year;
}

// 点がクリックされたら、その年・検索語の記事を確かめるパネルを出す。
// スパイクの点のときは、Trove のページも新しいタブで直接開く
function showCloseRead(query, year, r, isSpike) {
  const expr = exprOf(query);
  const url = troveUrl(query, year);
  if (isSpike) window.open(url, "_blank", "noopener");

  closeReadEl.replaceChildren();                 // 前の内容を消す
  const h = document.createElement("h2");
  h.textContent = `${isSpike ? "【スパイク】" : ""}${year}年「${query}」：${r.hits}件（総記事 ${r.total.toLocaleString()}件）`;
  const a = document.createElement("a");
  a.href = url; a.target = "_blank"; a.rel = "noopener";
  a.textContent = "Trove でこの年の記事を開く（新しいタブ）";
  const ul = document.createElement("ul");
  ["見出しだけでなく本文の該当箇所を読み、本当に目的の語（人物・会社）か確かめる（偽陽性の排除）",
   "OCR の誤読で別の語がヒットしていないか見る。逆に、綴りの違いで拾えていない記事もありうる",
   "同じ記事が転載で何度も数えられていないか見る",
   "確かめた結果は README.md などにメモしておく"
  ].forEach((t) => { const li = document.createElement("li"); li.textContent = t; ul.appendChild(li); });
  const p = document.createElement("p");
  p.append("検索式：", Object.assign(document.createElement("code"), { textContent: expr }), "　", a);
  closeReadEl.append(h, p, ul);
  closeReadEl.hidden = false;
}

// ---- スパイクを見つける ----
// 検索語 q について、突出した年の一覧を返す（100万記事あたりの値で判定。表示が「生の件数」でも同じ年に印が付く）
function findSpikes(q) {
  const list = rows
    .filter((r) => r.query === q && r.total > 0)
    .sort((a, b) => a.year - b.year)
    .map((r) => ({ row: r, per: (r.hits / r.total) * 1e6 }));
  const found = [];
  list.forEach((cur) => {
    if (cur.row.hits < LOW_COUNT) return;                              // 条件 1：件数が少ない年は除く
    const around = list
      .filter((x) => x !== cur && Math.abs(x.row.year - cur.row.year) <= SPIKE_WINDOW)
      .map((x) => x.per)
      .sort((a, b) => a - b);
    const base = around.length ? around[Math.floor(around.length / 2)] : 0;   // 前後の中央値
    if (cur.per < SPIKE_RATIO * base) return;                          // 条件 2：周りの何倍か
    const nearby = list.filter((x) => Math.abs(x.row.year - cur.row.year) === 1);
    if (nearby.some((x) => x.per > cur.per)) return;                   // 条件 3：山の頂点か
    found.push({ query: q, year: cur.row.year, hits: cur.row.hits, total: cur.row.total, per: cur.per, base });
  });
  return found.sort((a, b) => b.per - a.per).slice(0, SPIKE_TOP);
}

// ---- スパイク一覧（「Trove で開く」を 1 回押せば飛べる） ----
const spikeListEl = document.getElementById("spike-list");

function renderSpikeList(datasets) {
  spikeListEl.replaceChildren();
  const all = datasets.flatMap((d) => d._spikes).sort((a, b) => b.per - a.per);
  if (all.length === 0) {
    spikeListEl.textContent = "突出した年は見つかりませんでした。";
    return;
  }
  const table = document.createElement("table");
  const mkRow = (cells, tag) => {
    const tr = document.createElement("tr");
    cells.forEach((c) => {
      const cell = document.createElement(tag);
      if (c instanceof Object) cell.append(c); else cell.textContent = c;
      tr.append(cell);
    });
    return tr;
  };
  table.append(mkRow(["検索語", "年", "ヒット数", "100万あたり", "周囲の中央値", "記事"], "th"));
  all.forEach((sp) => {
    const a = document.createElement("a");
    a.href = troveUrl(sp.query, sp.year);
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "Trove で開く";
    table.append(mkRow([sp.query, String(sp.year), String(sp.hits), sp.per.toFixed(1), sp.base.toFixed(1), a], "td"));
  });
  spikeListEl.append(table);
}

// ---- グラフを描く／更新する ----
function render() {
  const { years, datasets } = buildDatasets();
  const mode = currentMode();
  const yTitle = mode === "raw" ? "ヒット件数" : "100万記事あたりのヒット件数";

  if (!chart) {
    chart = new Chart(canvas, {
      type: "line",
      data: { labels: years, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        // 点の上にいるときだけカーソルを指の形にする
        onHover: (evt, elements) => {
          evt.native.target.style.cursor = elements.length ? "pointer" : "default";
        },
        // 点のクリックで近読パネルを開く（点の近くをクリックすればよい）
        onClick: (evt, elements) => {
          if (elements.length === 0) return;
          const el = elements[0];
          const ds = chart.data.datasets[el.datasetIndex];
          const r = ds._rows[el.index];
          if (r) showCloseRead(ds.label, r.year, r, ds._spikeYears.has(r.year));
        },
        plugins: {
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const r = ctx.dataset._rows[ctx.dataIndex];
                if (!r) return ctx.dataset.label + "：データなし";
                const per = r.total > 0 ? ((r.hits / r.total) * 1e6).toFixed(1) : "—";
                const warn = r.hits < LOW_COUNT ? "（件数が少なく、比率は不安定）" : "";
                return `${ctx.dataset.label}：${r.hits}件 / 総記事 ${r.total.toLocaleString()}件 → 100万あたり ${per}${warn}`;
              },
            },
          },
        },
        scales: {
          x: { title: { display: true, text: "年" } },
          y: { beginAtZero: true, title: { display: true, text: yTitle } },
        },
      },
    });
  } else {
    chart.data.labels = years;
    chart.data.datasets = datasets;
    chart.options.scales.y.title.text = yTitle;
    chart.update();
  }
  renderSpikeList(datasets);
}

// ---- 検索語のチェックボックスを作る ----
function buildQueryList() {
  queryListEl.replaceChildren();      // グループを切り替えたときに、前のグループの項目を消す
  selected.clear();
  const queries = [...new Set(rows.filter((r) => r.group === group).map((r) => r.query))];
  queries.forEach((q) => {
    selected.add(q);                               // 最初は全部チェック
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = true;
    box.addEventListener("change", () => {
      box.checked ? selected.add(q) : selected.delete(q);
      render();
    });
    label.append(box, " " + q);
    queryListEl.appendChild(label);
  });
}

// ---- グループ（会社 / 言説）の切り替え ----
const groupBoxEl = document.getElementById("group-box");
const groupListEl = document.getElementById("group-list");

function buildGroupList() {
  const groups = [...new Set(rows.map((r) => r.group))];
  group = groups[0];                            // 最初は CSV に最初に出てくるグループ
  groupBoxEl.hidden = groups.length <= 1;       // グループが 1 つだけなら選択欄は出さない
  groups.forEach((g, i) => {
    const label = document.createElement("label");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "group";
    radio.value = g;
    radio.checked = i === 0;
    radio.addEventListener("change", () => {
      group = g;
      closeReadEl.hidden = true;                // 前のグループの近読パネルは閉じる
      buildQueryList();
      render();
    });
    label.append(radio, " " + g);
    groupListEl.appendChild(label);
  });
}

// ---- 起動処理 ----
async function main() {
  try {
    const res = await fetch("data/hits.csv");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const { notes, data } = parseCsv(await res.text());
    rows = data;
    // 検索式の記録を読む（失敗しても本体の表示には影響させない）
    try {
      const m = await fetch("data/hits_meta.json");
      if (m.ok) meta = await m.json();
    } catch (e) { /* 無ければ検索語をそのまま使う */ }
    noteEl.textContent = notes.join(" ");
    buildGroupList();
    buildQueryList();
    document.querySelectorAll('input[name="mode"]').forEach((el) =>
      el.addEventListener("change", render)
    );
    render();
  } catch (err) {
    // サーバーが動いていない、ファイルが無い、などのとき
    messageEl.textContent =
      "data/hits.csv を読み込めませんでした（" + err.message +
      "）。python3 server.py が動いているか、http://localhost:3000/ で開いているか確認してください。";
  }
}
main();
