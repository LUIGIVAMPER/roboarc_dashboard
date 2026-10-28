// RoboARC run dashboard. Static data (data/*.json) plus a live listing of the Hugging Face dataset on every load.
// No framework, no build step.

const HF = "https://huggingface.co";
const DEFAULT_DATASET = "RoboARC/RoboARC-outputs";
const LIVE_EVERY_MS = 5 * 60 * 1000;
const OFFLINE = new URLSearchParams(location.search).has("offline");   // ?offline: data/digest.json only, no live listing
const MODES = ["privileged", "standard"];
const MODE_ZH = { privileged: "privileged", standard: "standard" };
const STATUS_ZH = { ok: "成功", fail: "失败", void: "不算结果", wait: "待解析", empty: "还没跑" };

const S = {
  tasks: null, targets: [], digest: { bundles: [], trials: [] }, frames: {},
  dataset: DEFAULT_DATASET,
  live: { bundles: [], trials: [], listed: null, error: null, at: null, info: null },
  details: {},          // bundle key -> detail file (lazy)
  model: null,          // derived: slots, progress, ...
};

// ---------- helpers ----------

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtInt = (n) => (n == null ? "–" : Number(n).toLocaleString("zh-CN"));
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "–");
const minuteStamp = () => Math.floor(Date.now() / 60000);

function rel(iso) {
  if (!iso) return "–";
  const t = new Date(String(iso).replace(" ", "T")).getTime();
  if (Number.isNaN(t)) return esc(iso);
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
}
function abs(iso) {
  if (!iso) return "";
  const d = new Date(String(iso).replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString("zh-CN", { hour12: false });
}
const when = (iso) => `<span title="${esc(abs(iso))}">${rel(iso)}</span>`;

async function getJSON(url, { optional = false } = {}) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) {
    if (optional && r.status === 404) return null;
    throw new Error(`${r.status} ${url}`);
  }
  return r.json();
}
async function getText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}
async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}
const encRev = (rev) => encodeURIComponent(rev);
const encPath = (p) => p.split("/").map(encodeURIComponent).join("/");
const hfResolve = (rev, path) => `${HF}/datasets/${S.dataset}/resolve/${encRev(rev)}/${encPath(path)}`;
const hfBlob = (rev, path) => `${HF}/datasets/${S.dataset}/tree/${encRev(rev)}/${encPath(path)}`;

// ---------- the MANIFEST.md and index.json of a bundle (same reading as tools/digest.py) ----------

function parseManifest(text) {
  const raw = {};
  let key = null;
  for (const line of (text || "").split("\n")) {
    const m = line.match(/^([A-Za-z0-9_ ]+?):\s+(.*)$/);
    if (m && !line.startsWith(" ")) { key = m[1].trim(); raw[key] = m[2].trim(); }
    else if (key && line.trim()) raw[key] += "\n" + line.trim();
  }
  const out = {};
  const h = (raw.host || "").match(/^(.*?),\s*(\d+) CPUs,\s*(\d+) GB RAM/);
  if (h) out.host = { cpu_model: h[1], cpus: +h[2], ram_gb: +h[3] };
  out.gpus = (raw.GPUs || "").split(";").map((s) => s.trim()).filter(Boolean).map((g) => g.split(",").map((x) => x.trim()))
    .filter((p) => p.length >= 3).map((p) => ({ index: p[0], name: p[1], driver: p[2] }));
  const r = (raw.runner || "").match(/runner (\d+): (\S+) (\S+) effort (\S+), run id (\S+), modes ([^,]+), web search (\w+)(?:, usage gateway (.+))?/);
  if (r) out.runner = { pid: r[1], agent: r[2], model: r[3], effort: r[4], run_id: r[5], modes: r[6].split(/\s+/), web_search: r[7], usage_gateway: (r[8] || "off").trim() };
  const t = (raw.trials || "").match(/planned jobs (\S+), trial dirs (\S+), with a verdict (\S+)/);
  if (t) out.trials = { planned_jobs: t[1], trial_dirs: t[2], with_verdict: t[3] };
  const k = (raw.seeds || "").match(/K = (\d+)/);
  if (k) out.K = +k[1];
  return { parsed: out, raw };
}

function trialsFromIndex(idx, key, path, runId) {
  const rows = [];
  for (const j of idx.jobs || []) {
    const planned = j.tasks || [];
    for (const t of j.trials || []) {
      const p = planned.length === 1 ? planned[0] : (planned.find((x) => t.trial_dir.startsWith((x.task || "").slice(0, 20))) || {});
      const task = p.task || "";
      const base = task.replace(/-(privileged|standard|standard-realtime)$/, "") || null;
      rows.push({
        bundle: key, job: j.job, trial_dir: t.trial_dir, base, mode: p.mode || null, k: p.trial ?? null, seed: p.seed ?? null,
        run_id: idx.run_id || runId, reward: t.reward, exception: !!t.exception,
        result: t.reward != null && t.reward >= 1 ? "success" : "pending", result_source: "index",
        archive: `${path}/jobs/${j.job}.tar.gz`, live: true,
      });
    }
  }
  return rows;
}

// ---------- live listing of the dataset ----------

async function hfTree(rev, path) {
  const url = `${HF}/api/datasets/${S.dataset}/tree/${encRev(rev)}${path ? "/" + encPath(path) : ""}?expand=true`;
  return (await getJSON(url, { optional: true })) || [];
}
async function hfRevisions() {
  const revs = [{ rev: "main", label: "main" }];
  for (let p = 0; p < 20; p++) {
    const d = await getJSON(`${HF}/api/datasets/${S.dataset}/discussions?p=${p}`);
    for (const x of d.discussions || []) if (x.isPullRequest && x.status === "open") revs.push({ rev: `refs/pr/${x.num}`, label: `PR #${x.num}` });
    if (!d.discussions?.length || (p + 1) * 50 >= (d.count || 0)) break;
  }
  return revs;
}
async function listBundles() {
  const out = [];
  for (const { rev, label } of await hfRevisions()) {
    const helpers = (await hfTree(rev, "")).filter((e) => e.type === "directory");
    for (const h of helpers) {
      const batches = (await hfTree(rev, h.path)).filter((e) => e.type === "directory");
      const lists = await pool(batches, 4, (b) => hfTree(rev, b.path));
      lists.forEach((us) => us.filter((e) => e.type === "directory").forEach((u) => out.push({
        key: u.path.split("/").join("__"), rev, label, path: u.path, uploaded_at: u.lastCommit?.date || null,
      })));
    }
  }
  const seen = new Set();
  return out.sort((a, b) => (a.rev !== "main") - (b.rev !== "main")).filter((b) => !seen.has(b.key) && seen.add(b.key));
}

