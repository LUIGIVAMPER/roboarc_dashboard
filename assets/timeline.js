// The timeline of one trial (timeline.html?rev=&path=&job=&trial=): the agent's model turns from Harbor's ATIF trajectory
// (agent/trajectory.json) merged by time with the robot's record, both read from the trial's job archive on Hugging Face
// in the browser. The archive is sorted by name, so agent/ comes first and artifacts/data/episode.jsonl soon after; the
// download stops there.

import {
  HF, DEFAULT_DATASET, STATUS_LABEL, $, esc, fmtInt, fmtDur, abs, getJSON, getText, hfResolveIn, hfBlobIn, statusOf,
  timelineHref, parseManifest, trialsFromIndex, minuteStamp,
} from "./common.js";

// ---------- reading a job archive in the browser (gzip stream + tar), stopping early ----------

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

// Stream <url> (a .tar.gz); onFile(name, bytes) for each regular file want(name, size) accepts; stop(name) true ends the
// download at that entry. Resolves to the archive bytes unpacked so far.
export async function untarGz(url, { want, stop = () => false, onFile, onProgress }) {
  const ctl = new AbortController();
  const res = await fetch(url, { signal: ctl.signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const q = new ByteQueue(res.body.pipeThrough(new DecompressionStream("gzip")).getReader());
  const dec = new TextDecoder();
  const str = (h, a, b) => dec.decode(h.subarray(a, b)).replace(/\0[\s\S]*$/, "");
  let longName = null, paxPath = null;
  try {
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
      if (stop(name)) break;
      if ((type === "0" || type === "\0") && want(name, size)) { const d = await q.take(padded); await onFile(name, d.subarray(0, size)); }
      else if (!(await q.skip(padded))) break;
      onProgress?.(q.total);
    }
  } finally {
    ctl.abort();
  }
  return q.total;
}

// ---------- the model: ATIF steps and the robot's records -> events ----------

const IMG = /data:image\/[a-z0-9+.-]+;base64,[A-Za-z0-9+/=\s]+/gi;

// A tool result's content (a string, possibly a Python repr of image parts, or a list of parts) as text, images left out.
function contentText(c) {
  let images = 0;
  const one = (x) => {
    if (x == null) return "";
    if (typeof x === "string") return x.replace(IMG, () => { images++; return "[image]"; });
    if (Array.isArray(x)) return x.map(one).join("\n");
    if (typeof x === "object") {
      if (/image/.test(String(x.type || ""))) { images++; return "[image]"; }
      if (typeof x.text === "string") return one(x.text);
      if ("content" in x) return one(x.content);
      return one(JSON.stringify(x));
    }
    return String(x);
  };
  const text = one(c).replace(/\{'type': '(?:input_)?image', 'image_url': '\[image\]'(?:, 'detail': '[^']*')?\}/g, "[image]")
    .replace(/^\[((?:\[image\](?:, )?)+)\]$/, "$1");     // a list of image parts only
  return { text, images };
}

const MAIN_ARG = ["cmd", "command", "input", "patch", "code", "file_path", "path", "pattern", "query", "url", "chars"];

function callView(c) {
  let args = c.arguments;
  if (typeof args === "string") { try { args = JSON.parse(args); } catch { /* a raw string argument */ } }
  let main = null, rest = null;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const k = MAIN_ARG.find((x) => typeof args[x] === "string" && args[x].trim());
    if (k) { main = args[k]; const r = { ...args }; delete r[k]; rest = Object.keys(r).length ? r : null; }
  } else if (typeof args === "string") main = args;
  const body = main != null ? main + (rest ? `\n\n${JSON.stringify(rest, null, 1)}` : "") : JSON.stringify(args, null, 1);
  // the first lines of a command, joined: `cd /app && python -c " ↵ import numpy ↵ …`
  const line = (main ?? JSON.stringify(args) ?? "").split("\n").map((l) => l.trim()).filter(Boolean).join(" ↵ ");
  return { name: c.function_name || c.name || "tool", id: c.tool_call_id, summary: line.length > 220 ? line.slice(0, 219) + "…" : line, args: body };
}

export function atifEvents(traj) {
  const out = [];
  for (const s of traj?.steps || []) {
    const t = Date.parse(s.timestamp) / 1000;
    if (!Number.isFinite(t)) continue;
    if (s.source !== "agent") {
      const text = typeof s.message === "string" ? s.message : JSON.stringify(s.message);
      const label = s.source === "system" ? "system prompt" : /^\s*<environment_context>/.test(text) ? "environment" : "task instruction";
      out.push({ type: "prompt", t, step: s.step_id, label, text });
      continue;
    }
    const results = {};
    const loose = [];
    for (const r of s.observation?.results || []) (r.source_call_id ? (results[r.source_call_id] = r) : loose.push(r));
    const tools = (s.tool_calls || []).map((c) => {
      const v = callView(c);
      const r = results[v.id];
      const o = r ? contentText(r.content) : { text: "", images: 0 };
      return { ...v, output: o.text, images: o.images, answered: !!r };
    });
    for (const r of loose) { const o = contentText(r.content); tools.push({ name: "output", summary: "", args: "", output: o.text, images: o.images, answered: true }); }
    const m = s.metrics || {};
    out.push({
      type: "turn", t, step: s.step_id,
      think: typeof s.reasoning_content === "string" ? s.reasoning_content.trim() : "",
      say: typeof s.message === "string" ? s.message.trim() : "",
      tools,
      tokens: m.prompt_tokens != null || m.completion_tokens != null ? { in: m.prompt_tokens, cached: m.cached_tokens, out: m.completion_tokens, reasoning: m.extra?.reasoning_output_tokens } : null,
    });
  }
  return out;
}

const n2 = (x) => (typeof x === "number" ? +x.toFixed(2) : x);

function robotText(e) {
  switch (e.ev) {
    case "submit": {
      const fails = (e.plan || []).filter((p) => JSON.stringify(p).includes("Fail")).length;
      return `${e.type || "?"} × ${e.rows ?? "?"} rows, dt ${n2(e.dt)} s, ${fmtInt(e.control_steps)} control steps`
        + (e.n_clipped ? `, ${e.n_clipped} clipped` : "") + (fails ? `, ${fails} planning failures` : "")
        + (e.success ? " · success" : "") + (e.note ? ` · note: ${e.note}` : "");
    }
    case "observe": return `${n2(e.seconds)} s, cameras ${(e.cameras || []).join(", ") || "none"}`;
    case "checkpoint": return `step ${e.step ?? "?"}, ${fmtInt(e.control_steps)} control steps${e.success ? " · success" : ""}${e.done ? " · done" : ""}${e.reason ? ` · ${e.reason}` : ""}`;
    case "start": return `episode start, ${e.task || ""} ${e.protocol ? `(${e.protocol})` : ""}`.trim();
    case "nyx_ready": return `renderer ready after ${n2(e.startup_s)} s`;
    case "first_request": return "the agent's first request";
    case "end": return `episode end: ${e.reason || "?"}, ${fmtInt(e.control_steps)} control steps, success ${e.success}`;
    case "exit": return e.reason || "";
    case "session_start": return `session start, ${e.task || ""}`;
    case "reset": return `reset #${e.n ?? "?"} (${fmtInt(e.sim_steps_before)} sim steps before)`;
    case "record": return `trajectory recorded: ${fmtInt(e.n_actions)} actions, success ${e.success}`;
    default: {
      const r = { ...e }; delete r.ts; delete r.ev; delete r.pid;
      const s = JSON.stringify(r);
      return s.length > 300 ? s.slice(0, 299) + "…" : s;
    }
  }
}

// episode.jsonl (the robot service, standard mode) or rcb_session_log.jsonl (the simulator tooling, privileged mode)
export function robotEvents(text, src) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e.ts !== "number" || e.ev === "call_begin" || e.ev === "call_end") continue;
    if (e.ev === "checkpoint" && !(e.success || e.done || e.reason)) continue;   // one per call: only a notable one
    out.push({ type: "robot", t: e.ts, src, ev: e.ev || "?", text: robotText(e), good: e.success === true });
  }
  return out;
}

