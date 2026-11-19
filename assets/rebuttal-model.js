// The rebuttal page's model (rebuttal.html): every delivered trial placed in its experiment, repeat, task, condition and
// mode, against the plan (data/rebuttal/plan.json); the step-1 variant checks; the main evaluation's results of the same
// tasks for reference. No DOM: tools/test_rebuttal_model.mjs runs it in node.

import { statusOf } from "./common.js";

export const CHECKS_BATCH = "rebuttal-checks";
const BATCH_RUN = /^rebuttal-(e\d+)-r(\d+)$/;
const BATCH_SMOKE = /^rebuttal-smoke-(e\d+)$/;
export const STATES = ["ok", "fail", "void", "wait", "empty"];
const zero = () => ({ ok: 0, fail: 0, void: 0, wait: 0, empty: 0, total: 0 });

// what a delivery's batch is: a repeat of an experiment, its smoke, the variant checks, or something else
export function batchKind(batch) {
  let m = BATCH_RUN.exec(batch || "");
  if (m) return { kind: "run", exp: m[1].toUpperCase(), repeat: +m[2] };
  m = BATCH_SMOKE.exec(batch || "");
  if (m) return { kind: "smoke", exp: m[1].toUpperCase(), repeat: 0 };
  return { kind: batch === CHECKS_BATCH ? "checks" : "other", exp: null, repeat: null };
}

// a variant's base task and condition: the trial's base (its task without the mode) is <base>-<token>
export function splitVariant(exp, base) {
  for (const c of exp?.conditions || []) {
    if (base && base.endsWith(`-${c.token}`)) return { base0: base.slice(0, -(c.token.length + 1)), token: c.token };
  }
  return { base0: base || null, token: null };
}

export const slotKey = (kind, exp, repeat, base, token, mode) => `${kind}|${exp}|${repeat}|${base}|${token}|${mode}`;

// The planned variants of an experiment: one per base, condition and mode.
export function variantsOf(e) {
  const out = [];
  for (const base of e.bases) for (const c of e.conditions) for (const mode of e.modes) out.push({ base, token: c.token, label: c.label, mode });
  return out;
}

// What does not match the experiment's plan or its fixed settings (docs/REBUTTAL_EXPERIMENTS.md, section 9).
function flagsOf(t, e) {
  const f = [];
  if (!e) return f;
  if (!t.token) f.push("condition not in the plan");
  else if (!e.bases.includes(t.base0)) f.push("task not in the plan");
  if (t.mode && !e.modes.includes(t.mode)) f.push(`mode ${t.mode} not in the plan`);
  if (t.run_id && t.run_id !== e.run_id) f.push(`run id ${t.run_id}, planned ${e.run_id}`);
  if (t.effort && t.effort !== e.effort) f.push(`effort ${t.effort}, planned ${e.effort}`);
  if (t.seed != null && t.seed !== 0) f.push(`seed ${t.seed}, planned 0`);
  return f;
}

