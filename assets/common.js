// Shared by the progress page (app.js) and the trial timeline (timeline.js): formatting, fetching, and the reading of a
// bundle's MANIFEST.md and index.json, or of a delivery of loose files: the runner's folders, or Harbor's own job folders
// (the same reading as tools/digest.py).

export const HF = "https://huggingface.co";
export const DEFAULT_DATASET = "RoboARC/RoboARC-outputs";
export const STATUS_LABEL = { ok: "success", fail: "fail", void: "not a result", wait: "awaiting digest", empty: "not run" };

// ---------- helpers ----------

export const $ = (sel) => document.querySelector(sel);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const fmtInt = (n) => (n == null ? "–" : Number(n).toLocaleString("en-US"));
export const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "–");
export const median = (xs) => {
  if (!xs || !xs.length) return null;
  const a = [...xs].sort((x, y) => x - y), m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
export function fmtDur(sec) {
  if (sec == null || !Number.isFinite(sec)) return "–";
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  if (sec < 48 * 3600) return `${(sec / 3600).toFixed(1)} h`;
  return `${(sec / 86400).toFixed(1)} days`;
}
export const fmtDays = (sec) => (sec == null || !Number.isFinite(sec) ? "–" : `${(sec / 86400).toFixed(1)} d`);
export const fmtDate = (ms) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
export const minuteStamp = () => Math.floor(Date.now() / 60000);

export function rel(iso) {
  if (!iso) return "–";
  const t = new Date(String(iso).replace(" ", "T")).getTime();
  if (Number.isNaN(t)) return esc(iso);
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
export function abs(iso) {
  if (!iso) return "";
  const d = new Date(String(iso).replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString("en-US", { hour12: false });
}
export const when = (iso) => `<span title="${esc(abs(iso))}">${rel(iso)}</span>`;

export async function getJSON(url, { optional = false } = {}) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) {
    if (optional && r.status === 404) return null;
    throw new Error(`${r.status} ${url}`);
  }
  return r.json();
}
export async function getText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}
export const encRev = (rev) => encodeURIComponent(rev);
export const encPath = (p) => p.split("/").map(encodeURIComponent).join("/");
export const hfResolveIn = (dataset, rev, path) => `${HF}/datasets/${dataset}/resolve/${encRev(rev)}/${encPath(path)}`;
export const hfBlobIn = (dataset, rev, path) => `${HF}/datasets/${dataset}/tree/${encRev(rev)}/${encPath(path)}`;

export function statusOf(t) {
  if (t.result === "success") return "ok";
  if (t.result === "fail") return "fail";
  if (t.result === "pending") return "wait";
  return "void";       // not_a_result, no_verdict
}

// The timeline page of one trial: the bundle's revision and path in the dataset, the job and the trial directory.
export function timelineHref({ dataset, rev, path, job, trial }) {
  const q = new URLSearchParams({ rev, path, job, trial });
  if (dataset && dataset !== DEFAULT_DATASET) q.set("ds", dataset);
  return `timeline.html?${q}`;
}

// ---------- the MANIFEST.md and index.json of a bundle (same reading as tools/digest.py) ----------

export function parseManifest(text) {
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
    .filter((p) => p.length >= 3).map((p) => ({ index: p[0], name: p[1], driver: p[2], memory_mib: +(p[3] || "").match(/^(\d+) MiB$/)?.[1] || null }));
  const r = (raw.runner || "").match(/runner (\d+): (\S+) (\S+) effort (\S+), run id (\S+), modes ([^,]+), web search (\w+)(?:, usage gateway ([^,]+))?(?:, (GPUs [0-9,]+ \(.*\)|GPU scheduling off))?/);
  if (r) out.runner = { pid: r[1], agent: r[2], model: r[3], effort: r[4], run_id: r[5], modes: r[6].split(/\s+/), web_search: r[7], usage_gateway: (r[8] || "off").trim(), gpu_placement: r[9] || null };
  const t = (raw.trials || "").match(/planned jobs (\S+), trial dirs (\S+), with a verdict (\S+)/);
  if (t) out.trials = { planned_jobs: t[1], trial_dirs: t[2], with_verdict: t[3] };
  const k = (raw.seeds || "").match(/K = (\d+)/);
  if (k) out.K = +k[1];
  return { parsed: out, raw };
}