// ---------- the page ----------

const P = typeof location === "undefined" ? new URLSearchParams() : new URLSearchParams(location.search);
const T = {
  dataset: P.get("ds") || DEFAULT_DATASET, rev: P.get("rev"), path: P.get("path"), job: P.get("job"), trial: P.get("trial"),
  turns: [], robot: [], events: [], t0: null, traj: null, rows: [], hidden: new Set(), query: "",
};
const ROBOT_SRC = { service: "robot service", tooling: "sim tooling, self-reported" };

function fmtRel(sec) {
  if (sec == null || !Number.isFinite(sec)) return "–";
  const s = Math.round(Math.abs(sec)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return `${sec < 0 ? "−" : "+"}${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}`;
}
const clock = (t) => new Date(t * 1000).toLocaleTimeString("en-GB", { hour12: false });
const kb = (s) => (s.length < 1024 ? `${s.length} B` : `${(s.length / 1024).toFixed(1)} kB`);
const pre = (text) => `<pre class="log">${esc(text)}</pre>`;
const status = (html) => { $("#tl-status").innerHTML = html; };

// ---------- the result panel ----------

async function loadTrialRecord() {
  const digest = await getJSON(`data/digest.json?v=${minuteStamp()}`, { optional: true }).catch(() => null);
  if (!P.get("ds") && digest?.dataset && !digest.dataset.startsWith("/")) T.dataset = digest.dataset;
  const key = T.path.split("/").join("__");
  let b = digest?.bundles?.find((x) => x.path === T.path) || null;
  let t = b ? digest.trials.find((x) => x.bundle === b.key && x.job === T.job && x.trial_dir === T.trial) : null;
  let detail = null, others = [];
  if (b && t) {
    detail = (await getJSON(`${b.detail_file}?v=${minuteStamp()}`, { optional: true }).catch(() => null))?.trials?.[`${T.job}/${T.trial}`] || null;
    others = digest.trials.filter((x) => x !== t && x.run_id === t.run_id && x.base === t.base && x.mode === t.mode && x.k === t.k)
      .map((x) => { const ob = digest.bundles.find((y) => y.key === x.bundle) || {}; return { ...x, rev: ob.revision || "main", path: ob.path }; })
      .filter((x) => x.path);
  } else {
    // not digested yet: the delivery's own MANIFEST.md and index.json
    const res = (p) => hfResolveIn(T.dataset, T.rev, `${T.path}/${p}`);
    const man = await getText(res("MANIFEST.md")).then(parseManifest).catch(() => ({ parsed: {}, raw: {} }));
    const idx = await getJSON(res("index.json")).catch(() => ({}));
    const [helper, batch, bundle] = T.path.split("/");
    const runId = idx.run_id || man.parsed.runner?.run_id || null;
    b = { key, helper, batch, bundle, path: T.path, revision: T.rev, run_id: runId, manifest: man.parsed, manifest_fields: man.raw, pending: true };
    t = trialsFromIndex(idx, key, T.path, runId).find((x) => x.job === T.job && x.trial_dir === T.trial) || null;
  }
  return { b, t, detail, others };
}

function renderHeader(b, t) {
  const r = b?.manifest?.runner || {};
  const base = t?.base || T.trial.split("__")[0];
  document.title = `${base.replace(/^roboarc-/, "")} · ${t?.mode || "trial"} — RoboARC Trial Timeline`;
  $("#tl-eyebrow").textContent = `Trial timeline · ${b?.helper || T.path.split("/")[0]} · ${b?.batch || ""}`;
  $("#tl-title").textContent = `${base}${t?.mode ? ` · ${t.mode}` : ""}${t?.k != null ? ` · trial ${t.k}` : ""}`;
  $("#tl-sub").innerHTML = [
    r.agent ? `${esc(r.agent)} + <b>${esc(r.model)}</b>, effort ${esc(r.effort)}` : b?.run_id ? `run id <code>${esc(b.run_id)}</code>` : "",
    t?.seed != null ? `seed ${esc(t.seed)}` : "",
    `<code>${esc(T.trial)}</code>`,
  ].filter(Boolean).join(" · ");
  $("#ds-link").href = `${HF}/datasets/${T.dataset}`;
  $("#ds-link").textContent = T.dataset;
}

function renderSummary(b, t, detail, others) {
  if (!t) {
    $("#summary-body").innerHTML = `<div class="panel empty-state"><b>This trial is not in the delivery's index.</b><span><code>${esc(T.job)}/${esc(T.trial)}</code> in <code>${esc(T.path)}</code> (${esc(T.rev)}).</span></div>`;
    return;
  }
  const st = statusOf(t);
  const tokIn = t.tokens_in ?? T.traj?.final_metrics?.total_prompt_tokens, tokOut = t.tokens_out ?? T.traj?.final_metrics?.total_completion_tokens;
  const cached = T.traj?.final_metrics?.total_cached_tokens;
  const kv = [
    ["Result", `<span class="pill ${st}">${STATUS_LABEL[st]}</span>${t.result_source === "index" ? ` <span class="small muted">(${b.pending ? "from index.json: the delivery is not digested yet" : "from index.json only"})</span>` : ""}`],
    ["Reward", esc(t.reward ?? "–")], ["Reason", esc(t.reason || "–")],
    ["Harbor exception", esc(t.exception_type || (t.exception ? "yes (awaiting digest)" : "none"))],
    ["Wall time", fmtDur(t.wall_s)],
    ["Tokens (in / cached / out)", `${fmtInt(tokIn)} / ${fmtInt(cached)} / ${fmtInt(tokOut)}`],
    ["Cost", t.cost_usd != null ? `$${Number(t.cost_usd).toFixed(2)}` : "–"],
    ["Peak memory / GPU memory", `${typeof t.peak_memory_gb === "number" ? t.peak_memory_gb.toFixed(2) : "–"} GB / ${typeof t.peak_gpu_memory_gb === "number" ? t.peak_gpu_memory_gb.toFixed(2) : "–"} GB`],
    ["OOM or emergency kills", esc(t.oom_kills ?? "–")], ["Harbor exit code", esc(t.harbor_rc ?? "–")],
    ["Other attempts of this trial", others.length ? others.map((o) => `<a href="${esc(timelineHref({ dataset: T.dataset, rev: o.rev, path: o.path, job: o.job, trial: o.trial_dir }))}">${esc(o.result)} · ${esc(abs(o.finished_at || ""))}</a>`).join(", ") : "none"],
  ];
  const archive = hfResolveIn(T.dataset, T.rev, `${T.path}/jobs/${T.job}.tar.gz`);
  let html = `<div class="panel tl-summary"><dl class="kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
    <div class="chips"><a class="btn" href="${esc(archive)}" target="_blank" rel="noopener">Download the job archive</a><a class="btn" href="${esc(hfBlobIn(T.dataset, T.rev, T.path))}" target="_blank" rel="noopener">Open the delivery on Hugging Face</a></div></div>`;
  if (detail) {
    const blocks = [];
    if (detail.exception_message) blocks.push(["Exception (result.json)", pre(detail.exception_message), true]);
    if (detail.exception_tail) blocks.push(["End of exception.txt", pre(detail.exception_tail.join("\n")), true]);
    if (detail.grade_tail && detail.grade_tail.join("").trim()) blocks.push(["End of the grader log, verifier/grade.log", pre(detail.grade_tail.join("\n")), false]);
    if (detail.trial_tail) blocks.push(["End of trial.log", pre(detail.trial_tail.join("\n")), false]);
    if (detail.reward) blocks.push(["Grader fields, verifier/reward.json", pre(JSON.stringify(detail.reward, null, 1)), false]);
    if (detail.resource_limits) blocks.push(["Resource limits, verifier/resource_limits.json", pre(JSON.stringify(detail.resource_limits, null, 1)), false]);
    if (detail.gateway_totals) blocks.push(["Usage gateway, gateway/totals.json", pre(JSON.stringify(detail.gateway_totals, null, 1)), false]);
    html += blocks.map(([h, body, open]) => `<details class="panel tl-rec"${open ? " open" : ""}><summary>${esc(h)}</summary>${body}</details>`).join("");
  } else if (b.pending) {
    html += `<p class="small muted">The exception, the grader log and the resource peaks appear here once the delivery is digested.</p>`;
  }
  $("#summary-body").innerHTML = html;
}

// ---------- the timeline ----------

function hay(e) {
  if (e.hay) return e.hay;
  const parts = e.type === "turn" ? [e.think, e.say, ...e.tools.flatMap((c) => [c.name, c.args, c.output])] : [e.label, e.ev, e.src, e.text];
  return (e.hay = parts.filter(Boolean).join("\n").toLowerCase());
}

function rowHtml(e, i) {
  const time = `<div class="tl-time"><a href="#${e.id}" title="${esc(abs(new Date(e.t * 1000).toISOString()))}">${fmtRel(e.t - T.t0)}</a><span>${clock(e.t)}</span></div>`;
  if (e.type === "robot") {
    return `<div class="tl-row robot${e.good ? " good" : ""}" id="${e.id}" data-i="${i}">${time}<div class="tl-body"><span class="k robot" title="${esc(ROBOT_SRC[e.src])}">${esc(e.src === "service" ? "robot" : "sim")} · ${esc(e.ev)}</span> <span class="robot-text">${esc(e.text)}</span></div></div>`;
  }
  if (e.type === "prompt") {
    return `<div class="tl-row prompt" id="${e.id}" data-i="${i}">${time}<div class="tl-body"><details class="ev" data-i="${i}"><summary><span class="k">${esc(e.label)}</span> <span class="meta">${kb(e.text)}</span></summary><div class="ev-body"></div></details></div></div>`;
  }
  const tools = e.tools.map((c, j) => `<details class="ev tool" data-i="${i}" data-j="${j}"><summary><span class="k">${esc(c.name)}</span> <code>${esc(c.summary)}</code>
    <span class="meta">${[!c.answered ? "no output" : c.output.replace(/\[image\]/g, "").trim() ? `output ${kb(c.output)}` : "", c.images ? `${c.images} image${c.images > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ")}</span></summary><div class="ev-body"></div></details>`).join("");
  const tk = e.tokens ? `<div class="tok">context ${fmtInt(e.tokens.in)} tokens${e.tokens.cached != null ? ` (${fmtInt(e.tokens.cached)} cached)` : ""} · wrote ${fmtInt(e.tokens.out)}${e.tokens.reasoning ? ` (${fmtInt(e.tokens.reasoning)} reasoning)` : ""}</div>` : "";
  return `<article class="tl-row turn" id="${e.id}" data-i="${i}">${time}<div class="tl-body">
    ${e.think ? `<div class="ev think"><span class="k">thinking</span><div class="txt clamp" title="click to show it all">${esc(e.think)}</div></div>` : ""}
    ${e.say ? `<div class="ev say"><span class="k">says</span><div class="txt">${esc(e.say)}</div></div>` : ""}
    ${tools}${tk}</div></article>`;
}

function fillDetails(d) {
  const body = d.querySelector(".ev-body");
  if (!body || body.dataset.filled) return;
  const e = T.events[+d.dataset.i];
  if (e.type === "prompt") body.innerHTML = pre(e.text);
  else {
    const c = e.tools[+d.dataset.j];
    body.innerHTML = (c.args ? `<div class="small muted">${esc(c.name)} input</div>${pre(c.args)}` : "")
      + `<div class="small muted">output${c.images ? ` (${c.images} image${c.images > 1 ? "s" : ""} left out)` : ""}</div>${c.answered ? pre(c.output || "(empty)") : `<p class="small faint">No output recorded for this call.</p>`}`;
  }
  body.dataset.filled = "1";
}

function renderStats() {
  const turns = T.turns.filter((e) => e.type === "turn"), tools = turns.flatMap((e) => e.tools);
  const byName = Object.entries(tools.reduce((a, c) => ((a[c.name] = (a[c.name] || 0) + 1), a), {})).sort((a, b) => b[1] - a[1]);
  const images = tools.reduce((a, c) => a + c.images, 0);
  const rob = T.robot.reduce((a, e) => { const k = `${e.src === "service" ? "robot" : "sim"} ${e.ev}`; a[k] = (a[k] || 0) + 1; return a; }, {});
  const span = turns.length ? turns[turns.length - 1].t - turns[0].t : null;
  const fm = T.traj?.final_metrics || {};
  const chips = [
    span != null ? `agent active ${fmtDur(span)}` : "", `${turns.length} model turns`, `${tools.length} tool calls`,
    ...byName.slice(0, 5).map(([n, k]) => `${esc(n)} × ${k}`), images ? `${images} image${images > 1 ? "s" : ""} viewed` : "",
    ...Object.entries(rob).filter(([k]) => ["submit", "observe", "reset", "record", "checkpoint"].includes(k.split(" ")[1])).map(([k, n]) => `${esc(k)} × ${n}`),
    fm.total_prompt_tokens != null ? `${fmtInt(fm.total_prompt_tokens)} tokens in, ${fmtInt(fm.total_completion_tokens)} out` : "",
    T.traj?.agent ? `${esc(T.traj.agent.name)} ${esc(T.traj.agent.version || "")}` : "",
  ].filter(Boolean);
  $("#tl-stats").innerHTML = chips.map((c) => `<span class="chip">${c}</span>`).join("");
}

function renderStrip() {
  const ev = T.events;
  if (!ev.length) { $("#tl-strip").innerHTML = ""; return; }
  const a = ev[0].t, z = ev[ev.length - 1].t, span = Math.max(60, z - a);
  const n = Math.min(240, Math.max(12, Math.ceil(span / 60))), w = span / n;
  const agent = new Array(n).fill(0), robot = new Array(n).fill(0);
  for (const e of ev) {
    const k = Math.min(n - 1, Math.floor((e.t - a) / w));
    if (e.type === "turn") agent[k] += e.tools.length || 1;
    else if (e.type === "robot" && (e.ev === "submit" || e.ev === "reset" || e.ev === "record")) robot[k]++;
  }
  // square-root heights: a burst of robot actions does not flatten the rest of the strip
  const max = Math.max(1, ...agent.map((x, i) => x + robot[i]));
  $("#tl-strip").innerHTML = agent.map((x, i) => {
    const from = a + i * w, sum = x + robot[i], h = sum ? 100 * Math.sqrt(sum / max) : 0;
    return `<button type="button" class="tl-bin" data-t="${from}" title="${fmtRel(from - T.t0)} to ${fmtRel(from + w - T.t0)}: ${x} commands, ${robot[i]} robot actions">
      <span class="bar-r" style="height:${sum ? (h * robot[i]) / sum : 0}%"></span><span class="bar-a" style="height:${sum ? (h * x) / sum : 0}%"></span></button>`;
  }).join("");
  $("#tl-strip-range").textContent = `${fmtRel(a - T.t0)} → ${fmtRel(z - T.t0)} (${clock(a)} → ${clock(z)})`;
}

function renderList() {
  T.events.forEach((e, i) => { e.id = e.type === "turn" || e.type === "prompt" ? `s${e.step}` : `r${i}`; });
  $("#tl-list").innerHTML = T.events.length ? T.events.map(rowHtml).join("")
    : `<div class="panel empty-state"><b>No timeline in this trial's archive.</b><span>It has no <code>agent/trajectory.json</code> (Harbor writes it for its installed agents) and no robot record. Its raw logs are in the job archive.</span></div>`;
  T.rows = [...$("#tl-list").querySelectorAll(".tl-row")];
  applyFilter();
}

function merge() {
  T.events = [...T.turns, ...T.robot].sort((a, b) => a.t - b.t || (a.type === "robot") - (b.type === "robot"));
  T.t0 = T.turns.length ? Math.min(...T.turns.map((e) => e.t)) : T.events[0]?.t ?? null;
  // a row keeps its open state when the robot's record arrives after the agent's turns were drawn
  const open = new Set([...document.querySelectorAll("#tl-list details[open]")].map((d) => `${d.closest(".tl-row")?.id}|${d.dataset.j ?? ""}`));
  renderStats(); renderStrip(); renderList();
  for (const d of document.querySelectorAll("#tl-list details")) {
    if (open.has(`${d.closest(".tl-row")?.id}|${d.dataset.j ?? ""}`)) { fillDetails(d); d.open = true; }
  }
}

function applyFilter() {
  const list = $("#tl-list");
  for (const k of ["think", "say", "tool", "robot", "prompt"]) list.classList.toggle(`hide-${k}`, T.hidden.has(k));
  const q = T.query;
  let shown = 0;
  for (const el of T.rows) {
    const e = T.events[+el.dataset.i];
    const kindHidden = (e.type === "robot" && T.hidden.has("robot")) || (e.type === "prompt" && T.hidden.has("prompt"))
      || (e.type === "turn" && ["think", "say", "tool"].every((k) => T.hidden.has(k) || !(k === "tool" ? e.tools.length : e[k])));
    const match = !q || hay(e).includes(q);
    el.hidden = kindHidden || !match;
    if (!el.hidden) shown++;
  }
  $("#tl-count").textContent = T.rows.length ? `${shown} of ${T.rows.length} rows` : "";
}

function jumpTo(t) {
  const el = T.rows.find((r) => !r.hidden && T.events[+r.dataset.i].t >= t) || T.rows.filter((r) => !r.hidden).pop();
  if (!el) return;
  el.scrollIntoView({ block: "start", behavior: "smooth" });
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 1600);
}

function wire() {
  document.querySelectorAll(".tl-filters [data-kind]").forEach((cb) => cb.addEventListener("change", () => {
    cb.checked ? T.hidden.delete(cb.dataset.kind) : T.hidden.add(cb.dataset.kind);
    applyFilter();
  }));
  let timer = null;
  $("#tl-search").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { T.query = e.target.value.trim().toLowerCase(); applyFilter(); }, 150);
  });
  $("#tl-expand").addEventListener("click", (e) => {
    const open = e.currentTarget.textContent === "Expand all";
    for (const d of document.querySelectorAll("#tl-list .tl-row:not([hidden]) details")) { if (open) fillDetails(d); d.open = open; }
    document.querySelectorAll("#tl-list .txt.clamp, #tl-list .txt.unclamped").forEach((x) => { x.classList.toggle("clamp", !open); x.classList.toggle("unclamped", open); });
    e.currentTarget.textContent = open ? "Collapse all" : "Expand all";
  });
  $("#tl-list").addEventListener("toggle", (e) => { if (e.target.matches("details") && e.target.open) fillDetails(e.target); }, true);
  $("#tl-list").addEventListener("click", (e) => {
    const x = e.target.closest(".txt.clamp, .txt.unclamped");
    if (x && !getSelection().toString()) { x.classList.toggle("clamp"); x.classList.toggle("unclamped"); }
  });
  $("#tl-strip").addEventListener("click", (e) => { const b = e.target.closest(".tl-bin"); if (b) jumpTo(+b.dataset.t); });
}