// plan: data/rebuttal/plan.json; digest: data/rebuttal/digest.json; live: the deliveries not digested yet (as the progress
// page reads them: {bundles, trials, listed}); unofficial: data/unofficial.json bundles.
export function buildModel({ plan, digest, live, unofficial = {} }) {
  const exps = Object.fromEntries(plan.experiments.map((e) => [e.id, e]));
  const listed = live?.listed ? new Set(live.listed) : null;
  const digestB = (digest?.bundles || []).map((b) => ({ ...b, pending: false, gone: listed ? !listed.has(b.key) : false }));
  const bundles = [...(live?.bundles || []), ...digestB].map((b) => ({
    ...b, ...batchKind(b.batch), unofficial: b.official === false || Boolean(unofficial[b.key]),
  })).sort((a, b) => String(b.uploaded_at || "").localeCompare(String(a.uploaded_at || "")));
  const bmap = Object.fromEntries(bundles.map((b) => [b.key, b]));

  const trials = [...(digest?.trials || []), ...(live?.trials || [])].filter((t) => bmap[t.bundle] && !bmap[t.bundle].gone).map((t) => {
    const b = bmap[t.bundle], e = exps[b.exp];
    const v = e ? splitVariant(e, t.base) : { base0: t.base, token: null };
    const x = { ...t, kind: b.kind, exp: b.exp, repeat: b.repeat, ...v, status: statusOf(t), when: t.finished_at || b.uploaded_at || "", unofficial: b.unofficial };
    x.cond = e?.conditions.find((c) => c.token === x.token)?.label || null;
    x.flags = b.kind === "run" || b.kind === "smoke" ? flagsOf(x, e) : [];
    return x;
  });
  // send_results.sh packs every job of the batch each time: a trial (helper, job, trial directory) counts once, from the
  // latest delivery that has it
  const newest = {};
  const idOf = (t) => (t.job && t.trial_dir ? `${bmap[t.bundle]?.helper}|${t.job}|${t.trial_dir}` : null);
  const age = (t) => `${bmap[t.bundle]?.uploaded_at || ""}|${t.bundle}`;
  for (const t of trials) { const k = idOf(t); if (k && (!newest[k] || age(t) > age(newest[k]))) newest[k] = t; }
  const latest = trials.filter((t) => !idOf(t) || newest[idOf(t)] === t);

  // slot -> its attempts in time order; the result is the last attempt with a result (success or fail), else the last one
  const slots = {};
  for (const t of [...latest].sort((a, b) => String(a.when).localeCompare(String(b.when)))) {
    if ((t.kind !== "run" && t.kind !== "smoke") || t.unofficial || !t.token || !t.mode) continue;
    (slots[slotKey(t.kind, t.exp, t.repeat, t.base0, t.token, t.mode)] ||= { attempts: [] }).attempts.push(t);
  }
  for (const s of Object.values(slots)) {
    const counted = s.attempts.filter((t) => t.status === "ok" || t.status === "fail");
    s.final = counted.length ? counted[counted.length - 1] : s.attempts[s.attempts.length - 1];
    s.n = Math.max(s.attempts.length, ...s.attempts.map((t) => t.attempts || 1));
  }
  const stateOf = (key) => slots[key]?.final.status || "empty";

  const experiments = plan.experiments.map((e) => {
    const vs = variantsOf(e);
    const x = { id: e.id, plan: e, counts: zero(), conds: [], batches: [], smoke: null };
    const byCond = {};
    for (const c of e.conditions) for (const mode of e.modes) {
      byCond[`${c.token}|${mode}`] = { token: c.token, label: c.label, mode, counts: zero(), repeats: Array.from({ length: e.repeats }, zero) };
    }
    for (let r = 1; r <= e.repeats; r++) {
      const bt = { batch: e.batches[r - 1], repeat: r, planned: vs.length, delivered: 0, counts: zero() };
      for (const v of vs) {
        const key = slotKey("run", e.id, r, v.base, v.token, v.mode);
        const st = stateOf(key);
        if (slots[key]) bt.delivered++;
        for (const c of [x.counts, bt.counts, byCond[`${v.token}|${v.mode}`].counts, byCond[`${v.token}|${v.mode}`].repeats[r - 1]]) { c[st]++; c.total++; }
      }
      x.batches.push(bt);
    }
    x.conds = Object.values(byCond);
    // the smoke: one trial of each variant of the experiment's first task
    const rows = vs.filter((v) => v.base === e.smoke_base).map((v) => {
      const s = slots[slotKey("smoke", e.id, 0, v.base, v.token, v.mode)];
      return { ...v, slot: s || null, status: s?.final.status || "empty" };
    });
    x.smoke = { batch: e.smoke_batch, rows, counts: zero() };
    for (const r of rows) { x.smoke.counts[r.status]++; x.smoke.counts.total++; }
    return x;
  });
  const total = zero();
  for (const x of experiments) for (const k of [...STATES, "total"]) total[k] += x.counts[k];
  return { exps, bundles, bmap, trials, latest, slots, experiments, total };
}

// The rows of the errors table: trials that are not a result, have a Harbor exception (other than the agent's own time
// limit), ran more than once, or do not match the plan.
export function problemRows(M) {
  const rerun = new Set();
  for (const s of Object.values(M.slots)) if (s.n > 1) s.attempts.forEach((t) => rerun.add(t));
  const rows = [];
  for (const t of M.latest) {
    if (t.kind !== "run" && t.kind !== "smoke") continue;
    const kinds = [];
    if (t.status === "void") kinds.push(t.result === "no_verdict" ? "no_verdict" : "void");
    if ((t.exception || t.exception_type) && !(t.status === "fail" && t.exception_type === "AgentTimeoutError")) kinds.push("exception");
    if (rerun.has(t) || (t.attempts || 1) > 1) kinds.push("rerun");
    if (t.flags.length) kinds.push("plan");
    if (kinds.length) rows.push({ t, kinds });
  }
  return rows.sort((a, b) => String(b.t.when).localeCompare(String(a.t.when)));
}

