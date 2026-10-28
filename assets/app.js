// RoboARC run dashboard. Static data (data/*.json) plus a live listing of the Hugging Face dataset on every load.
// No framework, no build step.

const HF = "https://huggingface.co";
const DEFAULT_DATASET = "RoboARC/RoboARC-outputs";
const LIVE_EVERY_MS = 5 * 60 * 1000;
const OFFLINE = new URLSearchParams(location.search).has("offline");   // ?offline: data/digest.json only, no live listing
const MODES = ["privileged", "standard"];
const MODE_LABEL = { privileged: "privileged", standard: "standard" };
const STATUS_LABEL = { ok: "success", fail: "fail", void: "not a result", wait: "awaiting digest", empty: "not run" };

const S = {
  tasks: null, targets: [], digest: { bundles: [], trials: [] }, frames: {}, helpers: {}, shareBlocks: [],
  dataset: DEFAULT_DATASET,
  live: { bundles: [], trials: [], listed: null, error: null, at: null, info: null },
  details: {},          // bundle key -> detail file (lazy)
  model: null,          // derived: slots, progress, ...
};

// ---------- helpers ----------

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtInt = (n) => (n == null ? "–" : Number(n).toLocaleString("en-US"));
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "–");
const minuteStamp = () => Math.floor(Date.now() / 60000);

