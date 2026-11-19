// RoboARC rebuttal page (rebuttal.html): the experiments E1–E5 of docs/REBUTTAL_EXPERIMENTS.md. The plan
// (data/rebuttal/plan.json), the digest of the rebuttal's dataset (data/rebuttal/digest.json, tools/digest.py) and a live
// listing of the dataset on every load: the deliveries not digested yet and the step-1 check reports. The main
// evaluation's digest (data/digest.json) gives the released tasks' results for reference. No framework, no build step.

import {
  HF, REBUTTAL_DATASET, STATUS_LABEL, $, esc, pct, fmtDur, minuteStamp, abs, when, getJSON, getText, hfResolveIn, hfBlobIn,
  timelineHref, parseManifest, trialsFromIndex, readLoose, pool, listBundlesIn, listFiles,
} from "./common.js";
import { buildModel, problemRows, checkSummary, buildReference, variantsOf, slotKey, CHECKS_BATCH } from "./rebuttal-model.js";

const LIVE_EVERY_MS = 5 * 60 * 1000;
const P = typeof location === "undefined" ? new URLSearchParams() : new URLSearchParams(location.search);
const OFFLINE = P.has("offline");   // ?offline: the digest only, no live listing
const AGENT = { codex: "Codex", "claude-code": "Claude Code" };
const MODEL = { "gpt-6-astra": "GPT-6 Astra", "claude-opus-5.5": "Claude Opus 5.5" };
const MODE_SHORT = { privileged: "priv", standard: "std" };

export const S = {
  plan: null, digest: { bundles: [], trials: [] }, unofficial: {}, dataset: REBUTTAL_DATASET,
  live: { bundles: [], trials: [], listed: null, error: null, at: null, info: null },
  checks: [], checkCache: {}, renders: {},     // step 1: the check bundles with their reports; E4's rendered scenes
  mainDigest: null, ref: {},                   // the main evaluation, for reference
  model: null, exp: P.get("e") || "E1",
};

// ---------- the live listing: deliveries not digested yet, and the variant check reports ----------

async function readFresh(b) {
  const ds = S.dataset;
  let man = { parsed: {}, raw: {} }, idx = {}, err = [];
  try { man = parseManifest(await getText(hfResolveIn(ds, b.rev, `${b.path}/MANIFEST.md`))); } catch (e) { err.push(`MANIFEST.md: ${e.message}`); }
  try { idx = await getJSON(hfResolveIn(ds, b.rev, `${b.path}/index.json`)); } catch (e) { err.push(`index.json: ${e.message}`); }
  const [helper, batch, bundle] = b.path.split("/");
  let runId = idx.run_id || man.parsed.runner?.run_id || null;
  let ts = trialsFromIndex(idx, b.key, b.path, runId);
  if (err.length === 2) {   // the runner's folders as loose files?
    const loose = await readLoose(ds, b.rev, b.path, b.key).catch(() => null);
    if (loose) { man = loose.man; runId = loose.runId; ts = loose.trials; err = []; }
  }
  return {
    bundle: { key: b.key, helper, batch, bundle, path: b.path, revision: b.rev, source: b.label, uploaded_at: b.uploaded_at,
      url: hfBlobIn(ds, b.rev, b.path), run_id: runId, manifest: man.parsed, trials: ts.length, errors: err, pending: true },
    trials: ts,
  };
}

// a check bundle (<helper>/rebuttal-checks/<UTC time>/): its E<n>.json reports; it never changes once sent
async function readCheck(b) {
  if (S.checkCache[b.key]) return S.checkCache[b.key];
  const [helper, , id] = b.path.split("/");
  const reports = {};
  await Promise.all(S.plan.experiments.map(async (e) => {
    const r = await getJSON(hfResolveIn(S.dataset, b.rev, `${b.path}/${e.id}.json`), { optional: true }).catch(() => null);
    if (r) reports[e.id] = r;
  }));
  const c = { key: b.key, helper, id, rev: b.rev, label: b.label, path: b.path, uploaded_at: b.uploaded_at, reports };
  if (Object.keys(reports).length) S.checkCache[b.key] = c;
  return c;
}