async function refreshLive() {
  const btn = $("#refresh");
  btn.disabled = true;
  try {
    const info = await getJSON(`${HF}/api/datasets/${S.dataset}`);
    const listed = await listBundles();
    const known = new Set(S.digest.bundles.map((b) => b.key));
    const fresh = listed.filter((b) => !known.has(b.key));
    const trials = [];
    const bundles = await pool(fresh, 4, async (b) => {
      let man = { parsed: {}, raw: {} }, idx = {}, err = [];
      try { man = parseManifest(await getText(hfResolve(b.rev, `${b.path}/MANIFEST.md`))); } catch (e) { err.push(`MANIFEST.md: ${e.message}`); }
      try { idx = await getJSON(hfResolve(b.rev, `${b.path}/index.json`)); } catch (e) { err.push(`index.json: ${e.message}`); }
      const [helper, batch, bundle] = b.path.split("/");
      const runId = idx.run_id || man.parsed.runner?.run_id || null;
      const ts = trialsFromIndex(idx, b.key, b.path, runId);
      trials.push(...ts);
      return {
        key: b.key, helper, batch, bundle, path: b.path, revision: b.rev, source: b.label, uploaded_at: b.uploaded_at,
        url: hfBlob(b.rev, b.path), run_id: runId, manifest: man.parsed, manifest_fields: man.raw, manifest_raw: man.raw,
        jobs: (idx.jobs || []).length, trials: ts.length, errors: err, pending: true,
      };
    });
    S.live = { bundles, trials, listed: listed.map((b) => b.key), error: null, at: new Date().toISOString(), info };
  } catch (e) {
    S.live = { ...S.live, error: e.message, at: new Date().toISOString() };
  }
  btn.disabled = false;
  render();
}

// ---------- the model: every trial assigned to a pair and a slot (pair, base, mode, trial number) ----------

function pairOf(bundle, trial) {
  const r = bundle?.manifest?.runner;
  const runId = trial?.run_id || bundle?.run_id || r?.run_id || "";
  const parts = runId.split("-");
  const harness = r?.agent || parts[0] || "";
  const model = r?.model || parts.slice(1, -1).join("-");
  for (const t of S.targets) {
    if (new RegExp(t.match.harness, "i").test(harness) && new RegExp(t.match.model, "i").test(model)) return t.id;
  }
  return runId ? `other:${runId}` : "other:?";
}

function statusOf(t) {
  if (t.result === "success") return "ok";
  if (t.result === "fail") return "fail";
  if (t.result === "pending") return "wait";
  return "void";       // not_a_result, no_verdict
}

function buildModel() {
  const listed = S.live.listed ? new Set(S.live.listed) : null;
  const digestB = S.digest.bundles.map((b) => ({ ...b, pending: false, gone: listed ? !listed.has(b.key) : false }));
  const bundles = [...S.live.bundles, ...digestB].sort((a, b) => String(b.uploaded_at || "").localeCompare(String(a.uploaded_at || "")));
  const bmap = Object.fromEntries(bundles.map((b) => [b.key, b]));
  const trials = [...S.digest.trials, ...S.live.trials].filter((t) => !bmap[t.bundle]?.gone).map((t) => {
    const b = bmap[t.bundle];
    return { ...t, pair: pairOf(b, t), status: statusOf(t), when: t.finished_at || b?.uploaded_at || "" };
  });
  const baseSet = new Set(S.tasks.tasks.map((x) => x.base));
  const K = S.tasks.trials_per_task_mode;

  // slot -> attempts (time order); a trial without a trial number takes the first free number of its task and mode
  const slots = {};
  const byTM = {};
  for (const t of trials.sort((a, b) => String(a.when).localeCompare(String(b.when)))) {
    if (!t.base || !MODES.includes(t.mode)) continue;
    const tm = `${t.pair}|${t.base}|${t.mode}`;
    (byTM[tm] ||= []).push(t);
  }
  for (const [tm, ts] of Object.entries(byTM)) {
    const used = new Set(ts.filter((t) => t.k).map((t) => t.k));
    let next = 1;
    for (const t of ts) {
      let k = t.k;
      if (!k) { while (used.has(next)) next++; k = next; used.add(k); }
      (slots[`${tm}|${k}`] ||= []).push(t);
    }
  }
  const eff = {};
  for (const [key, ts] of Object.entries(slots)) {
    const counted = ts.filter((t) => t.status === "ok" || t.status === "fail");
    eff[key] = { attempts: ts, final: counted.length ? counted[counted.length - 1] : ts[ts.length - 1] };
  }

  const pairs = {};
  const pairIds = [...S.targets.map((t) => t.id), ...new Set(trials.map((t) => t.pair).filter((p) => p.startsWith("other:")))];
  for (const id of pairIds) {
    const p = { id, total: 0, ok: 0, fail: 0, void: 0, wait: 0, empty: 0, modes: {}, unknownBases: new Set(), runIds: new Set(), helpers: new Set(), last: null };
    for (const m of MODES) p.modes[m] = { total: 0, ok: 0, fail: 0, void: 0, wait: 0, empty: 0 };
    for (const task of S.tasks.tasks) for (const m of MODES) for (let k = 1; k <= K; k++) {
      const e = eff[`${id}|${task.base}|${m}|${k}`];
      const st = e ? e.final.status : "empty";
      p[st]++; p.total++; p.modes[m][st]++; p.modes[m].total++;
    }
    for (const t of trials.filter((x) => x.pair === id)) {
      if (t.base && !baseSet.has(t.base)) p.unknownBases.add(t.base);
      if (t.run_id) p.runIds.add(t.run_id);
      const b = bmap[t.bundle];
      if (b) { p.helpers.add(b.helper); if (!p.last || String(b.uploaded_at) > String(p.last)) p.last = b.uploaded_at; }
    }
    pairs[id] = p;
  }
  S.model = { bundles, bmap, trials, eff, pairs, K };
}

// ---------- rendering ----------

function bar(p, total) {
  const w = (n) => `${(100 * n) / total}%`;
  return `<div class="bar" role="img" aria-label="成功 ${p.ok}，失败 ${p.fail}，不算结果 ${p.void}，待解析 ${p.wait}，共 ${total}">
    <div class="seg ok" style="width:${w(p.ok)}"></div><div class="seg fail" style="width:${w(p.fail)}"></div>
    <div class="seg void" style="width:${w(p.void)}"></div><div class="seg wait" style="width:${w(p.wait)}"></div></div>`;
}