function rel(iso) {
  if (!iso) return "–";
  const t = new Date(String(iso).replace(" ", "T")).getTime();
  if (Number.isNaN(t)) return esc(iso);
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
function abs(iso) {
  if (!iso) return "";
  const d = new Date(String(iso).replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString("en-US", { hour12: false });
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
  return `<div class="bar" role="img" aria-label="success ${p.ok}, fail ${p.fail}, not a result ${p.void}, awaiting digest ${p.wait}, of ${total}">
    <div class="seg ok" style="width:${w(p.ok)}"></div><div class="seg fail" style="width:${w(p.fail)}"></div>
    <div class="seg void" style="width:${w(p.void)}"></div><div class="seg wait" style="width:${w(p.wait)}"></div></div>`;
}

function renderCards() {
  const { pairs } = S.model;
  $("#cards").innerHTML = S.targets.map((t) => {
    const p = pairs[t.id];
    const counted = p.ok + p.fail;
    const tags = [t.via ? `<span class="tag">${esc(t.via)}</span>` : "", t.tentative ? `<span class="tag warn">tentative</span>` : ""].join("");
    const modes = MODES.map((m) => {
      const q = p.modes[m];
      return `<span>${MODE_LABEL[m]}</span>${bar(q, q.total)}<span class="mono">${q.ok + q.fail}/${q.total}</span>`;
    }).join("");
    const foot = p.runIds.size
      ? `<span>run id: ${[...p.runIds].map((r) => `<code>${esc(r)}</code>`).join(", ")}</span><span>helper: ${esc([...p.helpers].join(", "))}</span><span>last delivery ${when(p.last)}</span>`
      : `<span>no delivery yet</span>`;
    const unknown = p.unknownBases.size ? `<span class="tag bad" title="${esc([...p.unknownBases].join(", "))}">${p.unknownBases.size} bases not in ${esc(S.tasks.release)}</span>` : "";
    return `<article class="panel card" aria-label="${esc(t.harness)} + ${esc(t.model)}">
      <div class="card-top"><div><div class="harness">${esc(t.harness)}</div><div class="model">${esc(t.model)}</div></div><div class="chips">${tags}${unknown}</div></div>
      <div class="count"><span class="n">${counted}</span><span class="d">/ ${p.total} trials with a result</span></div>
      ${bar(p, p.total)}
      <div class="stats">
        <div class="stat" title="success ÷ (success + fail), over the trials with a result"><span class="k">Success rate</span><span class="v">${pct(p.ok, counted)}</span></div>
        <div class="stat"><span class="k">Success / fail</span><span class="v">${p.ok} / ${p.fail}</span></div>
        <div class="stat" title="trials that are not a result; rerun them with the same seed"><span class="k">To rerun</span><span class="v">${p.void}</span></div>
        <div class="stat"><span class="k">Awaiting / not run</span><span class="v">${p.wait} / ${p.empty}</span></div>
      </div>
      <div class="modes">${modes}</div>
      <div class="card-foot">${foot}</div>
    </article>`;
  }).join("");

  const others = Object.values(pairs).filter((p) => p.id.startsWith("other:"));
  $("#other-runs").innerHTML = others.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Runs outside the six pairs (run id)</th><th>Helper</th><th>With a result</th><th>Success / fail</th><th>Not a result</th><th>Last delivery</th></tr></thead>
    <tbody>${others.map((p) => `<tr><td><code>${esc(p.id.slice(6))}</code></td><td>${esc([...p.helpers].join(", "))}</td>
      <td class="mono">${p.ok + p.fail} / ${p.total}</td><td class="mono">${p.ok} / ${p.fail}</td><td class="mono">${p.void}</td><td>${when(p.last)}</td></tr>`).join("")}</tbody></table></div>` : "";
}

// The daily progress text: "<name>" then one "<harness> + <model>: <trials with a result>/<total>" line per pair.
function renderShare() {
  const { eff, bmap, pairs, trials, K } = S.model;
  const total = S.tasks.tasks.length * MODES.length * K;
  const bases = new Set(S.tasks.tasks.map((t) => t.base));
  const label = (t) => `${t.harness} + ${t.short || t.model}`;
  const delivered = {};   // helper -> pairs it delivered trials for
  for (const t of trials) {
    const h = bmap[t.bundle]?.helper;
    if (h && !t.pair.startsWith("other:")) (delivered[h] ||= new Set()).add(t.pair);
  }
  const counted = {};     // helper -> pair -> slots whose counted result it delivered
  for (const [key, e] of Object.entries(eff)) {
    const [pair, base] = key.split("|");
    const h = bmap[e.final.bundle]?.helper;
    if (!h || pair.startsWith("other:") || !bases.has(base) || (e.final.status !== "ok" && e.final.status !== "fail")) continue;
    (counted[h] ||= {})[pair] = (counted[h][pair] || 0) + 1;
  }
  const blocks = Object.keys(delivered).sort().map((h) => {
    const name = S.helpers[h] || h;
    return { title: name, text: [name, ...S.targets.filter((t) => delivered[h].has(t.id)).map((t) => `${label(t)}: ${counted[h]?.[t.id] || 0}/${total}`)].join("\n") };
  });
  blocks.push({ title: "All helpers", text: ["All helpers", ...S.targets.map((t) => `${label(t)}: ${pairs[t.id].ok + pairs[t.id].fail}/${total}`)].join("\n") });
  S.shareBlocks = blocks;
  $("#share").innerHTML = blocks.map((b, i) => `<div class="panel share-block"><div class="share-head"><span>${esc(b.title)}</span>
    <button class="btn" type="button" data-copy="${i}">Copy</button></div><pre class="share-text" id="share-${i}">${esc(b.text)}</pre></div>`).join("");
}

async function copyShare(btn) {
  const i = +btn.dataset.copy;
  try {
    await navigator.clipboard.writeText(S.shareBlocks[i].text);
    btn.textContent = "Copied";
  } catch {
    const range = document.createRange();   // the clipboard was refused: select the text for Ctrl+C
    range.selectNodeContents($(`#share-${i}`));
    getSelection().removeAllRanges(); getSelection().addRange(range);
    btn.textContent = "Selected: press Ctrl+C";
  }
  setTimeout(() => { btn.textContent = "Copy"; }, 2000);
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
  return major >= 580 ? `<span class="tag good">driver ≥ 580</span>` : `<span class="tag bad">driver below 580 (the 2.x cloth tasks need ≥ 580)</span>`;
}

function renderHosts() {
  const groups = latestByHelper();
  const names = Object.keys(groups);
  if (!names.length) {
    $("#hosts").innerHTML = `<div class="panel empty-state"><b>No delivery yet, so the GPU model and the way the runs are set up are still unknown.</b>
      <span>After the first delivery this shows its MANIFEST.md: GPU model, count and driver; CPU model, cores and memory; docker, Harbor and image versions; the runner's agent, model, effort, modes, web search and usage gateway; and, from the batch log, the number of parallel runners and the concurrency.</span></div>`;
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
      <div class="host-head"><h3>${esc(h)}</h3><span class="small muted">latest delivery ${when(b.uploaded_at)}: <code>${esc(b.batch)}/${esc(b.bundle)}</code>${b.pending ? " (awaiting digest)" : ""}</span></div>
      <div class="gpu-line">${gpuNames.length ? gpuNames.map(([n, c]) => `<span class="gpu">${c} × ${esc(n)}</span>`).join("") : `<span class="muted">no GPU line in MANIFEST.md</span>`}
        ${gpus[0] ? `<span class="chip">driver ${esc(gpus[0].driver)}</span>${driverTag(gpus[0].driver)}` : ""}</div>
      <div class="two">
        <dl class="kv">
          <dt>CPU</dt><dd>${m.host ? `${esc(m.host.cpu_model)}, ${m.host.cpus} CPUs` : "–"}</dd>
          <dt>Memory</dt><dd>${m.host ? `${m.host.ram_gb} GB` : "–"}</dd>
          <dt>Software</dt><dd>${esc(raw.software || "–")}</dd>
          <dt>Code</dt><dd class="mono">${esc(raw.repo || "–")}</dd>
          <dt>Images</dt><dd class="mono small">${esc(raw.images || "–").replace(/\n/g, "<br>")}</dd>
        </dl>
        <dl class="kv">
          <dt>Harness</dt><dd>${esc(r.agent || "–")}</dd>
          <dt>Model</dt><dd>${esc(r.model || "–")}</dd>
          <dt>Effort</dt><dd>${esc(r.effort || "–")}</dd>
          <dt>Run id</dt><dd class="mono">${esc(b.run_id || r.run_id || "–")}</dd>
          <dt>Modes</dt><dd>${esc((r.modes || []).join(" + ") || "–")}</dd>
          <dt>Web search</dt><dd>${esc(r.web_search || "–")}</dd>
          <dt>Usage gateway</dt><dd>${esc(r.usage_gateway || "–")}</dd>
          <dt>Parallelism</dt><dd>${log.lanes ? `${log.lanes} runner(s), concurrency ${log.concurrency_max ?? "–"} per Harbor job` : (b.pending ? "awaiting digest" : "–")}</dd>
          <dt>Trials per task</dt><dd>${m.K ? `K = ${m.K}` : "–"}</dd>
          <dt>This batch</dt><dd>${m.trials ? `${esc(m.trials.planned_jobs)} jobs planned, ${esc(m.trials.trial_dirs)} trial dirs, ${esc(m.trials.with_verdict)} with a verdict` : "–"}</dd>
        </dl>
      </div>
      ${raw.notes && raw.notes !== "none" ? `<div class="small"><b>Helper's notes: </b>${esc(raw.notes)}</div>` : ""}
      ${machines.size > 1 ? `<div class="small muted">This helper used ${machines.size} machines: ${[...machines].map(esc).join("; ")}</div>` : ""}
    </article>`;
  }).join("");
}

function machineClass(task) { return task.material === "rigid" ? "shared" : "exclusive"; }

function renderMachines() {
  const SPEC = {
    shared: { title: "Rigid tasks", rule: "4 trials share one GPU; each trial gets at least 2 CPU cores + 4 GB memory" },
    exclusive: { title: "Deformable tasks (rope, cloth, cable, fiber)", rule: "each trial has a GPU to itself; each trial gets at least 4 CPU cores + 8 GB memory" },
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
        <dt>Bases</dt><dd>${tasks.length}, ${tasks.length * MODES.length * K} trials per pair</dd>
        <dt>Families</dt><dd><div class="chips">${fams.map((f) => `<span class="chip">${esc(f)}</span>`).join("")}</div></dd>
        <dt>task.toml caps</dt><dd><div class="chips">${caps}</div><div class="small faint">Upper limits for the container (throttled or killed above them), not reservations.</div></dd>
        <dt>Measured peaks</dt><dd>${measured ? `memory up to ${pm?.toFixed(1)} GB, GPU memory up to ${pg?.toFixed(1) ?? "–"} GB (${measured} trials recorded)${ooms ? `; <span class="tag bad">${ooms} OOM or emergency kills</span>` : ""}` : `<span class="faint">no digested trials yet</span>`}</dd>
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
    $("#bundles").innerHTML = `<div class="panel empty-state"><b>No deliveries in the dataset yet.</b><span>The dataset <a href="${HF}/datasets/${esc(S.dataset)}" target="_blank" rel="noopener">${esc(S.dataset)}</a> ${S.live.info ? `holds ${S.live.info.siblings?.length ?? 0} file(s), last updated ${when(S.live.info.lastModified)}` : "could not be read yet"}. A delivery (a direct commit or a pull request) shows up here at the next refresh.</span></div>`;
    return;
  }
  const counts = (key) => {
    const ts = S.model.trials.filter((t) => t.bundle === key);
    const c = { ok: 0, fail: 0, void: 0, wait: 0 };
    ts.forEach((t) => c[t.status]++);
    return c;
  };
  $("#bundles").innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Delivered</th><th>Helper</th><th>batch / bundle</th><th>Source</th><th>Pair</th><th>Trials</th><th>Success / fail / void / awaiting</th><th>State</th></tr></thead>
    <tbody>${bs.map((b) => {
      const c = counts(b.key);
      const pair = pairOf(b, null);
      const state = b.gone ? `<span class="pill fail">removed from the dataset</span>` : b.pending ? `<span class="pill wait">awaiting digest</span>`
        : b.errors?.length ? `<span class="pill void" title="${esc(b.errors.join("\n"))}">digest problems</span>` : `<span class="pill ok">digested</span>`;
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
  sel.innerHTML = `<option value="all">All</option>` + pairsSeen.map((p) => `<option value="${esc(p)}">${esc(pairLabel(p))}</option>`).join("");
  sel.value = pairsSeen.includes(keep) ? keep : "all";
  const kind = $("#err-kind").value;
  const TODO = ["void", "no_verdict", "exception"];
  const match = (r) => kind === "all" || (kind === "todo" ? r.kinds.some((k) => TODO.includes(k)) : r.kinds.includes(kind));
  const shown = rows.filter((r) => (sel.value === "all" || r.t.pair === sel.value) && match(r));

  const why = (t) => t.reason || (t.exception_type !== "AgentTimeoutError" && t.exception_type) || (t.result === "no_verdict" ? "no verdict (the grader did not finish)" : "")
    || (t.status === "wait" ? "awaiting digest" : "") || "rerun";
  const tally = {};
  shown.forEach((r) => { const k = why(r.t); tally[k] = (tally[k] || 0) + 1; });
  $("#error-kinds").innerHTML = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 14)
    .map(([k, n]) => `<span class="chip" title="${esc(k)}">${esc(k.length > 70 ? k.slice(0, 70) + "…" : k)} · ${n}</span>`).join("");

  if (!rows.length) {
    $("#error-table").innerHTML = `<div class="panel empty-state"><b>No failed or rerun trials yet.</b><span>Once deliveries arrive, this lists trials that are not a result (an API disconnect, a container that never started, a grader error: the protocol reruns them once with the same seed), trials without a verdict, trials with a Harbor exception, and trials run more than once.</span></div>`;
    return;
  }
  if (!shown.length) { $("#error-table").innerHTML = `<div class="panel empty-state"><span>No trial matches this filter (${rows.length} records in all).</span></div>`; return; }
  $("#error-table").innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Time</th><th>Pair</th><th>Base</th><th>Mode</th><th>Trial / seed</th><th>Result</th><th>Reason / exception</th><th>Peak memory</th><th>Batch</th></tr></thead>
    <tbody>${shown.slice(0, 400).map(({ t, kinds }) => `<tr class="clickable" data-trial="${esc(t.bundle)}|${esc(t.job)}|${esc(t.trial_dir)}" tabindex="0">
      <td class="nowrap">${when(t.when)}</td><td>${esc(pairLabel(t.pair))}</td><td class="mono">${esc(t.base || "?")}</td><td>${esc(t.mode || "?")}</td>
      <td class="mono">${t.k ?? "?"} / ${t.seed ?? "?"}</td><td><span class="pill ${t.status}">${STATUS_LABEL[t.status]}</span>${kinds.includes("rerun") ? ` <span class="tag">rerun</span>` : ""}</td>
      <td>${esc(why(t))}</td><td class="mono">${typeof t.peak_memory_gb === "number" ? t.peak_memory_gb.toFixed(1) + " GB" : "–"}</td>
      <td class="mono small nowrap">${esc(S.model.bmap[t.bundle]?.batch || "")}</td></tr>`).join("")}</tbody></table></div>
    ${shown.length > 400 ? `<p class="small muted">Showing the latest 400 of ${shown.length}.</p>` : ""}`;
}

function renderMatrix() {
  const mat = $("#mx-material").value, diff = $("#mx-diff").value, q = $("#mx-search").value.trim().toLowerCase();
  const onlyIncomplete = $("#mx-incomplete").checked;
  const K = S.model.K;
  const cols = S.targets;
  const head = `<div class="mrow head" style="--cols:${cols.length}"><div>Base</div>${cols.map((t) => `<div title="${esc(t.harness)} + ${esc(t.model)}">${esc(t.harness)}<br>${esc(t.model)}</div>`).join("")}</div>`;
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
            const tip = `${task.base} · ${c.harness} + ${c.model}\n${m} trial ${i + 1} (seed ${seed}): ${STATUS_LABEL[st]}${e && e.attempts.length > 1 ? `, ${e.attempts.length} attempts` : ""}${e?.final.reason ? `\n${e.final.reason}` : ""}`;
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
    if (catHtml) html += `<div class="mrow group"><div>${cat.material === "rigid" ? "Rigid" : "Deformable"} · ${esc(cat.name)}</div></div>${catHtml}`;
  }
  $("#matrix-grid").innerHTML = html;
}

function renderFrames() {
  const fam = $("#fr-family").value;
  const byFam = {};
  for (const t of S.tasks.tasks) if (fam === "all" || t.family === fam) (byFam[t.family] ||= []).push(t);
  const nFrames = Object.values(S.frames).reduce((a, x) => a + Object.keys(x).length, 0);
  $("#frame-list").innerHTML = (nFrames ? "" : `<div class="panel empty-state"><b>First frames are not rendered yet.</b><span>One cam_high birth frame per base and allowed seed, ${S.tasks.tasks.reduce((a, t) => a + t.seeds.length, 0)} in all; renders go into <code>frames/</code> and are listed in <code>data/frames.json</code>.</span></div>`) +
    Object.entries(byFam).map(([f, tasks]) => `<div class="frame-fam"><h3>${esc(tasks[0].family_name)} <span class="small muted">${tasks[0].material === "rigid" ? "rigid" : "deformable"} · ${tasks.length} bases</span></h3>
      <div class="frame-grid">${tasks.map((t) => `<div class="panel frame-task"><div class="t"><span>${esc(t.base.replace(/^roboarc-/, ""))}</span><span class="faint">${esc(t.difficulty)}</span></div>
        <div class="seeds">${[0, 1, 2].map((s) => {
          const src = S.frames[t.base]?.[String(s)];
          const allowed = t.seeds.includes(s);
          const body = !allowed ? `<div class="ph">seed 0 only</div>` : src ? `<img src="${esc(src)}" alt="${esc(t.base)} seed ${s} first frame" loading="lazy" width="848" height="480">` : `<div class="ph">not rendered</div>`;
          return `<div class="seed">${body}<div class="lbl">seed ${s}</div></div>`;
        }).join("")}</div></div>`).join("")}</div></div>`).join("");
}

function renderStatus() {
  const d = S.digest;
  const live = S.live;
  const nPending = live.bundles.length;
  $("#live-status").innerHTML = live.error
    ? `<span class="dot err"></span>Could not read Hugging Face: ${esc(live.error)} (showing the last digest)`
    : live.at
      ? `<span class="dot live"></span>Hugging Face: dataset updated <b>${when(live.info?.lastModified)}</b>, ${live.listed?.length ?? 0} deliveries${nPending ? `, ${nPending} awaiting digest` : ""}; read ${when(live.at)}`
      : `<span class="dot"></span>Reading Hugging Face…`;
  $("#digest-status").innerHTML = d.generated_at ? `logs digested ${when(d.generated_at)}` : "logs not digested yet";
  $("#release").textContent = `RoboARC ${S.tasks.release} · ${S.tasks.tasks.length} bases`;
  $("#foot-release").innerHTML = `Task list from tasks/ of RoboARC ${esc(S.tasks.release)} (<code>${esc(S.tasks.commit)}</code>); the pairs are in <code>data/targets.json</code>.`;
}

function render() {
  if (!S.tasks) return;
  buildModel();
  if (!OFFLINE) renderStatus(); else { $("#digest-status").innerHTML = S.digest.generated_at ? `logs digested ${when(S.digest.generated_at)}` : ""; $("#release").textContent = `RoboARC ${S.tasks.release} · ${S.tasks.tasks.length} bases`; }
  renderCards();
  renderShare();
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
      <header><div><h3 id="drawer-title">${title}</h3><div class="small muted">${sub}</div></div><button class="btn" type="button" data-close>Close</button></header>
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
    `${esc(b.helper)} · ${esc(b.source)} · delivered ${esc(abs(b.uploaded_at))}${b.url ? ` · <a href="${esc(b.url)}" target="_blank" rel="noopener">open on Hugging Face</a>` : ""}`, `<p class="muted">Loading…</p>`);
  const d = await bundleDetail(b);
  const raw = b.manifest_fields || {};
  let html = "";
  if (b.errors?.length) html += `<div><h4>Digest problems</h4>${pre(b.errors)}</div>`;
  html += `<div><h4>Run settings</h4><dl class="kv">
    <dt>Pair</dt><dd>${esc(pairLabel(pairOf(b, null)))}</dd><dt>Run id</dt><dd class="mono">${esc(b.run_id || "–")}</dd>
    <dt>Trials</dt><dd>${b.trials} (${b.jobs} jobs)</dd>
    ${b.log ? `<dt>Batch log</dt><dd>${esc(b.log.first || "")} → ${esc(b.log.last || "")}, ${b.log.lanes} runner(s), concurrency ${b.log.concurrency_max ?? "–"}</dd>` : ""}
    ${Object.entries(raw).filter(([k]) => ["notes", "mirror", "results"].includes(k)).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}
  </dl></div>`;
  if (d?.manifest_text) html += `<div><h4>MANIFEST.md</h4>${pre(d.manifest_text)}</div>`;
  else if (b.pending) html += `<div><h4>MANIFEST.md</h4>${pre(Object.entries(raw).map(([k, v]) => `${k}: ${v}`).join("\n"))}</div>`;
  if (d?.log_notable?.length) html += `<div><h4>Error and rerun lines of the batch log</h4>${pre(d.log_notable)}</div>`;
  if (d?.summary_md) html += `<details><summary class="small">Batch summary (${esc(b.batch)}.summary.md)</summary>${pre(d.summary_md)}</details>`;
  if (b.pending) html += `<p class="small muted">This delivery is not digested yet; the next digest adds the official results, the exceptions and the resource peaks.</p>`;
  body.innerHTML = html;
}