async function refreshLive() {
  const btn = $("#refresh");
  btn.disabled = true;
  try {
    const info = await getJSON(`${HF}/api/datasets/${S.dataset}`);
    const listed = await listBundlesIn(S.dataset);
    const checkB = listed.filter((b) => b.path.split("/")[1] === CHECKS_BATCH);
    const runB = listed.filter((b) => b.path.split("/")[1] !== CHECKS_BATCH);
    const known = new Set(S.digest.bundles.map((b) => b.key));
    const fresh = await pool(runB.filter((b) => !known.has(b.key)), 4, readFresh);
    S.checks = await pool(checkB, 4, readCheck);
    // E4's rendered scenes of the latest report that has E4
    const c4 = S.checks.filter((c) => c.reports.E4).sort((a, b) => String(b.id).localeCompare(String(a.id)))[0];
    if (c4 && !S.renders[c4.key]) S.renders[c4.key] = await listFiles(S.dataset, c4.rev, `${c4.path}/e4_render`).catch(() => ({}));
    S.live = { bundles: fresh.map((x) => x.bundle), trials: fresh.flatMap((x) => x.trials), listed: runB.map((b) => b.key), error: null, at: new Date().toISOString(), info };
  } catch (e) {
    S.live = { ...S.live, error: e.message, at: new Date().toISOString() };
  }
  btn.disabled = false;
  render();
}

// ---------- small pieces ----------

const expTitle = (e) => `${AGENT[e.agent] || e.agent} + ${MODEL[e.model] || e.model}`;
const condName = (c, mode, e) => `${c.label}${e.modes.length > 1 ? ` · ${mode}` : ""}`;
const rate = (ok, n) => (n ? `${ok} / ${n} <span class="faint">(${pct(ok, n)})</span>` : `<span class="faint">–</span>`);
const pill = (st) => (st === "empty" ? `<span class="tag">not run</span>` : `<span class="pill ${st}">${STATUS_LABEL[st]}</span>`);
const trialRef = (t) => `${esc(t.bundle)}|${esc(t.job)}|${esc(t.trial_dir)}`;

function bar(c, total) {
  const w = (n) => `${total ? (100 * n) / total : 0}%`;
  return `<div class="bar" role="img" aria-label="success ${c.ok}, fail ${c.fail}, not a result ${c.void}, awaiting digest ${c.wait}, of ${total}">
    <div class="seg ok" style="width:${w(c.ok)}"></div><div class="seg fail" style="width:${w(c.fail)}"></div>
    <div class="seg void" style="width:${w(c.void)}"></div><div class="seg wait" style="width:${w(c.wait)}"></div></div>`;
}

function square(slot, tip, flagged) {
  const st = slot ? slot.final.status : "empty";
  return `<span class="cell ${st === "empty" ? "" : st}${flagged ? " flag" : ""}" title="${esc(tip)}"${slot ? ` data-trial="${trialRef(slot.final)}"` : ""}></span>`;
}

function checkTag(cs) {
  if (!cs?.sent) return `<span class="tag">step 1: no report</span>`;
  return cs.all_pass ? `<span class="tag good">step 1: all pass</span>` : `<span class="tag bad">step 1: ${cs.n_pass} / ${cs.expected} pass</span>`;
}

// ---------- sections (each returns HTML; render() puts it on the page) ----------

export function htmlOverall(M) {
  const t = M.total, withResult = t.ok + t.fail;
  const smoke = M.experiments.reduce((a, x) => a + x.smoke.counts.ok + x.smoke.counts.fail, 0);
  const smokeN = M.experiments.reduce((a, x) => a + x.smoke.counts.total, 0);
  const C = checkSummary(S.plan, S.checks);
  const passed = M.experiments.filter((x) => C[x.id]?.all_pass).length;
  return `<div class="panel overall">
    <div><span class="k">Trials with a result</span><span class="v"><b>${withResult}</b> / ${t.total} (${pct(withResult, t.total)})</span></div>
    <div><span class="k">Success</span><span class="v"><b>${t.ok}</b> (${pct(t.ok, withResult)} of results)</span></div>
    <div><span class="k">Not a result · awaiting digest</span><span class="v"><b>${t.void}</b> · <b>${t.wait}</b></span></div>
    <div><span class="k">Step 1 passed · smoke with a result</span><span class="v"><b>${passed}</b> / ${M.experiments.length} experiments · <b>${smoke}</b> / ${smokeN} trials</span></div>
  </div>`;
}