function renderCards() {
  const { pairs } = S.model;
  $("#cards").innerHTML = S.targets.map((t) => {
    const p = pairs[t.id];
    const counted = p.ok + p.fail;
    const tags = [t.via ? `<span class="tag">${esc(t.via)}</span>` : "", t.tentative ? `<span class="tag warn">待定</span>` : ""].join("");
    const modes = MODES.map((m) => {
      const q = p.modes[m];
      return `<span>${MODE_ZH[m]}</span>${bar(q, q.total)}<span class="mono">${q.ok + q.fail}/${q.total}</span>`;
    }).join("");
    const foot = p.runIds.size
      ? `<span>run id：${[...p.runIds].map((r) => `<code>${esc(r)}</code>`).join("、")}</span><span>上传者：${esc([...p.helpers].join("、"))}</span><span>最近上传 ${when(p.last)}</span>`
      : `<span>还没有上传</span>`;
    const unknown = p.unknownBases.size ? `<span class="tag bad" title="${esc([...p.unknownBases].join(", "))}">${p.unknownBases.size} 个底档不在 ${esc(S.tasks.release)} 里</span>` : "";
    return `<article class="panel card" aria-label="${esc(t.harness)} + ${esc(t.model)}">
      <div class="card-top"><div><div class="harness">${esc(t.harness)}</div><div class="model">${esc(t.model)}</div></div><div class="chips">${tags}${unknown}</div></div>
      <div class="count"><span class="n">${counted}</span><span class="d">/ ${p.total} 局已出结果</span></div>
      ${bar(p, p.total)}
      <div class="stats">
        <div class="stat" title="成功 ÷（成功 + 失败），只算已出结果的局"><span class="k">成功率</span><span class="v">${pct(p.ok, counted)}</span></div>
        <div class="stat"><span class="k">成功 / 失败</span><span class="v">${p.ok} / ${p.fail}</span></div>
        <div class="stat" title="不算结果的局，要用同一个种子重跑"><span class="k">要重跑</span><span class="v">${p.void}</span></div>
        <div class="stat"><span class="k">待解析 / 未跑</span><span class="v">${p.wait} / ${p.empty}</span></div>
      </div>
      <div class="modes">${modes}</div>
      <div class="card-foot">${foot}</div>
    </article>`;
  }).join("");

  const others = Object.values(pairs).filter((p) => p.id.startsWith("other:"));
  $("#other-runs").innerHTML = others.length ? `<div class="table-wrap"><table>
    <thead><tr><th>不属于上面六个组合的运行（run id）</th><th>上传者</th><th>已出结果</th><th>成功 / 失败</th><th>不算结果</th><th>最近上传</th></tr></thead>
    <tbody>${others.map((p) => `<tr><td><code>${esc(p.id.slice(6))}</code></td><td>${esc([...p.helpers].join("、"))}</td>
      <td class="mono">${p.ok + p.fail} / ${p.total}</td><td class="mono">${p.ok} / ${p.fail}</td><td class="mono">${p.void}</td><td>${when(p.last)}</td></tr>`).join("")}</tbody></table></div>` : "";
}

function latestByHelper() {
  const out = {};
  for (const b of S.model.bundles) {
    if (!out[b.helper]) out[b.helper] = { latest: b, all: [] };
    out[b.helper].all.push(b);
  }
  return out;
}

function driverTag(drv) {
  const major = parseInt(String(drv || "").split(".")[0], 10);
  if (!major) return "";
  return major >= 580 ? `<span class="tag good">驱动 ≥ 580</span>` : `<span class="tag bad">驱动低于 580（2.x 的布料任务要 ≥ 580）</span>`;
}

function renderHosts() {
  const groups = latestByHelper();
  const names = Object.keys(groups);
  if (!names.length) {
    $("#hosts").innerHTML = `<div class="panel empty-state"><b>还没有任何上传，所以 GPU 型号和运行方式都还不知道。</b>
      <span>第一次上传后，这里会显示 MANIFEST.md 里的内容：GPU 型号、数量和驱动版本，CPU 型号、核数和内存，docker、Harbor、镜像版本，运行器的 agent、model、effort、模式、是否开网页搜索、用量网关，以及 batch 日志里的并行 runner 数和并发数。</span></div>`;
    return;
  }
  $("#hosts").innerHTML = names.map((h) => {
    const { latest: b, all } = groups[h];
    const m = b.manifest || {};
    const raw = b.manifest_fields || {};
    const r = m.runner || {};
    const gpus = m.gpus || [];
    const gpuNames = Object.entries(gpus.reduce((a, g) => ((a[g.name] = (a[g.name] || 0) + 1), a), {}));
    const machines = new Set(all.map((x) => `${x.manifest?.host?.cpu_model || "?"} · ${(x.manifest?.gpus || []).map((g) => g.name).join("+") || "?"}`));
    const log = b.log || {};
    return `<article class="panel host">
      <div class="host-head"><h3>${esc(h)}</h3><span class="small muted">最近一次上传 ${when(b.uploaded_at)}：<code>${esc(b.batch)}/${esc(b.bundle)}</code>${b.pending ? "（日志待解析）" : ""}</span></div>
      <div class="gpu-line">${gpuNames.length ? gpuNames.map(([n, c]) => `<span class="gpu">${c} × ${esc(n)}</span>`).join("") : `<span class="muted">MANIFEST 里没有 GPU 信息</span>`}
        ${gpus[0] ? `<span class="chip">驱动 ${esc(gpus[0].driver)}</span>${driverTag(gpus[0].driver)}` : ""}</div>
      <div class="two">
        <dl class="kv">
          <dt>CPU</dt><dd>${m.host ? `${esc(m.host.cpu_model)}，${m.host.cpus} 核` : "–"}</dd>
          <dt>内存</dt><dd>${m.host ? `${m.host.ram_gb} GB` : "–"}</dd>
          <dt>软件</dt><dd>${esc(raw.software || "–")}</dd>
          <dt>代码</dt><dd class="mono">${esc(raw.repo || "–")}</dd>
          <dt>镜像</dt><dd class="mono small">${esc(raw.images || "–").replace(/\n/g, "<br>")}</dd>
        </dl>
        <dl class="kv">
          <dt>harness</dt><dd>${esc(r.agent || "–")}</dd>
          <dt>model</dt><dd>${esc(r.model || "–")}</dd>
          <dt>effort</dt><dd>${esc(r.effort || "–")}</dd>
          <dt>run id</dt><dd class="mono">${esc(b.run_id || r.run_id || "–")}</dd>
          <dt>模式</dt><dd>${esc((r.modes || []).join(" + ") || "–")}</dd>
          <dt>网页搜索</dt><dd>${esc(r.web_search || "–")}</dd>
          <dt>用量网关</dt><dd>${esc(r.usage_gateway || "–")}</dd>
          <dt>并行</dt><dd>${log.lanes ? `${log.lanes} 个 runner，每个 Harbor job 并发 ${log.concurrency_max ?? "–"}` : (b.pending ? "日志待解析" : "–")}</dd>
          <dt>每任务局数</dt><dd>${m.K ? `K = ${m.K}` : "–"}</dd>
          <dt>本批局数</dt><dd>${m.trials ? `计划 ${esc(m.trials.planned_jobs)} 个 job，${esc(m.trials.trial_dirs)} 个 trial 目录，${esc(m.trials.with_verdict)} 个有判定` : "–"}</dd>
        </dl>
      </div>
      ${raw.notes && raw.notes !== "none" ? `<div class="small"><b>上传者备注：</b>${esc(raw.notes)}</div>` : ""}
      ${machines.size > 1 ? `<div class="small muted">这个上传者用过 ${machines.size} 种机器：${[...machines].map(esc).join("；")}</div>` : ""}
    </article>`;
  }).join("");
}