async function openTrial(ref) {
  const [bkey, job, trialDir] = ref.split("|");
  const t = S.model.trials.find((x) => x.bundle === bkey && x.job === job && x.trial_dir === trialDir);
  const b = S.model.bmap[bkey];
  if (!t || !b) return;
  const slot = S.model.eff[`${t.pair}|${t.base}|${t.mode}|${t.k}`];
  const body = openDrawer(`${esc(t.base || "?")} <span class="faint">· ${esc(t.mode || "?")} trial ${t.k ?? "?"}</span>`,
    `${esc(pairLabel(t.pair))} · seed ${t.seed ?? "?"} · <code>${esc(t.trial_dir)}</code>`, `<p class="muted">Loading…</p>`);
  const d = (await bundleDetail(b))?.trials?.[`${job}/${trialDir}`];
  const kv = [
    ["Result", `<span class="pill ${t.status}">${STATUS_LABEL[t.status]}</span>${t.result_source === "index" ? " <span class=\"small muted\">(from index.json only)</span>" : ""}`],
    ["Reason", esc(t.reason || "–")], ["Reward", esc(t.reward ?? "–")], ["Harbor exception", esc(t.exception_type || (t.exception ? "yes (awaiting digest)" : "none"))],
    ["Wall time", t.wall_s != null ? `${Math.round(t.wall_s / 60)} min` : "–"], ["Tokens (in / out)", `${fmtInt(t.tokens_in)} / ${fmtInt(t.tokens_out)}`],
    ["Cost", t.cost_usd != null ? `$${Number(t.cost_usd).toFixed(2)}` : "–"],
    ["Peak memory / GPU memory", `${typeof t.peak_memory_gb === "number" ? t.peak_memory_gb.toFixed(2) : "–"} GB / ${typeof t.peak_gpu_memory_gb === "number" ? t.peak_gpu_memory_gb.toFixed(2) : "–"} GB`],
    ["OOM or emergency kills", esc(t.oom_kills ?? "–")], ["Harbor exit code", esc(t.harbor_rc ?? "–")],
    ["Attempts", slot ? `${slot.attempts.length}${t.attempts_over_cap ? " (over the cap)" : ""}` : "–"],
  ];
  let html = `<dl class="kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
  if (slot && slot.attempts.length > 1) {
    html += `<div><h4>All attempts of this trial</h4><div class="table-wrap"><table><thead><tr><th>Time</th><th>Result</th><th>Reason</th><th>Batch</th></tr></thead><tbody>${slot.attempts.map((a) =>
      `<tr><td class="nowrap">${esc(abs(a.when))}</td><td><span class="pill ${a.status}">${STATUS_LABEL[a.status]}</span></td><td>${esc(a.reason || a.exception_type || "")}</td><td class="mono small">${esc(S.model.bmap[a.bundle]?.batch || "")}</td></tr>`).join("")}</tbody></table></div></div>`;
  }
  if (d) {
    if (d.exception_message) html += `<div><h4>Exception (result.json)</h4>${pre(d.exception_message)}</div>`;
    if (d.exception_tail) html += `<div><h4>End of exception.txt</h4>${pre(d.exception_tail)}</div>`;
    if (d.grade_tail && d.grade_tail.join("").trim()) html += `<div><h4>End of the grader log, verifier/grade.log</h4>${pre(d.grade_tail)}</div>`;
    if (d.trial_tail) html += `<div><h4>End of trial.log</h4>${pre(d.trial_tail)}</div>`;
    if (d.reward) html += `<details><summary class="small">Grader fields, verifier/reward.json</summary>${jsonPre(d.reward)}</details>`;
    if (d.resource_limits) html += `<details><summary class="small">Resource limits, verifier/resource_limits.json</summary>${jsonPre(d.resource_limits)}</details>`;
    if (d.gateway_totals) html += `<details><summary class="small">Usage gateway, gateway/totals.json</summary>${jsonPre(d.gateway_totals)}</details>`;
  }
  const archUrl = b.revision === "local" ? null : hfResolve(b.revision, t.archive);
  html += `<div><h4>Full logs</h4><p class="small muted">Downloads this trial's job archive (<code>${esc(t.archive.split("/").pop())}</code>) from Hugging Face and unpacks it in the browser: the end of exception.txt, trial.log, the grader log and the agent logs.</p>
    <div class="chips" style="margin-top:6px">${archUrl ? `<button class="btn" type="button" id="load-archive">Read here</button><a class="btn" href="${esc(archUrl)}" target="_blank" rel="noopener">Download .tar.gz</a>` : "<span class=\"faint\">local test data: no download link</span>"}</div>
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
  outEl.innerHTML = `<p class="small muted">Downloading and unpacking…</p>`;
  const MAX = 50 << 20;
  const marker = `/${job}/${trialDir}/`;
  const keep = (rel) => ["exception.txt", "trial.log", "result.json", "verifier/grade.log", "verifier/reward.json", "verifier/verdict.json"].includes(rel)
    || /^agent\/[^/]+\.(txt|log)$/.test(rel) || /^agent\/setup\/[^/]+\.(txt|log)$/.test(rel);
  try {
    const files = await untarGz(url, (name, size) => size <= MAX && name.includes(marker) && keep(name.split(marker)[1]),
      (n) => { outEl.firstElementChild.textContent = `Downloading and unpacking… ${(n / 1048576).toFixed(1)} MB unpacked`; });
    const names = Object.keys(files).sort();
    if (!names.length) { outEl.innerHTML = `<p class="small muted">No log file of this trial in the archive.</p>`; return; }
    const dec = new TextDecoder();
    const view = (n) => { const lines = dec.decode(files[n]).split("\n"); return (lines.length > 400 ? [`… (${lines.length - 400} earlier lines left out)`, ...lines.slice(-400)] : lines).join("\n"); };
    outEl.innerHTML = `<div class="tabs" role="tablist">${names.map((n, i) => `<button type="button" role="tab" aria-selected="${i === 0}" data-file="${esc(n)}">${esc(n.split(marker)[1])}</button>`).join("")}</div><pre class="log" id="archive-view"></pre>`;
    const show = (n) => { $("#archive-view").textContent = view(n); outEl.querySelectorAll("[role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.file === n))); };
    outEl.querySelectorAll("[role=tab]").forEach((b) => b.addEventListener("click", () => show(b.dataset.file)));
    show(names[0]);
  } catch (e) {
    outEl.innerHTML = `<p class="small" style="color:var(--fail)">Could not read it: ${esc(e.message)}. Use "Download .tar.gz" to open it yourself.</p>`;
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
    const cp = e.target.closest("[data-copy]");
    if (cp) return copyShare(cp);
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
  const [tasks, targets, frames, helpers] = await Promise.all([
    getJSON(`data/tasks.json?v=${minuteStamp()}`), getJSON(`data/targets.json?v=${minuteStamp()}`),
    getJSON(`data/frames.json?v=${minuteStamp()}`, { optional: true }).catch(() => null),
    getJSON(`data/helpers.json?v=${minuteStamp()}`, { optional: true }).catch(() => null),
  ]);
  S.tasks = tasks; S.targets = targets.targets; S.frames = frames?.frames || {}; S.helpers = helpers?.names || {};
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
  if (OFFLINE) { $("#live-status").innerHTML = `<span class="dot"></span>Offline mode: data/digest.json only`; return; }
  refreshLive();
  setInterval(() => { reloadDigest().then(refreshLive); }, LIVE_EVERY_MS);
}

start().catch((e) => {
  $("#live-status").innerHTML = `<span class="dot err"></span>Could not load the page data: ${esc(e.message)}`;
});