export function htmlCards(M) {
  const C = checkSummary(S.plan, S.checks);
  return M.experiments.map((x) => {
    const e = x.plan, c = x.counts, withResult = c.ok + c.fail;
    const sm = x.smoke.counts, smokeDone = sm.ok + sm.fail;
    const condRows = x.conds.map((k) => {
      const n = k.counts.ok + k.counts.fail;
      return `<span>${esc(condName(k, k.mode, e))}</span>${bar(k.counts, k.counts.total)}<span class="mono">${k.counts.ok} / ${n}</span>`;
    }).join("");
    const reps = x.batches.map((b) => `<span title="${esc(b.batch)}: ${b.delivered} of ${b.planned} planned trials delivered, ${b.counts.ok + b.counts.fail} with a result">r${b.repeat} ${b.delivered} / ${b.planned}</span>`).join("");
    return `<article class="panel card">
      <div class="card-top"><div><div class="harness">${esc(e.id)} · effort ${esc(e.effort)}</div><div class="model">${esc(expTitle(e))}</div></div>
        <div class="chips" style="justify-content:end">${checkTag(C[e.id])}<span class="tag ${sm.total && smokeDone === sm.total ? "good" : ""}">smoke ${smokeDone} / ${sm.total}</span></div></div>
      <p class="small muted">${esc(e.purpose)}: ${e.bases.length} tasks × ${e.conditions.length} conditions${e.modes.length > 1 ? ` × ${e.modes.length} modes` : ""} × ${e.repeats} repeat${e.repeats > 1 ? "s" : ""}.</p>
      <div class="count"><span class="n">${withResult}</span><span class="d">/ ${c.total} trials with a result · ${c.ok} success${c.void ? ` · ${c.void} to rerun` : ""}${c.wait ? ` · ${c.wait} awaiting digest` : ""}</span></div>
      ${bar(c, c.total)}
      <div class="modes">${condRows}</div>
      <div class="card-foot"><span>delivered:</span>${reps}<span>run id: <span class="mono">${esc(e.run_id)}</span></span></div>
    </article>`;
  }).join("");
}

export function htmlChecks() {
  const C = checkSummary(S.plan, S.checks);
  const rows = S.plan.experiments.map((e) => {
    const c = C[e.id];
    if (!c.sent) return `<tr><td>${esc(e.id)}</td><td colspan="6" class="muted">No report sent yet (${c.expected} variants to check).</td></tr>`;
    const k = c.check;
    const res = c.all_pass ? `<span class="pill ok">ALL PASS</span>` : `<span class="pill fail">NOT PASSED</span>`;
    const own = c.own ? `${c.own_pass} / ${c.own} own checks` : "";
    const exp = c.exp_checks.map((x) => `${x.name}: ${x.pass ? "pass" : "FAIL"}`).join(", ");
    const env = [`rendering ${c.render || "?"}`, c.commit ? `commit <code>${esc(c.commit)}</code>${c.local_changes ? ` <span class="tag bad">local changes</span>` : ""}` : "", c.harbor ? `harbor ${esc(c.harbor)}` : ""].filter(Boolean).join(" · ");
    return `<tr><td>${esc(e.id)}</td><td>${res}${c.render !== "on" ? ` <span class="tag bad">rendering off: not accepted by the gate</span>` : ""}</td>
      <td class="mono">${c.n_pass} / ${c.expected}${c.n_variants !== c.expected ? ` <span class="tag bad">${c.n_variants} in the report</span>` : ""}</td>
      <td class="small">${esc([own, exp, c.oracle_skipped ? `${c.oracle_skipped} without a reference solution (nop only)` : ""].filter(Boolean).join(" · ")) || "–"}</td>
      <td class="small">${env}</td>
      <td class="nowrap">${esc(k.helper)} · ${when(k.uploaded_at)}<br><span class="faint mono">${esc(k.id)} · ${esc(k.label)}${c.sent > 1 ? ` · ${c.sent} reports` : ""}</span></td>
      <td class="nowrap"><a href="${esc(hfBlobIn(S.dataset, k.rev, `${k.path}/${e.id}.md`))}" target="_blank" rel="noopener">${esc(e.id)}.md</a></td></tr>`;
  }).join("");
  return `<div class="table-wrap"><table>
    <thead><tr><th>Experiment</th><th>Result</th><th>Variants passed</th><th>Own checks</th><th>Run</th><th>Sent</th><th>Report</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <p class="small muted">Not covered by step 1: E5's V2 depth noise and calibration error (its variants get the DIGEST, oracle and nop checks only, and the reference solution does not look through the cameras).</p>`;
}

