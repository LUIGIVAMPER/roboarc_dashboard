// node tools/test_rebuttal_model.mjs: the rebuttal page's model (assets/rebuttal-model.js) and its sections
// (assets/rebuttal.js) on synthetic deliveries against data/rebuttal/plan.json, with data/digest.json for the reference.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildModel, problemRows, checkSummary, buildReference, batchKind, splitVariant, slotKey } from "../assets/rebuttal-model.js";
import * as page from "../assets/rebuttal.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const plan = JSON.parse(fs.readFileSync(path.join(root, "data/rebuttal/plan.json")));
const main = JSON.parse(fs.readFileSync(path.join(root, "data/digest.json")));
const E = Object.fromEntries(plan.experiments.map((e) => [e.id, e]));

// batch names and variant names
assert.deepEqual(batchKind("rebuttal-e1-r3"), { kind: "run", exp: "E1", repeat: 3 });
assert.deepEqual(batchKind("rebuttal-smoke-e4"), { kind: "smoke", exp: "E4", repeat: 0 });
assert.equal(batchKind("rebuttal-checks").kind, "checks");
assert.equal(batchKind("copilot-astra-standard").kind, "other");
assert.deepEqual(splitVariant(E.E1, "roboarc-bed-bolt-03-i01-q1c10"), { base0: "roboarc-bed-bolt-03-i01", token: "q1c10" });
assert.deepEqual(splitVariant(E.E4, "roboarc-cast-coil-06-i01-clr4x"), { base0: "roboarc-cast-coil-06-i01", token: "clr4x" });

// synthetic deliveries
let n = 0;
const bundle = (helper, batch, at, extra = {}) => ({ key: `${helper}__${batch}__${at}`, helper, batch, bundle: at, path: `${helper}/${batch}/${at}`,
  revision: "main", source: "main", uploaded_at: at, run_id: null, trials: 0, errors: [], ...extra });
const trial = (b, base, token, mode, result, extra = {}) => ({ bundle: b.key, job: `${b.batch}-${mode}-${base}-${token}`, trial_dir: `${base}-${token}__x${n++}`,
  base: `${base}-${token}`, mode, seed: 0, k: 1, run_id: "codex-gpt6_astra-high", effort: "high", result, finished_at: b.uploaded_at, wall_s: 600, attempts: 1, ...extra });
const r1a = bundle("reuben", "rebuttal-e1-r1", "2026-11-21T10:00Z");
const r1b = bundle("reuben", "rebuttal-e1-r1", "2026-11-22T10:00Z");
const sm1 = bundle("reuben", "rebuttal-smoke-e1", "2026-11-20T10:00Z");
const sm2 = bundle("reuben", "rebuttal-smoke-e2", "2026-11-20T10:00Z");
const oth = bundle("reuben", "something-else", "2026-11-20T11:00Z");
const B0 = E.E1.bases[0], B1 = E.E1.bases[1], O0 = E.E2.bases[0];
const t1 = trial(r1a, B0, "q1c00", "standard", "success");
const t2void = trial(r1a, B0, "q1c10", "standard", "not_a_result", { reason: "Harbor ended the trial with `NonZeroAgentExitCodeError`", exception: true, exception_type: "NonZeroAgentExitCodeError" });
const t2rerun = trial(r1b, B0, "q1c10", "standard", "fail", { attempts: 2, attempts_over_cap: false });
const t1again = { ...t1, bundle: r1b.key };      // the later delivery carries the earlier trial again
const t3 = trial(r1b, B1, "q1c0g", "standard", "fail", { run_id: "codex-gpt6_astra-xhigh", effort: "xhigh" });
const s1 = plan.experiments[0].conditions.map((c) => trial(sm1, E.E1.smoke_base, c.token, "standard", "fail"));
const s2 = trial(sm2, O0, "q1c00", "standard", "success", { run_id: "claude_code-opus_5_5-high" });
const o1 = trial(oth, B0, "q1c00", "standard", "success");
const digest = { generated_at: "2026-11-22T11:00Z", dataset: plan.dataset, bundles: [r1a, r1b, sm1, sm2, oth], trials: [t1, t2void, t2rerun, t1again, t3, ...s1, s2, o1] };
// a delivery not digested yet, in an open pull request: index.json rows (success or awaiting digest)
const pr = bundle("reuben", "rebuttal-e1-r2", "2026-11-23T10:00Z", { revision: "refs/pr/7", source: "PR #7", pending: true });
const live = { bundles: [pr], trials: [{ ...trial(pr, B0, "q1c00", "standard", "success"), result_source: "index", live: true },
  { ...trial(pr, B0, "q1c1g", "standard", "pending"), result_source: "index", live: true }], listed: [r1a, r1b, sm1, sm2, oth, pr].map((b) => b.key) };