function machineClass(task) { return task.material === "rigid" ? "shared" : "exclusive"; }

function renderMachines() {
  const SPEC = {
    shared: { title: "刚体任务", rule: "一块 GPU 同时跑 4 局；每局至少分配 2 个 CPU 核 + 4 GB 内存" },
    exclusive: { title: "可形变任务（绳、布料、线缆、纤维）", rule: "每局独占一块 GPU；每局至少分配 4 个 CPU 核 + 8 GB 内存" },
  };
  const K = S.model.K;
  const trialsBy = { shared: [], exclusive: [] };
  const taskBy = Object.fromEntries(S.tasks.tasks.map((t) => [t.base, t]));
  for (const t of S.model.trials) { const task = taskBy[t.base]; if (task) trialsBy[machineClass(task)].push(t); }
  $("#machine-specs").innerHTML = Object.entries(SPEC).map(([cls, spec]) => {
    const tasks = S.tasks.tasks.filter((t) => machineClass(t) === cls);
    const fams = [...new Set(tasks.map((t) => t.family_name))];
    const caps = Object.entries(tasks.reduce((a, t) => { const k = `${t.cpus} CPU / ${Math.round(t.memory_mb / 1024)} GB`; a[k] = (a[k] || 0) + 1; return a; }, {}))
      .sort((a, b) => b[1] - a[1]).map(([k, n]) => `<span class="chip">${esc(k)} × ${n}</span>`).join("");
    const ts = trialsBy[cls];
    const peak = (f) => { const v = ts.map((t) => t[f]).filter((x) => typeof x === "number"); return v.length ? Math.max(...v) : null; };
    const pm = peak("peak_memory_gb"), pg = peak("peak_gpu_memory_gb");
    const ooms = ts.reduce((a, t) => a + (t.oom_kills || 0), 0);
    const measured = ts.filter((t) => typeof t.peak_memory_gb === "number").length;
    return `<article class="panel spec">
      <div class="big">${spec.title}</div>
      <div>${esc(spec.rule)}</div>
      <dl class="kv">
        <dt>底档</dt><dd>${tasks.length} 个，每个组合 ${tasks.length * MODES.length * K} 局</dd>
        <dt>族</dt><dd><div class="chips">${fams.map((f) => `<span class="chip">${esc(f)}</span>`).join("")}</div></dd>
        <dt>task.toml 上限</dt><dd><div class="chips">${caps}</div><div class="small faint">容器能用的上限（超过会被限流或杀掉），不是预留。</div></dd>
        <dt>实测峰值</dt><dd>${measured ? `内存最高 ${pm?.toFixed(1)} GB，显存最高 ${pg?.toFixed(1) ?? "–"} GB（${measured} 局有记录）${ooms ? `；<span class="tag bad">${ooms} 次 OOM 或紧急终止</span>` : ""}` : `<span class="faint">还没有解析过的局</span>`}</dd>
      </dl>
    </article>`;
  }).join("");
}

function pairLabel(id) {
  const t = S.targets.find((x) => x.id === id);
  return t ? `${t.harness} + ${t.model}` : id.startsWith("other:") ? id.slice(6) : id;
}