function renderGallery(c) {
  const files = S.renders[c.key];
  if (!files || !Object.keys(files).length) return `<p class="small muted">No rendered scenes in this report (<code>e4_render/</code>).</p>`;
  const vars = {};
  for (const n of Object.keys(files)) {
    const m = n.match(/^([^/]+)\/(base_)?step_(\d+)\.png$/);
    if (m) ((vars[m[1]] ||= { base: [], variant: [] })[m[2] ? "base" : "variant"]).push({ n, step: +m[3] });
  }
  const url = (n) => hfResolveIn(S.dataset, c.rev, `${c.path}/e4_render/${n}`);
  const row = (lbl, xs) => (xs.length ? `<div class="render-row" style="--n:${xs.length}"><span class="lbl">${lbl}</span>${xs.sort((a, b) => a.step - b.step)
    .map((x) => `<a href="${esc(url(x.n))}" target="_blank" rel="noopener"><img loading="lazy" src="${esc(url(x.n))}" alt="${esc(x.n)}"></a>`).join("")}</div>` : "");
  return `<p class="small muted">Each relaxed privileged variant and its released task as the cameras render them at the start, middle and end of the reference solution (<code>scripts/rebuttal/check_clearance_render.py</code>): the gap should be wider and nothing else changed. <a href="${esc(hfBlobIn(S.dataset, c.rev, `${c.path}/e4_render/report.md`))}" target="_blank" rel="noopener">report.md</a></p>
    <div class="renders">${Object.keys(vars).sort().map((v) => `<div class="render-var"><span class="t">${esc(v)}</span>${row("released", vars[v].base)}${row("relaxed", vars[v].variant)}</div>`).join("")}</div>`;
}

export function htmlCheckDetail() {
  const C = checkSummary(S.plan, S.checks);
  let html = "";
  for (const e of S.plan.experiments) {
    const c = C[e.id];
    if (!c.sent) continue;
    const parts = [];
    if (c.failed.length) {
      parts.push(`<div class="table-wrap"><table><thead><tr><th>Variant</th><th>Condition</th><th>Why it did not pass</th></tr></thead><tbody>${c.failed.map((v) =>
        `<tr><td class="mono">${esc(v.task)}</td><td>${esc(v.label || "")}</td><td>${esc(v.why.join("; ") || "–")}</td></tr>`).join("")}</tbody></table></div>
        <p class="small"><a href="${esc(hfBlobIn(S.dataset, c.check.rev, `${c.check.path}/failed_jobs`))}" target="_blank" rel="noopener">Harbor job folders of the runs that did not pass</a></p>`);
    }
    for (const x of c.exp_checks) if (!x.pass) parts.push(`<p class="small"><span class="tag bad">${esc(x.name)} failed (exit ${esc(x.rc)})</span></p>`);
    if (e.id === "E4") parts.push(`<details><summary class="small">Rendered scenes (released and relaxed)</summary>${renderGallery(c.check)}</details>`);
    if (parts.length) html += `<div class="panel host"><div class="chk-head"><h3>${esc(e.id)} · ${esc(e.purpose)}</h3>${checkTag(c)}</div>${parts.join("")}</div>`;
  }
  return html;
}