const M = buildModel({ plan, digest, live });
const x1 = M.experiments.find((x) => x.id === "E1");
assert.equal(M.total.total, 366);
assert.equal(x1.counts.total, 156);
// E1 r1: t1 success (counted once), B0 C10 fail after a voided attempt, B1 C0G fail; r2: one success and one awaiting
assert.equal(x1.counts.ok, 2);
assert.equal(x1.counts.fail, 2);
assert.equal(x1.counts.wait, 1);
assert.equal(x1.counts.void, 0);
assert.equal(x1.batches[0].delivered, 3);
assert.equal(x1.batches[1].delivered, 2);
const c10 = M.slots[slotKey("run", "E1", 1, B0, "q1c10", "standard")];
assert.equal(c10.attempts.length, 2);
assert.equal(c10.final.result, "fail");
assert.equal(M.slots[slotKey("run", "E1", 1, B0, "q1c00", "standard")].attempts.length, 1, "a trial delivered twice counts once");
assert.equal(x1.smoke.counts.total, 4);
assert.equal(x1.smoke.counts.fail, 4);
assert.equal(M.experiments.find((x) => x.id === "E2").smoke.counts.ok, 1);
assert.equal(M.experiments.reduce((a, x) => a + x.smoke.counts.total, 0), 16);
const condC10 = x1.conds.find((c) => c.token === "q1c10");
assert.equal(condC10.counts.fail, 1);
assert.equal(condC10.repeats[0].fail, 1);
// the off-plan trial is flagged; the voided attempt and its rerun are listed
const probs = problemRows(M);
const flagged = probs.find((r) => r.t === M.latest.find((t) => t.trial_dir === t3.trial_dir));
assert.ok(flagged && flagged.kinds.includes("plan"), "wrong run id flagged");
assert.match(flagged.t.flags.join(";"), /run id codex-gpt6_astra-xhigh/);
assert.match(flagged.t.flags.join(";"), /effort xhigh/);
assert.ok(probs.some((r) => r.t.trial_dir === t2void.trial_dir && r.kinds.includes("void") && r.kinds.includes("rerun")));
assert.ok(!probs.some((r) => r.t.bundle === oth.key), "a batch outside the rebuttal is not a problem row");
assert.equal(M.bmap[oth.key].kind, "other");

// step 1: one report that passes (E1), one that does not (E4)
const v = (task, label, mode, ok = true) => ({ task, label, mode, exists: true, digest: "a", digest_file: "a", digest_locked: "a",
  oracle: { reward: ok ? 1 : 0, pass: ok, why: ok ? [] : ["replay_success=0.0"] }, nop: { reward: 0, pass: true }, extra: null, pass: ok });
const e1rep = { experiment: "E1", all_pass: true, n_pass: 52, n_variants: 52, environment: { render: "on", commit: "c847e730", harbor: "0.25.1" },
  variants: Array.from({ length: 52 }, (_, i) => v(`t${i}`, "C00", "standard")) };