function renderBundles() {
  const bs = S.model.bundles;
  if (!bs.length) {
    $("#bundles").innerHTML = `<div class="panel empty-state"><b>数据集里还没有上传包。</b><span>数据集 <a href="${HF}/datasets/${esc(S.dataset)}" target="_blank" rel="noopener">${esc(S.dataset)}</a> 目前${S.live.info ? `只有 ${S.live.info.siblings?.length ?? 0} 个文件，最后更新 ${when(S.live.info.lastModified)}` : "还读不到"}。上传后（直接提交或 pull request）这里会在下次刷新时出现。</span></div>`;
    return;
  }
  const counts = (key) => {
    const ts = S.model.trials.filter((t) => t.bundle === key);
    const c = { ok: 0, fail: 0, void: 0, wait: 0 };
    ts.forEach((t) => c[t.status]++);
    return c;
  };
  $("#bundles").innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>上传时间</th><th>上传者</th><th>batch / bundle</th><th>来源</th><th>组合</th><th>局数</th><th>成功 / 失败 / 不算 / 待解析</th><th>状态</th></tr></thead>
    <tbody>${bs.map((b) => {
      const c = counts(b.key);
      const pair = pairOf(b, null);
      const state = b.gone ? `<span class="pill fail">已从数据集删除</span>` : b.pending ? `<span class="pill wait">待解析</span>`
        : b.errors?.length ? `<span class="pill void" title="${esc(b.errors.join("\n"))}">解析有问题</span>` : `<span class="pill ok">已解析</span>`;
      return `<tr class="clickable" data-bundle="${esc(b.key)}" tabindex="0">
        <td class="nowrap">${when(b.uploaded_at)}</td><td>${esc(b.helper)}</td>
        <td class="mono">${esc(b.batch)}<br><span class="faint">${esc(b.bundle)}</span></td>
        <td>${esc(b.source)}</td><td>${esc(pairLabel(pair))}</td><td class="mono">${b.trials}</td>
        <td class="mono">${c.ok} / ${c.fail} / ${c.void} / ${c.wait}</td><td>${state}</td></tr>`;
    }).join("")}</tbody></table></div>`;
}

function errorRows() {
  const rows = [];
  const rerun = new Set();
  for (const e of Object.values(S.model.eff)) if (e.attempts.length > 1) e.attempts.forEach((t) => rerun.add(t));
  for (const t of S.model.trials) {
    const kinds = [];
    if (t.status === "void") kinds.push(t.result === "no_verdict" ? "no_verdict" : "void");
    // an agent that ran out of time (AgentTimeoutError) ended with a result, the agent's 0: not an error
    if ((t.exception || t.exception_type) && !(t.status === "fail" && t.exception_type === "AgentTimeoutError")) kinds.push("exception");
    if (rerun.has(t)) kinds.push("rerun");
    if (kinds.length) rows.push({ t, kinds });
  }
  return rows.sort((a, b) => String(b.t.when).localeCompare(String(a.t.when)));
}

function renderErrors() {
  const rows = errorRows();
  const sel = $("#err-target");
  const pairsSeen = [...new Set(rows.map((r) => r.t.pair))];
  const keep = sel.value || "all";
  sel.innerHTML = `<option value="all">全部</option>` + pairsSeen.map((p) => `<option value="${esc(p)}">${esc(pairLabel(p))}</option>`).join("");
  sel.value = pairsSeen.includes(keep) ? keep : "all";
  const kind = $("#err-kind").value;
  const TODO = ["void", "no_verdict", "exception"];
  const match = (r) => kind === "all" || (kind === "todo" ? r.kinds.some((k) => TODO.includes(k)) : r.kinds.includes(kind));
  const shown = rows.filter((r) => (sel.value === "all" || r.t.pair === sel.value) && match(r));

  const why = (t) => t.reason || (t.exception_type !== "AgentTimeoutError" && t.exception_type) || (t.result === "no_verdict" ? "没有判定（评分器没跑完）" : "")
    || (t.status === "wait" ? "日志待解析" : "") || "重跑过";
  const tally = {};
  shown.forEach((r) => { const k = why(r.t); tally[k] = (tally[k] || 0) + 1; });
  $("#error-kinds").innerHTML = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 14)
    .map(([k, n]) => `<span class="chip" title="${esc(k)}">${esc(k.length > 70 ? k.slice(0, 70) + "…" : k)} · ${n}</span>`).join("");

  if (!rows.length) {
    $("#error-table").innerHTML = `<div class="panel empty-state"><b>还没有出错或重跑的局。</b><span>有上传后，这里列出不算结果的局（例如 API 断连、容器起不来、评分器出错，按协议要用同一个种子重跑一次）、没有判定的局、Harbor 报了异常的局，以及同一局跑过不止一次的记录。</span></div>`;
    return;
  }
  if (!shown.length) { $("#error-table").innerHTML = `<div class="panel empty-state"><span>没有符合筛选条件的局（共 ${rows.length} 条记录，换个类型看看）。</span></div>`; return; }
  $("#error-table").innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>时间</th><th>组合</th><th>底档</th><th>模式</th><th>局 / 种子</th><th>结果</th><th>原因 / 异常</th><th>内存峰值</th><th>上传包</th></tr></thead>
    <tbody>${shown.slice(0, 400).map(({ t, kinds }) => `<tr class="clickable" data-trial="${esc(t.bundle)}|${esc(t.job)}|${esc(t.trial_dir)}" tabindex="0">
      <td class="nowrap">${when(t.when)}</td><td>${esc(pairLabel(t.pair))}</td><td class="mono">${esc(t.base || "?")}</td><td>${esc(t.mode || "?")}</td>
      <td class="mono">${t.k ?? "?"} / ${t.seed ?? "?"}</td><td><span class="pill ${t.status}">${STATUS_ZH[t.status]}</span>${kinds.includes("rerun") ? ` <span class="tag">重跑过</span>` : ""}</td>
      <td>${esc(why(t))}</td><td class="mono">${typeof t.peak_memory_gb === "number" ? t.peak_memory_gb.toFixed(1) + " GB" : "–"}</td>
      <td class="mono small nowrap">${esc(S.model.bmap[t.bundle]?.batch || "")}</td></tr>`).join("")}</tbody></table></div>
    ${shown.length > 400 ? `<p class="small muted">只列出最近 400 条（共 ${shown.length} 条）。</p>` : ""}`;
}

function renderMatrix() {
  const mat = $("#mx-material").value, diff = $("#mx-diff").value, q = $("#mx-search").value.trim().toLowerCase();
  const onlyIncomplete = $("#mx-incomplete").checked;
  const K = S.model.K;
  const cols = S.targets;
  const head = `<div class="mrow head" style="--cols:${cols.length}"><div>底档</div>${cols.map((t) => `<div title="${esc(t.harness)} + ${esc(t.model)}">${esc(t.harness)}<br>${esc(t.model)}</div>`).join("")}</div>`;
  let html = head;
  for (const cat of S.tasks.categories) {
    if (mat !== "all" && cat.material !== mat) continue;
    let catHtml = "";
    for (const fam of cat.families) {
      const tasks = S.tasks.tasks.filter((t) => t.family === fam && (diff === "all" || t.difficulty === diff) && (!q || t.base.includes(q)));
      let famHtml = "";
      for (const task of tasks) {
        let complete = true;
        const cells = cols.map((c) => {
          const sq = MODES.map((m) => Array.from({ length: K }, (_, i) => {
            const key = `${c.id}|${task.base}|${m}|${i + 1}`;
            const e = S.model.eff[key];
            const st = e ? e.final.status : "empty";
            if (st !== "ok" && st !== "fail") complete = false;
            const seed = e?.final.seed ?? "?";
            const tip = `${task.base} · ${c.harness} + ${c.model}\n${m} 第 ${i + 1} 局（种子 ${seed}）：${STATUS_ZH[st]}${e && e.attempts.length > 1 ? `，跑过 ${e.attempts.length} 次` : ""}${e?.final.reason ? `\n${e.final.reason}` : ""}`;
            return `<span class="cell ${st === "empty" ? "" : st}" title="${esc(tip)}"${e ? ` data-trial="${esc(e.final.bundle)}|${esc(e.final.job)}|${esc(e.final.trial_dir)}"` : ""}></span>`;
          }).join("")).join("");
          return `<div class="mcell">${sq}</div>`;
        }).join("");
        if (onlyIncomplete && complete) continue;
        const badges = [task.easy_set ? "easy set" : "", task.own_group ? "6 h" : "", task.difficulty].filter(Boolean).join(" · ");
        famHtml += `<div class="mrow" style="--cols:${cols.length}"><div class="mname" title="${esc(task.base)}">${esc(task.base.replace(/^roboarc-/, ""))}<span class="badge">${esc(badges)}</span></div>${cells}</div>`;
      }
      if (famHtml) catHtml += `<div class="mrow fam"><div>${esc(S.tasks.tasks.find((t) => t.family === fam).family_name)}</div></div>${famHtml}`;
    }
    if (catHtml) html += `<div class="mrow group"><div>${cat.material === "rigid" ? "刚体" : "可形变"} · ${esc(cat.name)}</div></div>${catHtml}`;
  }
  $("#matrix-grid").innerHTML = html;
}