export function trialsFromIndex(idx, key, path, runId) {
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

// ---------- a delivery of loose files: the runner's jobs/ and results/ folders, no send_results.sh ----------

// {path under <path>: size} of every file under <path>, following the listing's pages.
export async function listFiles(dataset, rev, path) {
  const out = {};
  let url = `${HF}/api/datasets/${dataset}/tree/${encRev(rev)}/${encPath(path)}?recursive=true&limit=1000`;
  while (url) {
    const r = await fetch(url, { cache: "no-store" });
    if (r.status === 404) break;
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    for (const e of await r.json()) if (e.type === "file") out[e.path.slice(path.length + 1)] = e.size || 0;
    url = (r.headers.get("Link") || "").match(/<([^>]+)>;\s*rel="next"/)?.[1] || null;
  }
  return out;
}

// A delivery whose files are loose, read file by file (no job archives): the runner's folders or Harbor's job folders.
export const filesLoose = (b) => b?.layout === "loose" || b?.layout === "harbor";

// The run settings (the batch logs' runner line and the plans), one trial per trial directory (awaiting digest) and
// what REDACTION.json says, as tools/digest.py reads them; for Harbor's own job folders, readHarbor; null when <path> is
// neither.
export async function readLoose(dataset, rev, path, key) {
  const files = await listFiles(dataset, rev, path);
  const names = Object.keys(files);
  if ("batch.tar.gz" in files) return null;
  if (!names.some((n) => n.startsWith("jobs/"))) {
    const dirs = harborJobDirs(files);
    return Object.keys(dirs).length ? readHarbor(dataset, rev, path, key, files, dirs) : null;
  }
  const read = (n) => (n in files ? getText(hfResolveIn(dataset, rev, `${path}/${n}`)).catch(() => null) : Promise.resolve(null));
  const json = async (n) => { try { return JSON.parse(await read(n)); } catch { return null; } };
  const plans = Object.fromEntries(await Promise.all(names.filter((n) => /^jobs\/\.plan\/[^/]+\.json$/.test(n))
    .map(async (n) => [n.slice("jobs/.plan/".length, -5), (await json(n)) || {}])));
  const logged = names.filter((n) => /^jobs\/[^/]+\.log$/.test(n) && `jobs/${n.slice(5, -4)}.summary.md` in files).map((n) => n.slice(5, -4));
  const batches = [...new Set([...Object.keys(plans), ...logged])].sort();
  const [red, ...logs] = await Promise.all([json("REDACTION.json"), ...batches.map((bt) => read(`jobs/${bt}.log`))]);
  // the runner line and, from runners since 2026-10-28, the machine: host:, GPUs:, software: (the first of each)
  const first = (key) => logs.map((t) => (t || "").match(new RegExp(`^\\[[^\\]]+\\] (${key}: .*)$`, "m"))?.[1]).find(Boolean);
  const man = parseManifest(["runner \\d+", "host", "GPUs", "software"].map(first).filter(Boolean)
    .map((l) => (l.startsWith("runner ") ? `runner: ${l}` : l)).join("\n"));
  const ks = Object.values(plans).map((p) => p.trials).filter(Number.isInteger);
  if (ks.length) man.parsed.K = Math.max(...ks);
  const runId = Object.values(plans).find((p) => p.run_id)?.run_id || man.parsed.runner?.run_id || null;
  const trials = [];
  for (const bt of batches) {
    const planned = {};
    for (const p of plans[bt]?.jobs || []) (planned[p.job] ||= []).push(p);
    const ofBatch = Object.keys(planned).length ? (j) => j in planned : (j) => j.startsWith(`${bt}-`);
    const dirs = {};   // job -> its trial directories: jobs/<job>/<trial>/...
    for (const n of names) {
      const parts = n.split("/");
      if (parts.length >= 4 && parts[0] === "jobs" && ofBatch(parts[1])) (dirs[parts[1]] ||= new Set()).add(parts[2]);
    }
    for (const [job, ds] of Object.entries(dirs)) for (const d of [...ds].sort()) {
      const p = planned[job]?.length === 1 ? planned[job][0] : {};
      trials.push({
        bundle: key, job, trial_dir: d, base: (p.task || "").replace(/-(privileged|standard|standard-realtime)$/, "") || null,
        mode: p.mode || null, k: p.trial ?? null, seed: p.seed ?? null, run_id: runId, reward: null,
        exception: `jobs/${job}/${d}/exception.txt` in files, result: "pending", result_source: "index",
        archive: `${path}/jobs/${job}/${d}/`, live: true,
      });
    }
  }
  man.parsed.trials = {
    planned_jobs: Object.keys(plans).length ? Object.values(plans).reduce((a, p) => a + (p.jobs || []).length, 0) : "?",
    trial_dirs: trials.length, with_verdict: trials.filter((t) => `jobs/${t.job}/${t.trial_dir}/verifier/reward.json` in files).length,
  };
  const redaction = red && typeof red === "object"
    ? Object.fromEntries(["notice", "sanitized_copy", "official", "provider_alias"].filter((k) => k in red).map((k) => [k, red[k]])) : null;
  return { layout: "loose", man, runId, trials, batches, official: red?.official ?? null, redaction, hardware: man.parsed.host || man.parsed.gpus.length ? "batch log" : null };
}

// ---------- a delivery of Harbor's own output (harbor run, without RoboARC's runner) ----------

export const HARBOR_UNOFFICIAL = "Harbor's own output (harbor run) without RoboARC's runner: no batch plan, no seeds drawn by "
  + "the runner and no official results";
// the agent options shown with their values; any other option is named only (it may carry a credential)
const HARBOR_KWARGS = ["version", "reasoning_effort", "web_search", "max_turns", "max_budget_usd"];

// {job folder: its trial folders}: the job folder is the delivery itself ("") or a folder in it ("<job>/"). A job folder
// has Harbor's config.json and trial folders, each with its own config.json and a result.json or trial.log.
export function harborJobDirs(files) {
  const names = Object.keys(files), out = {};
  const tops = [...new Set(names.filter((n) => n.includes("/")).map((n) => `${n.split("/")[0]}/`))].sort();
  for (const pre of ["", ...tops]) {
    if (!(`${pre}config.json` in files)) continue;
    const subs = new Set(names.filter((n) => n.startsWith(pre) && n.slice(pre.length).includes("/")).map((n) => n.slice(pre.length).split("/")[0]));
    const trials = [...subs].filter((t) => `${pre}${t}/config.json` in files && (`${pre}${t}/result.json` in files || `${pre}${t}/trial.log` in files)).sort();
    if (trials.length) out[pre] = trials;
  }
  return out;
}

// The run id RoboARC's runner gives these settings (D4, scripts/harbor/run_agent_batch.sh): <harness>-<model>-<effort>.
export function runIdOf(agent, model, effort) {
  const f = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const m = model.split("/").pop().toLowerCase().replace(/^claude-/, "").replace(/^gpt-(\d+)/, "gpt$1");
  return `${f(agent)}-${f(m)}-${f(effort || "default")}`;
}

// The run settings from each job's config.json and one trial per trial folder (awaiting digest), as tools/digest.py
// gather_harbor reads them. Unofficial: no plan, seeds or official results.
async function readHarbor(dataset, rev, path, key, files, dirs) {
  const settings = await Promise.all(Object.entries(dirs).map(async ([pre, ts]) => {
    let c = {};
    try { c = JSON.parse(await getText(hfResolveIn(dataset, rev, `${path}/${pre}config.json`))) || {}; } catch { c = {}; }
    const agent = (Array.isArray(c.agents) && c.agents[0]) || {}, kw = agent.kwargs || {};
    return { job: c.job_name || pre.replace(/\/$/, "") || path.split("/")[1], pre, folder: pre || "./", agent: agent.name, model: agent.model_name,
      options: Object.fromEntries(HARBOR_KWARGS.filter((k) => k in kw).map((k) => [k, kw[k]])),
      other_options: Object.keys(kw).filter((k) => !HARBOR_KWARGS.includes(k)).sort(),
      tasks: (c.datasets || []).flatMap((d) => d.task_names || []), trial_dirs: ts.length, ts };
  }));
  const first = settings[0], effort = first.options.reasoning_effort;
  const runId = first.agent && first.model ? runIdOf(first.agent, first.model, effort) : null;
  const MODE = /-(privileged|standard-realtime|standard)$/;
  const trials = settings.flatMap((s) => s.ts.map((d) => {
    const task = s.tasks.length === 1 ? s.tasks[0] : "";   // a job of several tasks: each trial's is in its result.json (digest)
    return { bundle: key, job: s.job, trial_dir: d, base: task.replace(MODE, "") || null, mode: task.match(MODE)?.[1] || null,
      k: null, seed: null, run_id: runId, reward: null, exception: `${s.pre}${d}/exception.txt` in files, result: "pending",
      result_source: "index", archive: `${path}/${s.pre}${d}/`, live: true };
  }));
  const parsed = { gpus: [], runner: {
    agent: first.agent, model: first.model, effort: effort || "default", run_id: runId,
    modes: [...new Set(settings.flatMap((s) => s.tasks.map((t) => t.match(MODE)?.[1]).filter(Boolean)))].sort(),
    web_search: first.options.web_search || "–",
    usage_gateway: Object.keys(files).some((n) => n.endsWith("/gateway/totals.json")) ? "on (the trials' gateway/ records)" : "off",
    gpu_placement: "none (no RoboARC runner)" },
    trials: { planned_jobs: settings.length, trial_dirs: trials.length,
      with_verdict: trials.filter((t) => `${t.archive.slice(path.length + 1)}verifier/reward.json` in files).length } };
  return { layout: "harbor", man: { parsed, raw: {} }, runId, trials, batches: [], official: false, redaction: null,
    unofficial_reason: HARBOR_UNOFFICIAL, harbor_jobs: settings.map(({ pre, ts, ...s }) => s), hardware: null };
}