const e4rep = { experiment: "E4", all_pass: false, n_pass: 23, n_variants: 24, environment: { render: "on", commit: "c847e730" },
  variants: [...Array.from({ length: 23 }, (_, i) => v(`t${i}`, "clearance x2", "standard")), v("roboarc-bed-bolt-01-i01-clr4x-privileged", "clearance x4", "privileged", false)],
  experiment_checks: { "check_clearance_render.py": { pass: true, rc: 0 } } };
const checks = [{ key: "reuben__rebuttal-checks__20261120T0100Z", helper: "reuben", id: "20261120T0100Z", rev: "refs/pr/1", label: "PR #1", path: "reuben/rebuttal-checks/20261120T0100Z", uploaded_at: "2026-11-20T01:00Z", reports: { E1: e1rep, E4: e4rep } }];
const C = checkSummary(plan, checks);
assert.equal(C.E1.all_pass, true);
assert.equal(C.E4.all_pass, false);
assert.equal(C.E4.failed.length, 1);
assert.match(C.E4.failed[0].why.join(), /oracle: reward 0 \(replay_success=0.0\)/);
assert.equal(C.E2.sent, 0);
assert.equal(C.E2.expected, 60);

// the main evaluation's released tasks, seed 0, same harness and model
const ref = buildReference(plan, main, {});
for (const e of plan.experiments) {
  const s = ref[e.id].sums.standard;
  assert.equal(s.ok + s.fail + s.other + s.missing, e.bases.length);
  assert.ok(ref[e.id].runIds.every((r) => r.startsWith(e.run_id.split("-").slice(0, -1).join("-"))), ref[e.id].runIds);
}
console.log("reference run ids:", Object.fromEntries(plan.experiments.map((e) => [e.id, ref[e.id].runIds.join(" ")])));
console.log("reference E4 seed 0:", JSON.stringify(ref.E4.sums));

// every section renders
Object.assign(page.S, { plan, checks, ref, live: { ...live, at: "2026-11-23T10:00Z", info: { lastModified: "2026-11-23T10:00Z", siblings: [] } }, renders: {
  [checks[0].key]: { "roboarc-bed-bolt-01-i01-clr2x-privileged/step_0.png": 1, "roboarc-bed-bolt-01-i01-clr2x-privileged/base_step_0.png": 1, "report.md": 1 } } });
page.S.model = M;
const html = [page.htmlOverall(M), page.htmlCards(M), page.htmlChecks(), page.htmlCheckDetail(), page.htmlSmoke(M), page.htmlResults(M),
  page.htmlMatrixTabs(), page.htmlMatrix(M), page.htmlProblems(M).table, page.htmlDeliveries(M)];
for (const h of html) assert.equal(typeof h, "string");
assert.match(html[2], /ALL PASS/);
assert.match(html[2], /NOT PASSED/);
assert.match(html[3], /base_step_0\.png/);
assert.match(html[7], /data-trial=/);
assert.match(html[9], /not a rebuttal batch/);
for (const id of ["E1", "E2", "E3", "E4", "E5"]) { page.S.exp = id; assert.ok(page.htmlMatrix(M).includes("rrow")); }
// the empty dataset, as it is today
const M0 = buildModel({ plan, digest: { bundles: [], trials: [] }, live: { bundles: [], trials: [], listed: [] } });
page.S.checks = []; page.S.model = M0;
assert.equal(M0.total.empty, 366);
[page.htmlOverall(M0), page.htmlCards(M0), page.htmlChecks(), page.htmlCheckDetail(), page.htmlSmoke(M0), page.htmlResults(M0), page.htmlMatrix(M0), page.htmlProblems(M0).table, page.htmlDeliveries(M0)]
  .forEach((h) => assert.equal(typeof h, "string"));
fs.writeFileSync(process.env.OUT || "/dev/null", `<!doctype html><link rel="stylesheet" href="assets/style.css"><main class="wrap">${html.join("\n")}</main>`);
console.log("rebuttal model and sections: ok");