function renderFrames() {
  const fam = $("#fr-family").value;
  const byFam = {};
  for (const t of S.tasks.tasks) if (fam === "all" || t.family === fam) (byFam[t.family] ||= []).push(t);
  const nFrames = Object.values(S.frames).reduce((a, x) => a + Object.keys(x).length, 0);
  $("#frame-list").innerHTML = (nFrames ? "" : `<div class="panel empty-state"><b>首帧还没有渲染。</b><span>每个底档每个允许的种子一张 cam_high 出生画面，共 ${S.tasks.tasks.reduce((a, t) => a + t.seeds.length, 0)} 张；渲染后放进 <code>frames/</code> 并登记在 <code>data/frames.json</code>。</span></div>`) +
    Object.entries(byFam).map(([f, tasks]) => `<div class="frame-fam"><h3>${esc(tasks[0].family_name)} <span class="small muted">${tasks[0].material === "rigid" ? "刚体" : "可形变"} · ${tasks.length} 个底档</span></h3>
      <div class="frame-grid">${tasks.map((t) => `<div class="panel frame-task"><div class="t"><span>${esc(t.base.replace(/^roboarc-/, ""))}</span><span class="faint">${esc(t.difficulty)}</span></div>
        <div class="seeds">${[0, 1, 2].map((s) => {
          const src = S.frames[t.base]?.[String(s)];
          const allowed = t.seeds.includes(s);
          const body = !allowed ? `<div class="ph">只允许种子 0</div>` : src ? `<img src="${esc(src)}" alt="${esc(t.base)} 种子 ${s} 首帧" loading="lazy" width="848" height="480">` : `<div class="ph">未渲染</div>`;
          return `<div class="seed">${body}<div class="lbl">种子 ${s}</div></div>`;
        }).join("")}</div></div>`).join("")}</div></div>`).join("");
}

function renderStatus() {
  const d = S.digest;
  const live = S.live;
  const nPending = live.bundles.length;
  $("#live-status").innerHTML = live.error
    ? `<span class="dot err"></span>读取 Hugging Face 失败：${esc(live.error)}（下面是上次解析的结果）`
    : live.at
      ? `<span class="dot live"></span>Hugging Face：数据集更新于 <b>${when(live.info?.lastModified)}</b>，${live.listed?.length ?? 0} 个上传包${nPending ? `，其中 ${nPending} 个日志待解析` : ""}；${when(live.at)}读取`
      : `<span class="dot"></span>正在读取 Hugging Face…`;
  $("#digest-status").innerHTML = d.generated_at ? `日志解析于 ${when(d.generated_at)}` : "日志还没有解析过";
  $("#release").textContent = `RoboARC ${S.tasks.release} · ${S.tasks.tasks.length} 个底档`;
  $("#foot-release").innerHTML = `任务表来自 RoboARC ${esc(S.tasks.release)}（<code>${esc(S.tasks.commit)}</code>）的 tasks/；组合列表见 <code>data/targets.json</code>。`;
}

function render() {
  if (!S.tasks) return;
  buildModel();
  if (!OFFLINE) renderStatus(); else { $("#digest-status").innerHTML = S.digest.generated_at ? `日志解析于 ${when(S.digest.generated_at)}` : ""; $("#release").textContent = `RoboARC ${S.tasks.release} · ${S.tasks.tasks.length} 个底档`; }
  renderCards();
  renderHosts();
  renderMachines();
  renderBundles();
  renderErrors();
  renderMatrix();
}

// ---------- drawers: a bundle, a trial ----------