export function htmlSmoke(M) {
  return M.experiments.map((x) => {
    const e = x.plan, sm = x.smoke.counts;
    const rows = x.smoke.rows.map((r) => {
      const t = r.slot?.final;
      return `<tr${t ? ` class="clickable" data-trial="${trialRef(t)}" tabindex="0"` : ""}><td>${esc(condName({ label: r.label }, r.mode, e))}</td><td>${pill(r.status)}</td>
        <td class="mono">${t ? fmtDur(t.wall_s) : ""}</td><td class="flags">${esc(t?.flags?.join("; ") || "")}${t?.reason ? `<span class="muted">${esc(t.reason)}</span>` : ""}</td></tr>`;
    }).join("");
    return `<div class="panel smoke-block"><div class="share-head"><span>${esc(e.id)} · ${esc(expTitle(e))}</span><span class="tag ${sm.ok + sm.fail === sm.total ? "good" : ""}">${sm.ok + sm.fail} / ${sm.total} with a result</span></div>
      <div class="small muted mono">${esc(x.smoke.batch)} · ${esc(e.smoke_base.replace(/^roboarc-/, ""))}</div>
      <div class="table-wrap"><table><thead><tr><th>Variant</th><th>Result</th><th>Wall</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  }).join("");
}

export function htmlResults(M) {
  return M.experiments.map((x) => {
    const e = x.plan, ref = S.ref[e.id];
    const repHead = Array.from({ length: e.repeats }, (_, i) => `<th>r${i + 1}</th>`).join("");
    const rows = x.conds.map((k) => {
      const n = k.counts.ok + k.counts.fail;
      return `<tr><td>${esc(k.label)}</td><td>${esc(k.mode)}</td><td class="mono">${rate(k.counts.ok, n)}</td>
        ${k.repeats.map((r) => `<td class="mono">${rate(r.ok, r.ok + r.fail)}</td>`).join("")}
        <td class="mono">${k.counts.void || ""}</td><td class="mono">${k.counts.wait || ""}</td><td class="mono">${k.counts.empty || ""}</td></tr>`;
    }).join("");
    const refRows = ref ? ["standard", "privileged"].map((m) => {
      const s = ref.sums[m];
      return `<tr class="ref"><td>released task</td><td>${m}</td><td class="mono">${rate(s.ok, s.ok + s.fail)}</td><td colspan="${e.repeats}" class="small">main evaluation, seed 0${ref.runIds.length ? `: <span class="mono">${esc(ref.runIds.join(", "))}</span>` : ""}</td>
        <td class="mono">${s.other || ""}</td><td></td><td class="mono" title="tasks without a main-evaluation trial at seed 0">${s.missing || ""}</td></tr>`;
    }).join("") : `<tr class="ref"><td colspan="${6 + e.repeats}" class="small">Main evaluation for reference: loading…</td></tr>`;
    return `<div class="panel host"><div class="chk-head"><h3>${esc(e.id)} · ${esc(expTitle(e))}, effort ${esc(e.effort)}</h3><span class="small muted">${esc(e.purpose)}</span></div>
      <div class="table-wrap"><table><thead><tr><th>Condition</th><th>Mode</th><th>Success / with a result</th>${repHead}<th>Not a result</th><th>Awaiting</th><th>Not run</th></tr></thead>
      <tbody>${rows}${refRows}</tbody></table></div>
      <p class="small faint">${e.conditions.map((c) => `<b>${esc(c.label)}</b>: ${esc(c.note)}`).join(" · ")}</p></div>`;
  }).join("");
}

export function htmlMatrixTabs() {
  return S.plan.experiments.map((e) => `<button type="button" role="tab" data-exp="${esc(e.id)}" aria-selected="${e.id === S.exp}">${esc(e.id)}</button>`).join("");
}

export function htmlMatrix(M) {
  const x = M.experiments.find((y) => y.id === S.exp) || M.experiments[0];
  const e = x.plan, ref = S.ref[e.id];
  const cols = e.conditions.flatMap((c) => e.modes.map((m) => ({ ...c, mode: m })));
  const refModes = ["standard", "privileged"];
  const style = `--cols:${cols.length};--refs:${refModes.length}`;
  let html = `<div class="rrow head" style="${style}"><div>Task</div>${cols.map((c) => `<div title="${esc(c.note)}">${esc(c.label)}${e.modes.length > 1 ? `<br>${esc(c.mode)}` : ""}</div>`).join("")}
    ${refModes.map((m) => `<div class="ref" title="main evaluation, released task, seed 0${ref?.runIds.length ? `: ${esc(ref.runIds.join(", "))}` : ""}">main<br>${MODE_SHORT[m]}</div>`).join("")}</div>`;
  for (const base of e.bases) {
    const cells = cols.map((c) => {
      const sq = Array.from({ length: e.repeats }, (_, i) => {
        const s = M.slots[slotKey("run", e.id, i + 1, base, c.token, c.mode)];
        const f = s?.final;
        const tip = `${base} · ${c.label} · ${c.mode} · repeat ${i + 1} (${e.batches[i]})\n${STATUS_LABEL[s ? f.status : "empty"]}${s && s.n > 1 ? `, ${s.n} attempts` : ""}${f?.wall_s != null ? `\nwall time ${fmtDur(f.wall_s)}` : ""}${f?.reason ? `\n${f.reason}` : ""}${f?.flags?.length ? `\n${f.flags.join("; ")}` : ""}`;
        return square(s, tip, f?.flags?.length);
      }).join("");
      return `<div class="rcell">${sq}</div>`;
    }).join("");
    const refCells = refModes.map((m) => {
      const t = ref?.cells[`${base}|${m}`];
      const tip = t ? `${base} · released task · ${m} · seed 0\nmain evaluation, ${t.run_id}: ${STATUS_LABEL[t.status]}` : `${base} · ${m}: no main-evaluation trial at seed 0${ref ? "" : " (loading)"}`;
      return `<div class="rcell ref"><span class="cell ${t ? t.status : ""}" title="${esc(tip)}"></span></div>`;
    }).join("");
    html += `<div class="rrow" style="${style}"><div class="mname" title="${esc(base)}">${esc(base.replace(/^roboarc-/, ""))}</div>${cells}${refCells}</div>`;
  }
  return html;
}

const WHY = (t) => t.reason || (t.exception_type !== "AgentTimeoutError" && t.exception_type) || (t.result === "no_verdict" ? "no verdict" : "")
  || (t.status === "wait" ? "awaiting digest" : "") || (t.flags.length ? "settings not as planned" : "rerun");

export function htmlProblems(M) {
  const rows = problemRows(M);
  const tally = {};
  rows.forEach((r) => { const k = WHY(r.t); tally[k] = (tally[k] || 0) + 1; });
  const chips = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 14)
    .map(([k, n]) => `<span class="chip" title="${esc(k)}">${esc(k.length > 70 ? k.slice(0, 70) + "…" : k)} · ${n}</span>`).join("");
  if (!rows.length) return { chips, table: `<div class="panel empty-state"><b>No failed, rerun or off-plan trials yet.</b><span>Once deliveries arrive, this lists trials that are not a result, trials with a Harbor exception, trials run more than once, and trials whose run id, effort, seed, task, condition or mode is not the plan's.</span></div>` };
  const table = `<div class="table-wrap"><table>
    <thead><tr><th>Time</th><th>Batch</th><th>Task</th><th>Condition</th><th>Mode</th><th>Result</th><th>Reason / exception</th><th>Attempts</th><th>Not as planned</th></tr></thead>
    <tbody>${rows.slice(0, 400).map(({ t, kinds }) => `<tr class="clickable" data-trial="${trialRef(t)}" tabindex="0">
      <td class="nowrap">${when(t.when)}</td><td class="mono small nowrap">${esc(M.bmap[t.bundle]?.batch || "")}</td>
      <td class="mono">${esc((t.base0 || t.base || "?").replace(/^roboarc-/, ""))}</td><td>${esc(t.cond || "?")}</td><td>${esc(t.mode || "?")}</td>
      <td>${pill(t.status)}${kinds.includes("rerun") ? ` <span class="tag">rerun</span>` : ""}${t.attempts_over_cap ? ` <span class="tag warn">over the cap</span>` : ""}</td>
      <td>${esc(WHY(t))}</td><td class="mono">${t.attempts ?? ""}</td><td class="flags">${esc(t.flags.join("; "))}</td></tr>`).join("")}</tbody></table></div>
    ${rows.length > 400 ? `<p class="small muted">Showing the latest 400 of ${rows.length}.</p>` : ""}`;
  return { chips, table };
}

export function htmlDeliveries(M) {
  const bs = M.bundles;
  if (!bs.length) {
    const info = S.live.info;
    return `<div class="panel empty-state"><b>No deliveries in the dataset yet.</b><span>The dataset <a href="${HF}/datasets/${esc(S.dataset)}" target="_blank" rel="noopener">${esc(S.dataset)}</a> ${info ? `holds ${info.siblings?.length ?? 0} file(s), last updated ${when(info.lastModified)}` : "could not be read yet"}${S.checks.length ? `, and ${S.checks.length} variant check report(s)` : ""}. A delivery (a direct commit or a pull request) shows up here at the next refresh.</span></div>`;
  }
  const count = (key) => {
    const c = { ok: 0, fail: 0, void: 0, wait: 0 };
    for (const t of M.latest) if (t.bundle === key && t.status in c) c[t.status]++;
    return c;
  };
  return `<div class="table-wrap"><table>
    <thead><tr><th>Delivered</th><th>Helper</th><th>batch / bundle</th><th>Experiment</th><th>Source</th><th>Trials / planned</th><th>Success / fail / void / awaiting</th><th>State</th></tr></thead>
    <tbody>${bs.map((b) => {
      const c = count(b.key), e = M.exps[b.exp];
      const planned = b.kind === "run" ? variantsOf(e).length : b.kind === "smoke" ? variantsOf(e).filter((v) => v.base === e.smoke_base).length : null;
      const what = b.kind === "run" ? `${esc(b.exp)}, repeat ${b.repeat} of ${e?.repeats ?? "?"}` : b.kind === "smoke" ? `${esc(b.exp)} smoke` : `<span class="tag warn">not a rebuttal batch</span>`;
      const state = (b.gone ? `<span class="pill fail">removed from the dataset</span>` : b.pending ? `<span class="pill wait">awaiting digest</span>`
        : b.errors?.length ? `<span class="pill void" title="${esc(b.errors.join("\n"))}">digest problems</span>` : `<span class="pill ok">digested</span>`)
        + (b.unofficial ? ` <span class="tag warn">unofficial</span>` : "");
      return `<tr><td class="nowrap">${when(b.uploaded_at)}</td><td>${esc(b.helper)}</td>
        <td class="mono">${b.url ? `<a href="${esc(b.url)}" target="_blank" rel="noopener">${esc(b.batch)}</a>` : esc(b.batch)}<br><span class="faint">${esc(b.bundle)}</span></td>
        <td>${what}</td><td>${esc(b.source)}</td>
        <td class="mono">${b.trials}${planned != null ? ` / ${planned}` : ""}${planned != null && b.trials > planned ? ` <span class="tag">reruns</span>` : ""}</td>
        <td class="mono">${c.ok} / ${c.fail} / ${c.void} / ${c.wait}</td><td>${state}</td></tr>`;
    }).join("")}</tbody></table></div>`;
}

function renderStatus() {
  const live = S.live, d = S.digest;
  const nPending = live.bundles.length;
  $("#live-status").innerHTML = OFFLINE ? `<span class="dot"></span>Offline mode: data/rebuttal/digest.json only`
    : live.error ? `<span class="dot err"></span>Could not read Hugging Face: ${esc(live.error)} (showing the last digest)`
    : live.at ? `<span class="dot live"></span>Hugging Face: dataset updated <b>${when(live.info?.lastModified)}</b>, ${live.listed?.length ?? 0} deliveries${nPending ? `, ${nPending} awaiting digest` : ""}, ${S.checks.length} check report(s); read ${when(live.at)}`
    : `<span class="dot"></span>Reading Hugging Face…`;
  $("#digest-status").innerHTML = d.generated_at ? `logs digested ${when(d.generated_at)}` : "logs not digested yet";
}

// ---------- page ----------

function render() {
  if (!S.plan) return;
  const M = (S.model = buildModel({ plan: S.plan, digest: S.digest, live: S.live, unofficial: S.unofficial }));
  renderStatus();
  $("#overall").innerHTML = htmlOverall(M);
  $("#cards").innerHTML = htmlCards(M);
  $("#check-table").innerHTML = htmlChecks();
  $("#check-detail").innerHTML = htmlCheckDetail();
  $("#smoke-list").innerHTML = htmlSmoke(M);
  $("#results-list").innerHTML = htmlResults(M);
  $("#mx-exp").innerHTML = htmlMatrixTabs();
  $("#rmatrix-grid").innerHTML = htmlMatrix(M);
  const p = htmlProblems(M);
  $("#problem-kinds").innerHTML = p.chips;
  $("#problem-table").innerHTML = p.table;
  $("#delivery-table").innerHTML = htmlDeliveries(M);
}

function openTrial(ref, e) {
  const [bkey, job, trial] = ref.split("|");
  const b = S.model?.bmap[bkey];
  if (!b) return;
  const href = timelineHref({ dataset: S.dataset, rev: b.revision, path: b.path, job, trial });
  if (e && (e.metaKey || e.ctrlKey || e.button === 1)) window.open(href, "_blank", "noopener");
  else location.href = href;
}

function wire() {
  $("#refresh").addEventListener("click", () => { reloadDigest().then(refreshLive); });
  document.addEventListener("click", (e) => {
    const tab = e.target.closest("#mx-exp [data-exp]");
    if (tab) {
      S.exp = tab.dataset.exp;
      const u = new URL(location.href); u.searchParams.set("e", S.exp); history.replaceState(null, "", u);
      $("#mx-exp").innerHTML = htmlMatrixTabs();
      $("#rmatrix-grid").innerHTML = htmlMatrix(S.model);
      return;
    }
    const tr = e.target.closest("[data-trial]");
    if (tr) openTrial(tr.dataset.trial, e);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const el = e.target.closest?.("[data-trial]");
    if (el) el.click();
  });
}

async function reloadDigest() {
  const d = await getJSON(`data/rebuttal/digest.json?v=${minuteStamp()}`, { optional: true }).catch(() => null);
  if (d) S.digest = d;
}

// the main evaluation's digest is large: loaded after the page is up
async function loadReference() {
  const d = await getJSON(`data/digest.json?v=${minuteStamp()}`, { optional: true }).catch(() => null);
  S.ref = buildReference(S.plan, d, S.unofficial);
  if (S.model) { $("#results-list").innerHTML = htmlResults(S.model); $("#rmatrix-grid").innerHTML = htmlMatrix(S.model); }
}

async function start() {
  const [plan, unofficial] = await Promise.all([
    getJSON(`data/rebuttal/plan.json?v=${minuteStamp()}`),
    getJSON(`data/unofficial.json?v=${minuteStamp()}`, { optional: true }).catch(() => null),
  ]);
  S.plan = plan; S.unofficial = unofficial?.bundles || {};
  if (plan.dataset) S.dataset = plan.dataset;
  if (!plan.experiments.some((e) => e.id === S.exp)) S.exp = plan.experiments[0].id;
  $("#ds-link").href = `${HF}/datasets/${S.dataset}`;
  $("#ds-link").textContent = S.dataset;
  $("#release").textContent = `RoboARC rebuttal · ${plan.experiments.length} experiments · ${plan.total} trials`;
  $("#foot-plan").innerHTML = `The plan is <code>scripts/rebuttal/experiments.py</code> of RoboARC's <code>${esc(plan.branch)}</code> at <code>${esc(plan.commit)}</code> (<code>data/rebuttal/plan.json</code>).`;
  await reloadDigest();
  wire();
  render();
  loadReference();
  if (OFFLINE) return;
  refreshLive();
  setInterval(() => { reloadDigest().then(refreshLive); }, LIVE_EVERY_MS);
}

if (typeof document !== "undefined") {
  start().catch((e) => {
    $("#live-status").innerHTML = `<span class="dot err"></span>Could not load the page data: ${esc(e.message)}`;
  });
}