// ---------- step 1: the variant check reports (<helper>/rebuttal-checks/<UTC time>/E<n>.json) ----------

const digestOk = (v) => Boolean(v.exists && v.digest === v.digest_file && (v.digest_locked == null || v.digest_locked === v.digest));

// why a variant did not pass, as scripts/rebuttal/check_variants.py judges it
export function variantProblems(v) {
  const why = [];
  if (!digestOk(v)) why.push(v.exists ? "DIGEST not as locked" : "variant missing");
  for (const a of ["oracle", "nop"]) {
    const r = v[a];
    if (!r) { why.push(`${a}: not run`); continue; }
    if (!r.pass) why.push(`${a}: reward ${r.reward ?? "none"}${r.why?.length ? ` (${r.why.join(", ")})` : ""}${r.rc ? `, harbor exit ${r.rc}` : ""}`);
  }
  if (v.extra && !v.extra.pass) why.push(`own check ${v.extra.script || ""} failed (exit ${v.extra.rc})`);
  return why;
}

// checks: [{key, helper, id, rev, label, path, uploaded_at, reports: {E1: report, ...}}]; per experiment the latest report
// (by its UTC id) and how many were sent
export function checkSummary(plan, checks) {
  const out = {};
  for (const e of plan.experiments) {
    const sent = checks.filter((c) => c.reports?.[e.id]).sort((a, b) => String(b.id).localeCompare(String(a.id)));
    const c = sent[0];
    if (!c) { out[e.id] = { sent: 0, expected: variantsOf(e).length }; continue; }
    const r = c.reports[e.id], env = r.environment || {};
    const variants = r.variants || [];
    out[e.id] = {
      sent: sent.length, expected: variantsOf(e).length, check: c, report: r,
      all_pass: Boolean(r.all_pass), n_pass: r.n_pass ?? variants.filter((v) => v.pass).length, n_variants: r.n_variants ?? variants.length,
      render: env.render || null, commit: env.commit || null, branch: env.branch || null, harbor: env.harbor || null,
      local_changes: Boolean(env.local_changes), updated: r.updated || null,
      own: variants.filter((v) => v.extra).length, own_pass: variants.filter((v) => v.extra?.pass).length,
      oracle_skipped: variants.filter((v) => v.oracle?.skipped).length,
      failed: variants.filter((v) => !v.pass).map((v) => ({ task: v.task, label: v.label, mode: v.mode, why: variantProblems(v) })),
      exp_checks: Object.entries(r.experiment_checks || {}).map(([name, x]) => ({ name, pass: Boolean(x.pass), rc: x.rc })),
    };
  }
  return out;
}

// ---------- the main evaluation's results of the same tasks, for reference ----------

// Per experiment, the main evaluation's trials of the experiment's harness and model (any effort: the run id without its
// last part) on its bases at seed 0, per base and mode: the last trial with a result, else the last one.
export function buildReference(plan, mainDigest, unofficial = {}) {
  const out = {};
  if (!mainDigest) return out;
  const bad = new Set((mainDigest.bundles || []).filter((b) => b.official === false || unofficial[b.key]).map((b) => b.key));
  for (const e of plan.experiments) {
    const prefix = e.run_id.split("-").slice(0, -1).join("-") + "-";
    const bases = new Set(e.bases);
    const by = {};
    for (const t of mainDigest.trials || []) {
      if (bad.has(t.bundle) || t.seed !== 0 || !bases.has(t.base) || !(t.run_id || "").startsWith(prefix)) continue;
      (by[`${t.base}|${t.mode}`] ||= []).push({ ...t, status: statusOf(t) });
    }
    const cells = {}, runIds = new Set(), sums = {};
    for (const [k, ts] of Object.entries(by)) {
      ts.sort((a, b) => String(a.finished_at || "").localeCompare(String(b.finished_at || "")));
      const counted = ts.filter((t) => t.status === "ok" || t.status === "fail");
      const final = counted.length ? counted[counted.length - 1] : ts[ts.length - 1];
      cells[k] = final;
      runIds.add(final.run_id);
    }
    for (const mode of ["privileged", "standard"]) {
      const s = { ok: 0, fail: 0, other: 0, missing: 0 };
      for (const b of e.bases) {
        const f = cells[`${b}|${mode}`];
        if (!f) s.missing++; else if (f.status === "ok") s.ok++; else if (f.status === "fail") s.fail++; else s.other++;
      }
      sums[mode] = s;
    }
    out[e.id] = { cells, runIds: [...runIds].sort(), sums };
  }
  return out;
}