function openDrawer(title, sub, bodyHtml) {
  const root = $("#drawer-root");
  const prev = document.activeElement;
  root.innerHTML = `<div class="drawer-backdrop" data-close></div>
    <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
      <header><div><h3 id="drawer-title">${title}</h3><div class="small muted">${sub}</div></div><button class="btn" type="button" data-close>关闭</button></header>
      <div class="body">${bodyHtml}</div></aside>`;
  const close = () => { root.innerHTML = ""; document.removeEventListener("keydown", onKey); prev?.focus?.(); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  root.querySelectorAll("[data-close]").forEach((el) => el.addEventListener("click", close));
  root.querySelector(".drawer button").focus();
  return root.querySelector(".drawer .body");
}

const pre = (lines) => `<pre class="log">${esc(Array.isArray(lines) ? lines.join("\n") : lines)}</pre>`;
const jsonPre = (o) => pre(JSON.stringify(o, null, 1));

async function bundleDetail(b) {
  if (b.pending || !b.detail_file) return null;
  if (!(b.key in S.details)) {
    try { S.details[b.key] = await getJSON(`${b.detail_file}?v=${minuteStamp()}`); } catch { S.details[b.key] = null; }
  }
  return S.details[b.key];
}

async function openBundle(key) {
  const b = S.model.bmap[key];
  if (!b) return;
  const body = openDrawer(`${esc(b.batch)} <span class="faint">/ ${esc(b.bundle)}</span>`,
    `${esc(b.helper)} · ${esc(b.source)} · 上传于 ${esc(abs(b.uploaded_at))}${b.url ? ` · <a href="${esc(b.url)}" target="_blank" rel="noopener">在 Hugging Face 打开</a>` : ""}`, `<p class="muted">读取中…</p>`);
  const d = await bundleDetail(b);
  const raw = b.manifest_fields || {};
  let html = "";
  if (b.errors?.length) html += `<div><h4>解析时的问题</h4>${pre(b.errors)}</div>`;
  html += `<div><h4>运行设置</h4><dl class="kv">
    <dt>组合</dt><dd>${esc(pairLabel(pairOf(b, null)))}</dd><dt>run id</dt><dd class="mono">${esc(b.run_id || "–")}</dd>
    <dt>局数</dt><dd>${b.trials}（${b.jobs} 个 job）</dd>
    ${b.log ? `<dt>batch 日志</dt><dd>${esc(b.log.first || "")} → ${esc(b.log.last || "")}，${b.log.lanes} 个 runner，并发 ${b.log.concurrency_max ?? "–"}</dd>` : ""}
    ${Object.entries(raw).filter(([k]) => ["notes", "mirror", "results"].includes(k)).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}
  </dl></div>`;
  if (d?.manifest_text) html += `<div><h4>MANIFEST.md</h4>${pre(d.manifest_text)}</div>`;
  else if (b.pending) html += `<div><h4>MANIFEST.md</h4>${pre(Object.entries(raw).map(([k, v]) => `${k}: ${v}`).join("\n"))}</div>`;
  if (d?.log_notable?.length) html += `<div><h4>batch 日志里的报错和重跑行</h4>${pre(d.log_notable)}</div>`;
  if (d?.summary_md) html += `<details><summary class="small">batch 汇总表（${esc(b.batch)}.summary.md）</summary>${pre(d.summary_md)}</details>`;
  if (b.pending) html += `<p class="small muted">这个包的日志还没有被定时任务解析，下次解析后会显示官方判定、异常和资源峰值。</p>`;
  body.innerHTML = html;
}

async function openTrial(ref) {
  const [bkey, job, trialDir] = ref.split("|");
  const t = S.model.trials.find((x) => x.bundle === bkey && x.job === job && x.trial_dir === trialDir);
  const b = S.model.bmap[bkey];
  if (!t || !b) return;
  const slot = S.model.eff[`${t.pair}|${t.base}|${t.mode}|${t.k}`];
  const body = openDrawer(`${esc(t.base || "?")} <span class="faint">· ${esc(t.mode || "?")} 第 ${t.k ?? "?"} 局</span>`,
    `${esc(pairLabel(t.pair))} · 种子 ${t.seed ?? "?"} · <code>${esc(t.trial_dir)}</code>`, `<p class="muted">读取中…</p>`);
  const d = (await bundleDetail(b))?.trials?.[`${job}/${trialDir}`];
  const kv = [
    ["结果", `<span class="pill ${t.status}">${STATUS_ZH[t.status]}</span>${t.result_source === "index" ? " <span class=\"small muted\">（只看了 index.json）</span>" : ""}`],
    ["原因", esc(t.reason || "–")], ["reward", esc(t.reward ?? "–")], ["Harbor 异常", esc(t.exception_type || (t.exception ? "有（待解析）" : "无"))],
    ["用时", t.wall_s != null ? `${Math.round(t.wall_s / 60)} 分钟` : "–"], ["token（输入 / 输出）", `${fmtInt(t.tokens_in)} / ${fmtInt(t.tokens_out)}`],
    ["费用", t.cost_usd != null ? `$${Number(t.cost_usd).toFixed(2)}` : "–"],
    ["内存 / 显存峰值", `${typeof t.peak_memory_gb === "number" ? t.peak_memory_gb.toFixed(2) : "–"} GB / ${typeof t.peak_gpu_memory_gb === "number" ? t.peak_gpu_memory_gb.toFixed(2) : "–"} GB`],
    ["OOM 或紧急终止", esc(t.oom_kills ?? "–")], ["harbor 退出码", esc(t.harbor_rc ?? "–")],
    ["这一局跑过", slot ? `${slot.attempts.length} 次${t.attempts_over_cap ? "（超过上限）" : ""}` : "–"],
  ];
  let html = `<dl class="kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
  if (slot && slot.attempts.length > 1) {
    html += `<div><h4>同一局的所有尝试</h4><div class="table-wrap"><table><thead><tr><th>时间</th><th>结果</th><th>原因</th><th>上传包</th></tr></thead><tbody>${slot.attempts.map((a) =>
      `<tr><td class="nowrap">${esc(abs(a.when))}</td><td><span class="pill ${a.status}">${STATUS_ZH[a.status]}</span></td><td>${esc(a.reason || a.exception_type || "")}</td><td class="mono small">${esc(S.model.bmap[a.bundle]?.batch || "")}</td></tr>`).join("")}</tbody></table></div></div>`;
  }
  if (d) {
    if (d.exception_message) html += `<div><h4>异常信息（result.json）</h4>${pre(d.exception_message)}</div>`;
    if (d.exception_tail) html += `<div><h4>exception.txt 末尾</h4>${pre(d.exception_tail)}</div>`;
    if (d.grade_tail && d.grade_tail.join("").trim()) html += `<div><h4>评分日志 verifier/grade.log 末尾</h4>${pre(d.grade_tail)}</div>`;
    if (d.trial_tail) html += `<div><h4>trial.log 末尾</h4>${pre(d.trial_tail)}</div>`;
    if (d.reward) html += `<details><summary class="small">评分字段 verifier/reward.json</summary>${jsonPre(d.reward)}</details>`;
    if (d.resource_limits) html += `<details><summary class="small">资源上限 verifier/resource_limits.json</summary>${jsonPre(d.resource_limits)}</details>`;
    if (d.gateway_totals) html += `<details><summary class="small">用量网关 gateway/totals.json</summary>${jsonPre(d.gateway_totals)}</details>`;
  }
  const archUrl = b.revision === "local" ? null : hfResolve(b.revision, t.archive);
  html += `<div><h4>完整日志包</h4><p class="small muted">从 Hugging Face 下载这一局的 job 包（<code>${esc(t.archive.split("/").pop())}</code>），在浏览器里解压，显示 exception.txt、trial.log、评分日志和 agent 日志的末尾。</p>
    <div class="chips" style="margin-top:6px">${archUrl ? `<button class="btn" type="button" id="load-archive">在页面里读取</button><a class="btn" href="${esc(archUrl)}" target="_blank" rel="noopener">下载 .tar.gz</a>` : "<span class=\"faint\">本地测试数据，没有下载地址</span>"}</div>
    <div id="archive-out"></div></div>`;
  body.innerHTML = html;
  body.querySelector("#load-archive")?.addEventListener("click", (e) => loadArchive(e.currentTarget, archUrl, job, trialDir));
}

// ---------- reading a job archive in the browser (gzip stream + tar) ----------

class ByteQueue {
  constructor(reader) { this.r = reader; this.q = []; this.off = 0; this.len = 0; this.total = 0; }
  async more() { const { done, value } = await this.r.read(); if (done) return false; this.q.push(value); this.len += value.length; this.total += value.length; return true; }
  async take(n) {
    while (this.len < n) if (!(await this.more())) return null;
    const out = new Uint8Array(n);
    let p = 0;
    while (p < n) {
      const c = this.q[0], k = Math.min(c.length - this.off, n - p);
      out.set(c.subarray(this.off, this.off + k), p); p += k; this.off += k;
      if (this.off === c.length) { this.q.shift(); this.off = 0; }
    }
    this.len -= n;
    return out;
  }
  async skip(n) {
    while (n > 0) {
      if (!this.len && !(await this.more())) return false;
      const c = this.q[0], k = Math.min(c.length - this.off, n);
      this.off += k; this.len -= k; n -= k;
      if (this.off === c.length) { this.q.shift(); this.off = 0; }
    }
    return true;
  }
}

async function untarGz(url, want, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const q = new ByteQueue(res.body.pipeThrough(new DecompressionStream("gzip")).getReader());
  const dec = new TextDecoder();
  const str = (h, a, b) => dec.decode(h.subarray(a, b)).replace(/\0[\s\S]*$/, "");
  const out = {};
  let longName = null, paxPath = null;
  for (;;) {
    const h = await q.take(512);
    if (!h || h.every((x) => x === 0)) break;
    let name = str(h, 0, 100);
    const size = parseInt(str(h, 124, 136).trim() || "0", 8) || 0;
    const type = String.fromCharCode(h[156] || 48);
    const prefix = str(h, 257, 263).startsWith("ustar") ? str(h, 345, 500) : "";
    if (prefix) name = `${prefix}/${name}`;
    const padded = Math.ceil(size / 512) * 512;
    if (type === "L") { const d = await q.take(padded); longName = str(d, 0, size); continue; }
    if (type === "x") { const d = await q.take(padded); const m = dec.decode(d.subarray(0, size)).match(/\d+ path=([^\n]*)\n/); if (m) paxPath = m[1]; continue; }
    if (longName) { name = longName; longName = null; }
    if (paxPath) { name = paxPath; paxPath = null; }
    if ((type === "0" || type === "\0") && want(name, size)) { const d = await q.take(padded); out[name] = d.subarray(0, size); }
    else if (!(await q.skip(padded))) break;
    onProgress?.(q.total);
  }
  return out;
}

async function loadArchive(btn, url, job, trialDir) {
  const outEl = $("#archive-out");
  btn.disabled = true;
  outEl.innerHTML = `<p class="small muted">下载并解压中…</p>`;
  const MAX = 50 << 20;
  const marker = `/${job}/${trialDir}/`;
  const keep = (rel) => ["exception.txt", "trial.log", "result.json", "verifier/grade.log", "verifier/reward.json", "verifier/verdict.json"].includes(rel)
    || /^agent\/[^/]+\.(txt|log)$/.test(rel) || /^agent\/setup\/[^/]+\.(txt|log)$/.test(rel);
  try {
    const files = await untarGz(url, (name, size) => size <= MAX && name.includes(marker) && keep(name.split(marker)[1]),
      (n) => { outEl.firstElementChild.textContent = `下载并解压中… 已解压 ${(n / 1048576).toFixed(1)} MB`; });
    const names = Object.keys(files).sort();
    if (!names.length) { outEl.innerHTML = `<p class="small muted">包里没有找到这一局的日志文件。</p>`; return; }
    const dec = new TextDecoder();
    const view = (n) => { const lines = dec.decode(files[n]).split("\n"); return (lines.length > 400 ? [`…（前 ${lines.length - 400} 行省略）`, ...lines.slice(-400)] : lines).join("\n"); };
    outEl.innerHTML = `<div class="tabs" role="tablist">${names.map((n, i) => `<button type="button" role="tab" aria-selected="${i === 0}" data-file="${esc(n)}">${esc(n.split(marker)[1])}</button>`).join("")}</div><pre class="log" id="archive-view"></pre>`;
    const show = (n) => { $("#archive-view").textContent = view(n); outEl.querySelectorAll("[role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.file === n))); };
    outEl.querySelectorAll("[role=tab]").forEach((b) => b.addEventListener("click", () => show(b.dataset.file)));
    show(names[0]);
  } catch (e) {
    outEl.innerHTML = `<p class="small" style="color:var(--fail)">读取失败：${esc(e.message)}。可以用“下载 .tar.gz”手动打开。</p>`;
    btn.disabled = false;
  }
}

// ---------- events and start ----------

function wire() {
  $("#refresh").addEventListener("click", () => { reloadDigest().then(refreshLive); });
  ["#err-target", "#err-kind"].forEach((s) => $(s).addEventListener("change", renderErrors));
  ["#mx-material", "#mx-diff", "#mx-incomplete"].forEach((s) => $(s).addEventListener("change", renderMatrix));
  $("#mx-search").addEventListener("input", renderMatrix);
  $("#fr-family").addEventListener("change", renderFrames);
  document.addEventListener("click", (e) => {
    const tr = e.target.closest("[data-trial]");
    if (tr) return openTrial(tr.dataset.trial);
    const br = e.target.closest("[data-bundle]");
    if (br) return openBundle(br.dataset.bundle);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const el = e.target.closest?.("[data-trial],[data-bundle]");
    if (el) el.click();
  });
}

async function reloadDigest() {
  const d = await getJSON(`data/digest.json?v=${minuteStamp()}`, { optional: true }).catch(() => null);
  if (d) { S.digest = d; S.details = {}; }
}

async function start() {
  const [tasks, targets, frames] = await Promise.all([
    getJSON(`data/tasks.json?v=${minuteStamp()}`), getJSON(`data/targets.json?v=${minuteStamp()}`),
    getJSON(`data/frames.json?v=${minuteStamp()}`, { optional: true }).catch(() => null),
  ]);
  S.tasks = tasks; S.targets = targets.targets; S.frames = frames?.frames || {};
  await reloadDigest();
  if (S.digest.dataset && !S.digest.dataset.startsWith("/")) S.dataset = S.digest.dataset;
  $("#ds-link").href = `${HF}/datasets/${S.dataset}`;
  $("#ds-link").textContent = S.dataset;
  const diffs = [...new Set(tasks.tasks.map((t) => t.difficulty).filter(Boolean))];
  const order = ["very_easy", "easier", "easy", "medium", "hard", "very_hard"];
  diffs.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  $("#mx-diff").innerHTML += diffs.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join("");
  $("#fr-family").innerHTML += [...new Set(tasks.tasks.map((t) => t.family))].map((f) => `<option value="${esc(f)}">${esc(tasks.tasks.find((t) => t.family === f).family_name)}</option>`).join("");
  wire();
  render();
  renderFrames();
  if (OFFLINE) { $("#live-status").innerHTML = `<span class="dot"></span>离线模式：只显示 data/digest.json`; return; }
  refreshLive();
  setInterval(() => { reloadDigest().then(refreshLive); }, LIVE_EVERY_MS);
}

start().catch((e) => {
  $("#live-status").innerHTML = `<span class="dot err"></span>页面数据读取失败：${esc(e.message)}`;
});