const WANT = {
  "agent/trajectory.json": "trajectory",
  "artifacts/data/episode.jsonl": "episode",
  "agent/rcb_session_log.jsonl": "session",
  "artifacts/app/output/rcb_session_log.jsonl": "session_copy",
};
const LAST = "artifacts/data/episode.jsonl";     // the archive is sorted by name: nothing wanted comes after it

async function loadTimeline() {
  const marker = `/${T.job}/${T.trial}/`;
  const relOf = (name) => { const i = name.indexOf(marker); return i < 0 ? null : name.slice(i + marker.length); };
  let inside = false, gotTraj = false, gotSession = false;
  const url = hfResolveIn(T.dataset, T.rev, `${T.path}/jobs/${T.job}.tar.gz`);
  const dec = new TextDecoder();
  const read = await untarGz(url, {
    want: (name, size) => { const r = relOf(name); return r in WANT && size <= (256 << 20); },
    stop: (name) => {
      const r = relOf(name);
      if (r != null) { inside = true; return r > LAST; }
      return inside;                       // past this trial's directory
    },
    onFile: async (name, bytes) => {
      const what = WANT[relOf(name)];
      if (what === "trajectory") {
        status(`<span><span class="dot live"></span>Read the agent's turns; reading the robot's record…</span>`);
        try { T.traj = JSON.parse(dec.decode(bytes)); } catch (e) { T.traj = null; status(`<span><span class="dot err"></span>agent/trajectory.json could not be read: ${esc(e.message)}</span>`); }
        T.turns = atifEvents(T.traj);
        gotTraj = true;
        merge();
        if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "start" });
      } else if (what === "episode") {
        T.robot = [...T.robot.filter((e) => e.src !== "service"), ...robotEvents(dec.decode(bytes), "service")];
        merge();
      } else if ((what === "session" || (what === "session_copy" && !gotSession))) {
        gotSession = true;
        T.robot = [...T.robot.filter((e) => e.src !== "tooling"), ...robotEvents(dec.decode(bytes), "tooling")];
        merge();
      }
    },
    onProgress: (n) => { if (!gotTraj) status(`<span><span class="dot"></span>Reading the job archive… ${(n / 1048576).toFixed(0)} MB unpacked</span>`); },
  });
  if (!gotTraj && !T.robot.length) merge();
  status(`<span><span class="dot live"></span>${gotTraj ? `${T.turns.filter((e) => e.type === "turn").length} model turns` : "no agent/trajectory.json"}, ${T.robot.length} robot events; read the first ${(read / 1048576).toFixed(0)} MB of the job archive (unpacked)</span>`);
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "start" });
}

