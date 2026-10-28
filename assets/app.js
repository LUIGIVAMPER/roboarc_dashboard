// RoboARC run dashboard. Static data (data/*.json) plus a live listing of the Hugging Face dataset on every load.
// No framework, no build step.

import {
  HF, DEFAULT_DATASET, STATUS_LABEL, $, esc, pct, median, fmtDur, fmtDays, fmtDate, minuteStamp, abs, when,
  getJSON, getText, encRev, encPath, hfResolveIn, hfBlobIn, statusOf, timelineHref, parseManifest, trialsFromIndex, readLoose,
} from "./common.js";

const LIVE_EVERY_MS = 5 * 60 * 1000;
const OFFLINE = new URLSearchParams(location.search).has("offline");   // ?offline: data/digest.json only, no live listing
const MODES = ["privileged", "standard"];
const MODE_LABEL = { privileged: "privileged", standard: "standard" };

const S = {
  tasks: null, targets: [], digest: { bundles: [], trials: [] }, frames: {}, helpers: {}, shareBlocks: [],
  dataset: DEFAULT_DATASET,
  live: { bundles: [], trials: [], listed: null, error: null, at: null, info: null },
  details: {},          // bundle key -> detail file (lazy)
  model: null,          // derived: slots, progress, ...
};

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}
const hfResolve = (rev, path) => hfResolveIn(S.dataset, rev, path);
const hfBlob = (rev, path) => hfBlobIn(S.dataset, rev, path);

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
      let runId = idx.run_id || man.parsed.runner?.run_id || null;
      let ts = trialsFromIndex(idx, b.key, b.path, runId), loose = null;
      if (err.length === 2) {   // no MANIFEST.md and no index.json: the runner's folders as loose files?
        loose = await readLoose(S.dataset, b.rev, b.path, b.key).catch(() => null);
        if (loose) { man = loose.man; runId = loose.runId; ts = loose.trials; err = []; }
      }
      trials.push(...ts);
      return {
        key: b.key, helper, batch, bundle, path: b.path, revision: b.rev, source: b.label, uploaded_at: b.uploaded_at,
        url: hfBlob(b.rev, b.path), run_id: runId, manifest: man.parsed, manifest_fields: man.raw, manifest_raw: man.raw,
        jobs: loose ? new Set(ts.map((t) => t.job)).size : (idx.jobs || []).length, trials: ts.length, errors: err, pending: true,
        hardware_source: loose ? loose.hardware : man.parsed.host || man.parsed.gpus?.length ? "MANIFEST.md" : null,
        ...(loose ? { layout: "loose", batches: loose.batches, official: loose.official, redaction: loose.redaction } : {}),
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

function buildModel() {
  const listed = S.live.listed ? new Set(S.live.listed) : null;
  const digestB = S.digest.bundles.map((b) => ({ ...b, pending: false, gone: listed ? !listed.has(b.key) : false }));
  const bundles = [...S.live.bundles, ...digestB].sort((a, b) => String(b.uploaded_at || "").localeCompare(String(a.uploaded_at || "")));
  const bmap = Object.fromEntries(bundles.map((b) => [b.key, b]));
  // a delivery its helper marked unofficial (REDACTION.json "official": false) is shown, but kept out of the progress
  const trials = [...S.digest.trials, ...S.live.trials].filter((t) => !bmap[t.bundle]?.gone).map((t) => {
    const b = bmap[t.bundle];
    return { ...t, pair: pairOf(b, t), status: statusOf(t), when: t.finished_at || b?.uploaded_at || "", unofficial: b?.official === false };
  });
  const counted = trials.filter((t) => !t.unofficial);
  const baseSet = new Set(S.tasks.tasks.map((x) => x.base));
  const K = S.tasks.trials_per_task_mode;

  // slot -> attempts (time order); a trial without a trial number takes the first free number of its task and mode
  const slots = {};
  const byTM = {};
  for (const t of counted.sort((a, b) => String(a.when).localeCompare(String(b.when)))) {
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

  // run time: each trial's wall time (Harbor's started_at -> finished_at), and the time left at the current pace
  const famOf = Object.fromEntries(S.tasks.tasks.map((t) => [t.base, t.family]));
  const timed = counted.filter((t) => typeof t.wall_s === "number" && t.started_at && t.finished_at);
  const durs = { pb: {}, b: {}, f: {}, p: {}, all: [] };   // wall times of trials with a result, by pair+base, base, family, pair
  for (const t of timed) {
    if (t.status !== "ok" && t.status !== "fail") continue;
    (durs.pb[`${t.pair}|${t.base}`] ||= []).push(t.wall_s);
    (durs.b[t.base] ||= []).push(t.wall_s);
    (durs.f[famOf[t.base]] ||= []).push(t.wall_s);
    (durs.p[t.pair] ||= []).push(t.wall_s);
    durs.all.push(t.wall_s);
  }
  const memo = new Map();
  const med = (key, xs) => { if (!memo.has(key)) memo.set(key, median(xs)); return memo.get(key); };
  const expected = (pair, base) => med(`pb|${pair}|${base}`, durs.pb[`${pair}|${base}`]) ?? med(`b|${base}`, durs.b[base])
    ?? med(`f|${famOf[base]}`, durs.f[famOf[base]]) ?? med(`p|${pair}`, durs.p[pair]) ?? med("all", durs.all);
  // pace of a set of trials: busy time (sum of wall times) over the span from the first start to the last end
  const pace = (ts) => {
    if (!ts.length) return null;
    const a = Math.min(...ts.map((t) => Date.parse(t.started_at))), b = Math.max(...ts.map((t) => Date.parse(t.finished_at)));
    const busy = ts.reduce((x, t) => x + t.wall_s, 0), span = (b - a) / 1000;
    return span > 0 ? { busy, span, par: busy / span } : null;
  };
  // the expected time left for a pair's slots without a result (not run, or not a result and to be rerun)
  const workLeft = (id) => {
    let work = 0;
    for (const task of S.tasks.tasks) for (const m of MODES) for (let k = 1; k <= K; k++) {
      const st = eff[`${id}|${task.base}|${m}|${k}`]?.final.status || "empty";
      if (st !== "empty" && st !== "void") continue;
      const e = expected(id, task.base);
      if (e == null) return null;
      work += e;
    }
    return work;
  };
  const estimate = (pc, work, counted) => (pc ? {
    span: pc.span, par: pc.par, perDay: counted / (pc.span / 86400),
    left: work == null ? null : work / pc.par, total: work == null ? null : pc.span + work / pc.par,
  } : null);

  const pairs = {};
  const pairIds = [...S.targets.map((t) => t.id), ...new Set(counted.map((t) => t.pair).filter((p) => p.startsWith("other:")))];
  for (const id of pairIds) {
    const p = { id, total: 0, ok: 0, fail: 0, void: 0, wait: 0, empty: 0, modes: {}, unknownBases: new Set(), runIds: new Set(), helpers: new Set(), last: null };
    for (const m of MODES) p.modes[m] = { total: 0, ok: 0, fail: 0, void: 0, wait: 0, empty: 0 };
    for (const task of S.tasks.tasks) for (const m of MODES) for (let k = 1; k <= K; k++) {
      const e = eff[`${id}|${task.base}|${m}|${k}`];
      const st = e ? e.final.status : "empty";
      p[st]++; p.total++; p.modes[m][st]++; p.modes[m].total++;
    }
    for (const t of counted.filter((x) => x.pair === id)) {
      if (t.base && !baseSet.has(t.base)) p.unknownBases.add(t.base);
      if (t.run_id) p.runIds.add(t.run_id);
      const b = bmap[t.bundle];
      if (b) { p.helpers.add(b.helper); if (!p.last || String(b.uploaded_at) > String(p.last)) p.last = b.uploaded_at; }
    }
    p.time = { median: median(durs.p[id]), est: estimate(pace(timed.filter((t) => t.pair === id)), workLeft(id), p.ok + p.fail) };
    pairs[id] = p;
  }
  // all six pairs together: their combined pace, and the work left over all of them
  const targetIds = S.targets.map((t) => t.id);
  const works = targetIds.map(workLeft);
  const countedAll = targetIds.reduce((a, id) => a + pairs[id].ok + pairs[id].fail, 0);
  const overall = {
    counted: countedAll, total: targetIds.length * S.tasks.tasks.length * MODES.length * K,
    est: estimate(pace(timed.filter((t) => targetIds.includes(t.pair))), works.includes(null) ? null : works.reduce((a, w) => a + w, 0), countedAll),
  };
  S.model = { bundles, bmap, trials, eff, pairs, K, durs, overall };
}

// ---------- rendering ----------

function bar(p, total) {
  const w = (n) => `${(100 * n) / total}%`;
  return `<div class="bar" role="img" aria-label="success ${p.ok}, fail ${p.fail}, not a result ${p.void}, awaiting digest ${p.wait}, of ${total}">
    <div class="seg ok" style="width:${w(p.ok)}"></div><div class="seg fail" style="width:${w(p.fail)}"></div>
    <div class="seg void" style="width:${w(p.void)}"></div><div class="seg wait" style="width:${w(p.wait)}"></div></div>`;
}

const EST_HELP = "estimated total = elapsed + work left / parallelism. Work left: the expected wall time of every trial without a result "
  + "(not run, or not a result and to be rerun): the median of the same pair and base, else of the base, the family, the pair, all trials. "
  + "Parallelism: the trials' summed wall time / elapsed. Elapsed: from the first trial's start to the last trial's end.";

function timeStats(tm) {
  const e = tm.est;
  return `<div class="stats time">
    <div class="stat" title="median wall time of a trial with a result (Harbor's started_at to finished_at)"><span class="k">Median trial</span><span class="v">${fmtDur(tm.median)}</span></div>
    <div class="stat" title="trials with a result per day of elapsed time"><span class="k">Pace</span><span class="v">${e ? `${e.perDay.toFixed(1)} / day` : "–"}</span></div>
    <div class="stat" title="from the first trial's start to the last trial's end"><span class="k">Elapsed</span><span class="v">${e ? fmtDays(e.span) : "–"}</span></div>
    <div class="stat" title="${esc(EST_HELP)}"><span class="k">Est. total</span><span class="v">${e?.total != null ? fmtDays(e.total) : "–"}</span></div>
  </div>
  <div class="eta small">${e?.left != null ? (e.left > 0 ? `About <b>${fmtDays(e.left)}</b> left at the current pace (${e.par.toFixed(1)} trials in parallel): done around <b>${fmtDate(Date.now() + e.left * 1000)}</b>.` : "All 540 trials have a result.")
    : `<span class="faint">No timed trial yet: the estimate starts with the first digested delivery.</span>`}</div>`;
}

function renderOverall() {
  const o = S.model.overall, e = o.est;
  $("#overall").innerHTML = `<div class="panel overall">
    <div><span class="k">All six pairs</span><span class="v"><b>${o.counted}</b> / ${o.total} trials with a result</span></div>
    <div><span class="k">Pace</span><span class="v">${e ? `${e.perDay.toFixed(1)} trials / day` : "–"}</span></div>
    <div><span class="k">Elapsed</span><span class="v">${e ? fmtDays(e.span) : "–"}</span></div>
    <div title="${esc(EST_HELP)}"><span class="k">Est. total (${o.total})</span><span class="v">${e?.total != null ? `${fmtDays(e.total)}, done around ${fmtDate(Date.now() + e.left * 1000)}` : "–"}</span></div>
  </div>`;
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
      ${timeStats(p.time)}
      <div class="card-foot">${foot}</div>
    </article>`;
  }).join("");

  const others = Object.values(pairs).filter((p) => p.id.startsWith("other:"));
  const unofficial = S.model.bundles.filter((b) => b.official === false && !b.gone);
  $("#other-runs").innerHTML = (others.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Runs outside the six pairs (run id)</th><th>Helper</th><th>With a result</th><th>Success / fail</th><th>Not a result</th><th>Last delivery</th></tr></thead>
    <tbody>${others.map((p) => `<tr><td><code>${esc(p.id.slice(6))}</code></td><td>${esc([...p.helpers].join(", "))}</td>
      <td class="mono">${p.ok + p.fail} / ${p.total}</td><td class="mono">${p.ok} / ${p.fail}</td><td class="mono">${p.void}</td><td>${when(p.last)}</td></tr>`).join("")}</tbody></table></div>` : "")
    + (unofficial.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Unofficial deliveries, not counted above</th><th>Helper</th><th>Pair</th><th>Trials</th><th>Success / fail / not a result / awaiting</th><th>Delivered</th><th>Why unofficial (the helper's REDACTION.json)</th></tr></thead>
    <tbody>${unofficial.map((b) => {
      const c = statusCounts(b.key);
      return `<tr class="clickable" data-bundle="${esc(b.key)}" tabindex="0"><td class="mono">${esc(b.batch)}<br><span class="faint">${esc(b.bundle)}</span></td><td>${esc(b.helper)}</td>
        <td>${esc(pairLabel(pairOf(b, null)))}</td><td class="mono">${b.trials}</td><td class="mono">${c.ok} / ${c.fail} / ${c.void} / ${c.wait}</td><td class="nowrap">${when(b.uploaded_at)}</td>
        <td class="small">${esc(b.redaction?.notice || "marked \"official\": false")}</td></tr>`;
    }).join("")}</tbody></table></div>` : "");
}

function statusCounts(key) {
  const c = { ok: 0, fail: 0, void: 0, wait: 0 };
  S.model.trials.filter((t) => t.bundle === key).forEach((t) => c[t.status]++);
  return c;
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
    if (h && !t.unofficial && !t.pair.startsWith("other:")) (delivered[h] ||= new Set()).add(t.pair);
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

// The latest delivery of each helper and run id (bundles are sorted newest first).
function latestByRun() {
  const out = {};
  for (const b of S.model.bundles) {
    const k = `${b.helper}|${b.run_id || "?"}`;
    if (!out[k]) out[k] = { latest: b, all: [] };
    out[k].all.push(b);
  }
  return out;
}

function driverTag(drv) {
  const major = parseInt(String(drv || "").split(".")[0], 10);
  if (!major) return "";
  return major >= 580 ? `<span class="tag good">driver ≥ 580</span>` : `<span class="tag bad">driver below 580 (the 2.x cloth tasks need ≥ 580)</span>`;
}

function renderHosts() {
  const groups = latestByRun();
  const names = Object.keys(groups);
  if (!names.length) {
    $("#hosts").innerHTML = `<div class="panel empty-state"><b>No delivery yet, so the run settings are still unknown.</b>
      <span>After the first delivery this shows its MANIFEST.md: the code commit and images, the runner's harness, model, effort, modes, web search and usage gateway, the trials per task, and from the batch log the number of parallel runners and the concurrency. The machines are under Hardware.</span></div>`;
    return;
  }
  $("#hosts").innerHTML = names.map((h) => {
    const { latest: b } = groups[h];
    const m = b.manifest || {};
    const raw = b.manifest_fields || {};
    const r = m.runner || {};
    const log = b.log || {};
    return `<article class="panel host">
      <div class="host-head"><h3>${esc(b.helper)} <span class="muted small">${esc(pairLabel(pairOf(b, null)))}</span></h3><span class="small muted">latest delivery ${when(b.uploaded_at)}: <code>${esc(b.batch)}/${esc(b.bundle)}</code>${b.pending ? " (awaiting digest)" : ""}${deliveryTags(b)}</span></div>
      <div class="two">
        <dl class="kv">
          <dt>Harness</dt><dd>${esc(r.agent || "–")}</dd>
          <dt>Model</dt><dd>${esc(r.model || "–")}</dd>
          <dt>Effort</dt><dd>${effortAsRun(b)}</dd>
          <dt>Run id</dt><dd class="mono">${esc(b.run_id || r.run_id || "–")}</dd>
          <dt>Modes</dt><dd>${esc((r.modes || []).join(" + ") || "–")}</dd>
          <dt>Web search</dt><dd>${esc(r.web_search || "–")}</dd>
          <dt>Usage gateway</dt><dd>${esc(r.usage_gateway || "–")}</dd>
          <dt>GPU placement</dt><dd>${esc(r.gpu_placement || (r.agent ? "– (a runner without GPU placement: every trial on GPU 0)" : "–"))}</dd>
        </dl>
        <dl class="kv">
          <dt>Parallelism</dt><dd>${log.lanes ? `${log.lanes} runner(s), concurrency ${log.concurrency_max ?? "–"} per Harbor job` : (b.pending ? "awaiting digest" : "–")}</dd>
          <dt>Trials per task</dt><dd>${m.K ? `K = ${m.K}` : "–"}</dd>
          <dt>${b.batches?.length > 1 ? `These ${b.batches.length} batches` : "This batch"}</dt><dd>${m.trials ? `${esc(m.trials.planned_jobs)} jobs planned, ${esc(m.trials.trial_dirs)} trial dirs, ${esc(m.trials.with_verdict)} with a verdict` : "–"}</dd>
          <dt>Code</dt><dd class="mono">${esc(raw.repo || (b.layout === "loose" ? "– (loose files: no MANIFEST.md)" : "–"))}</dd>
          <dt>Images</dt><dd class="mono small">${esc(raw.images || "–").replace(/\n/g, "<br>")}</dd>
        </dl>
      </div>
      ${raw.notes && raw.notes !== "none" ? `<div class="small"><b>Helper's notes: </b>${esc(raw.notes)}</div>` : ""}
      ${b.redaction?.notice ? `<div class="small"><b>Helper's REDACTION.json: </b>${esc(b.redaction.notice)}</div>` : ""}
    </article>`;
  }).join("");
}

// The allocation rule per trial: rigid tasks share a GPU four ways, deformable tasks have one each.
const RULE = { rigid: { gpu: 0.25, cpu: 2, mem: 4 }, deformable: { gpu: 1, cpu: 4, mem: 8 } };

// Where a delivery's machine comes from (tools/digest.py machine()): the best record it has.
const HW_SOURCE = {
  "batch log": "from the batch log: the machine that ran the batch",
  "host.json": "from the jobs' host.json: the machine that ran them",
  "MANIFEST.md": "from MANIFEST.md: the machine that sent the delivery",
  placement: "partial: only the runner's GPU placement and the resource monitor's GPU memory; the delivery has no hardware record (no MANIFEST.md, and a runner from before 2026-10-28)",
};
const gb = (mib) => `${Math.round(mib / 1024)} GB`;

function machineOf(b) {
  const m = b.manifest || {}, host = m.host || {}, gpus = m.gpus || [];
  const named = gpus.some((g) => g.name);
  // "4 × NVIDIA L40S (45 GB)"; without the models, the GPUs by index and the memory of those a trial ran on
  const label = named
    ? Object.entries(gpus.reduce((a, g) => { const k = `${g.name || "model not recorded"}${g.memory_mib ? ` (${gb(g.memory_mib)})` : ""}`; a[k] = (a[k] || 0) + 1; return a; }, {}))
      .map(([n, c]) => `${c} × ${n}`).join(" + ")
    : gpus.length ? `${gpus.length} GPU${gpus.length > 1 ? "s" : ""} (${gpus.map((g) => g.index).join(", ")}), model not recorded` : "";
  const seen = gpus.filter((g) => g.memory_mib);
  const mem = !named && seen.length ? `${[...new Set(seen.map((g) => gb(g.memory_mib)))].join(" / ")} each on GPU ${seen.map((g) => g.index).join(", ")} (where a trial ran)` : "";
  return { key: [b.helper, host.cpu_model, host.cpus, host.ram_gb, label].join("|"), helper: b.helper, host: m.host, gpus, label, mem,
    software: b.manifest_fields?.software, source: b.hardware_source };
}

// The most trials that ran at once (from their start and end times), by kind, and the GPU, CPU and memory the rule asks
// for at that moment.
function peakLoad(ts, kindOf) {
  const ev = [];
  for (const t of ts) {
    const k = kindOf(t.base);
    if (k) ev.push([Date.parse(t.started_at), 1, k], [Date.parse(t.finished_at), -1, k]);
  }
  if (!ev.length) return null;
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);   // an end before a start at the same instant
  const n = { rigid: 0, deformable: 0 };
  const peak = { total: 0, rigid: 0, deformable: 0, gpu: 0, cpu: 0, mem: 0, at: null };
  for (const [time, d, k] of ev) {
    n[k] += d;
    const r = n.rigid, f = n.deformable;
    if (r + f > peak.total) { peak.total = r + f; peak.at = time; peak.mix = { rigid: r, deformable: f }; }
    peak.rigid = Math.max(peak.rigid, r); peak.deformable = Math.max(peak.deformable, f);
    peak.gpu = Math.max(peak.gpu, r * RULE.rigid.gpu + f * RULE.deformable.gpu);
    peak.cpu = Math.max(peak.cpu, r * RULE.rigid.cpu + f * RULE.deformable.cpu);
    peak.mem = Math.max(peak.mem, r * RULE.rigid.mem + f * RULE.deformable.mem);
  }
  return peak;
}

function renderHardware() {
  const taskBy = Object.fromEntries(S.tasks.tasks.map((t) => [t.base, t]));
  const kindOf = (base) => taskBy[base]?.material;
  const deformable = [...new Set(S.tasks.tasks.filter((t) => t.material === "deformable").map((t) => t.family_name))].join(", ");
  $("#hardware-rule").innerHTML = `Allocation rule: rigid tasks share a GPU four ways and get at least 2 CPU cores and 4 GB memory per trial; deformable tasks (${esc(deformable)}) get a GPU each and at least 4 CPU cores and 8 GB memory per trial. “Needed at peak” applies the rule to the most trials that ran at once on the machine.`;
  const machines = {};
  for (const b of S.model.bundles) {
    const m = machineOf(b);
    (machines[m.key] ||= { ...m, bundles: [] }).bundles.push(b);
  }
  const list = Object.values(machines);
  if (!list.length) {
    $("#hardware").innerHTML = `<div class="panel empty-state"><b>No delivery yet, so the hardware is still unknown.</b>
      <span>After the first delivery each machine shows its GPUs and driver, CPU, memory and software (the batch log's host lines, the jobs' host.json, or MANIFEST.md); the most trials it ran at once and whether that load fits the allocation rule (the trials' start and end times); and the memory and GPU memory each trial used, its OOM kills and its container caps (the grader's records).</span></div>`;
    return;
  }
  $("#hardware").innerHTML = list.map((mc) => {
    const keys = new Set(mc.bundles.map((b) => b.key));
    const ts = S.model.trials.filter((t) => keys.has(t.bundle));
    const timed = ts.filter((t) => t.started_at && t.finished_at);
    const peak = peakLoad(timed, kindOf);
    const host = mc.host || {};
    const first = timed.length ? Math.min(...timed.map((t) => Date.parse(t.started_at))) : null;
    const last = timed.length ? Math.max(...timed.map((t) => Date.parse(t.finished_at))) : null;
    const check = (label, need, have, unit = "") => {
      if (need == null || !have) return `<tr><td>${label}</td><td class="mono">${need == null ? "–" : need + unit}</td><td class="mono">${have ? have + unit : "–"}</td><td></td></tr>`;
      const ok = need <= have;
      return `<tr><td>${label}</td><td class="mono">${+need.toFixed(2)}${unit}</td><td class="mono">${have}${unit}</td><td><span class="pill ${ok ? "ok" : "fail"}">${ok ? "fits" : "over"}</span></td></tr>`;
    };
    const usage = ["rigid", "deformable"].map((k) => {
      const kt = ts.filter((t) => kindOf(t.base) === k);
      const mem = kt.map((t) => t.peak_memory_gb).filter((x) => typeof x === "number");
      const gpu = kt.map((t) => t.peak_gpu_memory_gb).filter((x) => typeof x === "number");
      const oom = kt.reduce((a, t) => a + (t.oom_kills || 0), 0);
      const f = (xs) => (xs.length ? `${median(xs).toFixed(1)} / ${Math.max(...xs).toFixed(1)} GB` : "–");
      const over = mem.filter((x) => x > RULE[k].mem).length;
      return `<tr><td>${k === "rigid" ? "Rigid" : "Deformable"}</td><td class="mono">${kt.length}</td><td class="mono">${f(mem)}${over ? ` <span class="tag warn" title="trials whose memory peak is above the rule's ${RULE[k].mem} GB">${over} above ${RULE[k].mem} GB</span>` : ""}</td>
        <td class="mono">${f(gpu)}</td><td class="mono">${oom ? `<span class="tag bad">${oom}</span>` : (mem.length ? "0" : "–")}</td></tr>`;
    }).join("");
    const caps = Object.entries(ts.reduce((a, t) => { if (t.cap_cpus != null) { const k = `${t.cap_cpus} CPU / ${t.cap_memory_gb} GB`; a[k] = (a[k] || 0) + 1; } return a; }, {}))
      .sort((a, b) => b[1] - a[1]).map(([k, n]) => `<span class="chip">${esc(k)} × ${n}</span>`).join("");
    const enforced = ts.filter((t) => t.limits_enforced != null);
    const nEnf = enforced.filter((t) => t.limits_enforced).length;
    return `<article class="panel host">
      <div class="host-head"><h3>${esc(mc.helper)} <span class="muted small">${esc(host.cpu_model || "unknown CPU")}</span></h3>
        <span class="small muted">${mc.bundles.length} ${mc.bundles.length === 1 ? "delivery" : "deliveries"}, ${ts.length} trials${first ? `, ${fmtDate(first)} → ${fmtDate(last)}` : ""}</span></div>
      <div class="gpu-line">${mc.gpus.length ? `<span class="gpu">${esc(mc.label)}</span>${mc.mem ? `<span class="chip">${esc(mc.mem)}</span>` : ""}${mc.gpus[0].driver ? `<span class="chip">driver ${esc(mc.gpus[0].driver)}</span>${driverTag(mc.gpus[0].driver)}` : `<span class="chip">driver not recorded</span>`}` : `<span class="muted">no GPU record in this delivery</span>`}</div>
      ${mc.source ? `<div class="small faint">${esc(HW_SOURCE[mc.source] || mc.source)}</div>` : ""}
      <div class="two">
        <dl class="kv">
          <dt>CPU</dt><dd>${host.cpus ? `${host.cpus} cores` : "–"}${host.cpu_model ? `, ${esc(host.cpu_model)}` : host.cpus ? ", model not recorded" : ""}</dd>
          <dt>Memory</dt><dd>${host.ram_gb ? `${host.ram_gb} GB` : mc.source ? "not recorded" : "–"}</dd>
          <dt>Software</dt><dd>${esc(mc.software || (mc.source ? "not recorded" : "–"))}</dd>
          <dt>Most at once</dt><dd>${peak ? `${peak.total} trials (${peak.mix.rigid} rigid + ${peak.mix.deformable} deformable) on ${esc(abs(new Date(peak.at).toISOString()))}; at most ${peak.rigid} rigid and ${peak.deformable} deformable at once` : `<span class="faint">${mc.bundles.some((b) => b.pending) ? "awaiting digest" : "no timed trials"}</span>`}</dd>
          <dt>Container caps</dt><dd>${caps ? `<div class="chips">${caps}</div><div class="small faint">${enforced.length ? `enforced in ${nEnf} of ${enforced.length} trials` : ""}</div>` : "–"}</dd>
        </dl>
        <div class="table-wrap"><table>
          <thead><tr><th>Needed at peak</th><th>By the rule</th><th>Machine has</th><th></th></tr></thead>
          <tbody>${check("GPUs", peak?.gpu ?? null, mc.gpus.length)}${check("CPU cores", peak?.cpu ?? null, host.cpus)}${check("Memory", peak?.mem ?? null, host.ram_gb, " GB")}</tbody>
        </table></div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Per trial (grader record)</th><th>Trials</th><th>Memory peak, median / max</th><th>GPU memory peak, median / max</th><th>OOM kills</th></tr></thead>
        <tbody>${usage}</tbody>
      </table></div>
    </article>`;
  }).join("");
}

// A delivery of the runner's folders as loose files (no send_results.sh, so no MANIFEST.md), and one marked unofficial.
function deliveryTags(b) {
  return (b.layout === "loose" ? ` <span class="tag" title="the runner's jobs/ and results/ folders as loose files, without send_results.sh: no MANIFEST.md, so the code commit, the images and the machine are unknown">loose files</span>` : "")
    + (b.official === false ? ` <span class="tag warn" title="${esc(b.redaction?.notice || "REDACTION.json: \"official\": false")}">unofficial: not counted</span>` : "");
}

// The reasoning effort the trials ran with (tools/digest.py): Codex's session log names it, its config.toml included;
// for another harness, the effort Harbor passed it (the job's config.json). The runner's EFFORT is the run id's.
const EFFORT_UNSET = "No reasoning effort was set: not by the runner (EFFORT=default) and not in the harness's config. "
  + "The model ran at the harness's or the provider's default level, which no record names.";
function effortAsRun(b) {
  const r = b.manifest?.runner || {};
  const runs = b.effort_as_run || [];
  if (!runs.length) return `${esc(r.effort || "–")}${r.effort ? ` <span class="small muted">(the runner's EFFORT${b.pending ? "; as run: awaiting digest" : ""})</span>` : ""}`;
  return runs.map((x) => `${x.effort ? esc(x.effort) : `<span class="tag warn" title="${esc(EFFORT_UNSET)}">not set: the model's default</span>`}`
    + `${runs.length > 1 ? ` (${x.trials} trial${x.trials > 1 ? "s" : ""})` : ""} <span class="small muted">from the ${esc(x.source)}</span>`).join("<br>")
    + (r.effort && runs.some((x) => (x.effort || "default") !== r.effort) ? ` <span class="small muted">· the runner's EFFORT: ${esc(r.effort)}</span>` : "");
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
  $("#bundles").innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Delivered</th><th>Helper</th><th>batch / bundle</th><th>Source</th><th>Pair</th><th>Trials</th><th>Success / fail / void / awaiting</th><th>State</th></tr></thead>
    <tbody>${bs.map((b) => {
      const c = statusCounts(b.key);
      const pair = pairOf(b, null);
      const state = (b.gone ? `<span class="pill fail">removed from the dataset</span>` : b.pending ? `<span class="pill wait">awaiting digest</span>`
        : b.errors?.length ? `<span class="pill void" title="${esc(b.errors.join("\n"))}">digest problems</span>` : `<span class="pill ok">digested</span>`)
        + deliveryTags(b);
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
      <td class="mono">${t.k ?? "?"} / ${t.seed ?? "?"}</td><td><span class="pill ${t.status}">${STATUS_LABEL[t.status]}</span>${kinds.includes("rerun") ? ` <span class="tag">rerun</span>` : ""}${t.unofficial ? ` <span class="tag warn">unofficial</span>` : ""}</td>
      <td>${esc(why(t))}</td><td class="mono">${typeof t.peak_memory_gb === "number" ? t.peak_memory_gb.toFixed(1) + " GB" : "–"}</td>
      <td class="mono small nowrap">${esc(S.model.bmap[t.bundle]?.batch || "")}</td></tr>`).join("")}</tbody></table></div>
    ${shown.length > 400 ? `<p class="small muted">Showing the latest 400 of ${shown.length}.</p>` : ""}`;
}

function renderMatrix() {
  const mat = $("#mx-material").value, diff = $("#mx-diff").value, q = $("#mx-search").value.trim().toLowerCase();
  const onlyIncomplete = $("#mx-incomplete").checked;
  const K = S.model.K;
  const cols = S.targets;
  const head = `<div class="mrow head" style="--cols:${cols.length}"><div>Base</div><div title="median wall time of this base's trials with a result, over all pairs">Median time</div>${cols.map((t) => `<div title="${esc(t.harness)} + ${esc(t.model)}">${esc(t.harness)}<br>${esc(t.model)}</div>`).join("")}</div>`;
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
            const tip = `${task.base} · ${c.harness} + ${c.model}\n${m} trial ${i + 1} (seed ${seed}): ${STATUS_LABEL[st]}${e && e.attempts.length > 1 ? `, ${e.attempts.length} attempts` : ""}${e?.final.wall_s != null ? `\nwall time ${fmtDur(e.final.wall_s)}` : ""}${e?.final.reason ? `\n${e.final.reason}` : ""}`;
            return `<span class="cell ${st === "empty" ? "" : st}" title="${esc(tip)}"${e ? ` data-trial="${esc(e.final.bundle)}|${esc(e.final.job)}|${esc(e.final.trial_dir)}"` : ""}></span>`;
          }).join("")).join("");
          return `<div class="mcell">${sq}</div>`;
        }).join("");
        if (onlyIncomplete && complete) continue;
        const badges = [task.easy_set ? "easy set" : "", task.own_group ? "6 h" : "", task.difficulty].filter(Boolean).join(" · ");
        famHtml += `<div class="mrow" style="--cols:${cols.length}"><div class="mname" title="${esc(task.base)}">${esc(task.base.replace(/^roboarc-/, ""))}<span class="badge">${esc(badges)}</span></div><div class="mtime">${fmtDur(median(S.model.durs.b[task.base]))}</div>${cells}</div>`;
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
  renderOverall();
  renderCards();
  renderShare();
  renderHosts();
  renderHardware();
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
    <dt>Effort</dt><dd>${effortAsRun(b)}</dd>
    <dt>Trials</dt><dd>${b.trials} (${b.jobs} jobs)</dd>
    ${b.log ? `<dt>Batch log</dt><dd>${esc(b.log.first || "")} → ${esc(b.log.last || "")}, ${b.log.lanes} runner(s), concurrency ${b.log.concurrency_max ?? "–"}</dd>` : ""}
    ${Object.entries(raw).filter(([k]) => ["notes", "mirror", "results"].includes(k)).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}
  </dl></div>`;
  if (b.layout === "loose") {
    html += `<div><h4>Loose files</h4><p class="small">The runner's <code>jobs/</code> and <code>results/</code> folders as loose files, without <code>scripts/send_results.sh</code>: no MANIFEST.md, so the code commit, the images and the machine are unknown. The run settings are the batch log's runner line: <code>${esc(raw.runner || "–")}</code>. Batches: ${(b.batches || []).map((x) => `<code>${esc(x)}</code>`).join(", ") || "none found"}.</p></div>`;
    const red = d?.redaction || b.redaction;
    if (red) html += `<div><h4>REDACTION.json${b.official === false ? ": unofficial, not counted in the progress" : ""}</h4>${jsonPre(red)}</div>`;
  } else if (d?.manifest_text) html += `<div><h4>MANIFEST.md</h4>${pre(d.manifest_text)}</div>`;
  else if (b.pending) html += `<div><h4>MANIFEST.md</h4>${pre(Object.entries(raw).map(([k, v]) => `${k}: ${v}`).join("\n"))}</div>`;
  if (d?.log_notable?.length) html += `<div><h4>Error and rerun lines of the batch log</h4>${pre(d.log_notable)}</div>`;
  const ts = S.model.trials.filter((t) => t.bundle === b.key).sort((x, y) => `${x.base}|${x.mode}|${x.k}`.localeCompare(`${y.base}|${y.mode}|${y.k}`));
  if (ts.length) html += `<div><h4>Trials: open one for its timeline</h4><div class="table-wrap"><table><thead><tr><th>Base</th><th>Mode</th><th>Trial / seed</th><th>Result</th><th>Wall time</th></tr></thead><tbody>${ts.map((t) =>
    `<tr class="clickable" data-trial="${esc(t.bundle)}|${esc(t.job)}|${esc(t.trial_dir)}" tabindex="0"><td class="mono">${esc(t.base || "?")}</td><td>${esc(t.mode || "?")}</td><td class="mono">${t.k ?? "?"} / ${t.seed ?? "?"}</td>
      <td><span class="pill ${t.status}">${STATUS_LABEL[t.status]}</span>${t.reward != null ? ` <span class="small muted">reward ${esc(t.reward)}</span>` : ""}</td><td class="mono">${fmtDur(t.wall_s)}</td></tr>`).join("")}</tbody></table></div></div>`;
  if (d?.summary_md) html += `<details><summary class="small">Batch summary (${b.batches?.length > 1 ? `the ${b.batches.length} batches' .summary.md` : `${esc(b.batch)}.summary.md`})</summary>${pre(d.summary_md)}</details>`;
  if (b.pending) html += `<p class="small muted">This delivery is not digested yet; the next digest adds the official results, the exceptions and the resource peaks.</p>`;
  body.innerHTML = html;
}

// A trial opens its timeline page (timeline.html): what the agent thought, said and ran, and what the robot did, by time.
function openTrial(ref, e) {
  const [bkey, job, trialDir] = ref.split("|");
  const b = S.model.bmap[bkey];
  if (!b) return;
  const href = timelineHref({ dataset: S.dataset, rev: b.revision, path: b.path, job, trial: trialDir });
  if (e && (e.metaKey || e.ctrlKey || e.button === 1)) window.open(href, "_blank", "noopener");
  else location.href = href;
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
    if (tr) return openTrial(tr.dataset.trial, e);
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