async function start() {
  if (!T.rev || !T.path || !T.job || !T.trial) {
    $("#tl-title").textContent = "No trial named";
    status(`<span><span class="dot err"></span>Open a trial from the progress page: this page needs <code>rev</code>, <code>path</code>, <code>job</code> and <code>trial</code>.</span>`);
    $("#tl-list").innerHTML = "";
    return;
  }
  wire();
  const rec = await loadTrialRecord().catch((e) => { status(`<span><span class="dot err"></span>Could not read the delivery: ${esc(e.message)}</span>`); return null; });
  if (rec) { renderHeader(rec.b, rec.t); renderSummary(rec.b, rec.t, rec.detail, rec.others); }
  else renderHeader(null, null);
  try {
    await loadTimeline();
  } catch (e) {
    console.error(e);
    status(`<span><span class="dot err"></span>Could not read the job archive: ${esc(e.message)}</span>`);
    if (!T.events.length) $("#tl-list").innerHTML = `<div class="panel empty-state"><b>The job archive could not be read.</b><span>${esc(e.message)}. Download it from the result panel and open it yourself.</span></div>`;
  }
  if (rec) renderSummary(rec.b, rec.t, rec.detail, rec.others);    // the tokens from the trajectory, once read
}

if (typeof document !== "undefined") start();
