#!/usr/bin/env python3
"""Digest the deliveries in the RoboARC outputs dataset for the dashboard.

    python3 tools/digest.py                      # the Hugging Face dataset (default RoboARC/RoboARC-outputs)
    python3 tools/digest.py --local <dir>        # bundles on disk: <dir>/<helper>/<batch>/<bundle id>/ (for testing)

A delivery (scripts/send_results.sh in RoboARC) is one bundle at <helper>/<batch>/<bundle id>/: MANIFEST.md, index.json,
batch.tar.gz (the batch log, its summary and plan, and the per-trial results) and jobs/<job>.tar.gz (one per Harbor
job). A bundle is never overwritten, so a bundle digested once is kept as it is. Deliveries still in an open pull
request on the dataset are read from the pull request's revision.

A delivery made without send_results.sh may instead hold the runner's folders as loose files: jobs/ (the JOBS
directory: <batch>.log, <batch>.summary.md, .plan/, .seeds/ and the job folders, one or more batches) and results/ (the
RESULTS directory), and maybe a REDACTION.json from the helper's own redaction ("official": false keeps its trials out of
the progress). It has no MANIFEST.md, so its run settings come from the batch log's runner line.

Writes data/digest.json (every bundle's settings and machine, and one row per trial: task, mode, trial number, seed,
result) and data/bundles/<helper>__<batch>__<bundle>.json (the bundle's MANIFEST.md, the batch log's notable lines and
per trial the exception and log tails), which the page loads when a bundle or a trial is opened. Standard library only.
"""
import argparse
import datetime as dt
import io
import json
import os
import re
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
HF = "https://huggingface.co"
SMALL = 4 << 20          # read members up to this size; bigger ones (videos, trajectories) are skipped
TAIL = 60                # lines kept from the end of a log
LINE = 400               # characters kept per line
# A bundle digested by an older version of this script is digested again. 2: the official per-trial results
# (results/<batch>/.../config.json) are matched to their trial by its directory, not by its trial number. 3: the
# batch log's "start" lines of the current runner ("(concurrency N; trial ...)") give the concurrency; loose deliveries.
DIGEST_VERSION = 3


def now():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def tail(data, n=TAIL):
    lines = data.decode("utf-8", "replace").rstrip("\n").split("\n")
    return [l if len(l) <= LINE else l[:LINE] + " …" for l in lines[-n:]]


def load_json(data):
    try:
        return json.loads(data.decode("utf-8", "replace"))
    except ValueError:
        return None


# ---------- sources: the Hugging Face dataset, or a directory ----------

class Hub:
    def __init__(self, dataset):
        self.dataset = dataset

    def _get(self, url, stream=False):
        for attempt in range(4):
            try:
                r = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "roboarc-dashboard"}),
                                           timeout=120)
                return r if stream else r.read()
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    return None
                if e.code not in (429, 500, 502, 503, 504) or attempt == 3:
                    raise
            except urllib.error.URLError:
                if attempt == 3:
                    raise
            time.sleep(5 * (attempt + 1))

    def revisions(self):
        """main, and every open pull request: [(revision, label)]."""
        revs = [("main", "main")]
        p = 0
        while True:
            d = json.loads(self._get(f"{HF}/api/datasets/{self.dataset}/discussions?p={p}") or b"{}")
            for x in d.get("discussions", []):
                if x.get("isPullRequest") and x.get("status") == "open":
                    revs.append((f"refs/pr/{x['num']}", f"PR #{x['num']}"))
            p += 1
            if p * 50 >= d.get("count", 0) or not d.get("discussions"):
                return revs

    def tree(self, rev, path=""):
        q = urllib.parse.quote(rev, safe="")
        url = f"{HF}/api/datasets/{self.dataset}/tree/{q}" + (f"/{urllib.parse.quote(path)}" if path else "") + "?expand=true"
        return json.loads(self._get(url) or b"[]")

    def bundles(self):
        """[(key, revision, label, path, uploaded_at)] for every <helper>/<batch>/<bundle>/ directory."""
        out = []
        for rev, label in self.revisions():
            for h in (e for e in self.tree(rev) if e["type"] == "directory"):
                for b in (e for e in self.tree(rev, h["path"]) if e["type"] == "directory"):
                    for u in (e for e in self.tree(rev, b["path"]) if e["type"] == "directory"):
                        date = (u.get("lastCommit") or {}).get("date")
                        out.append((u["path"].replace("/", "__"), rev, label, u["path"], date))
        return out

    def files(self, rev, path):
        """{path relative to <path>: size} of every file under <path>, following the listing's pages."""
        out = {}
        url = f"{HF}/api/datasets/{self.dataset}/tree/{urllib.parse.quote(rev, safe='')}/{urllib.parse.quote(path)}?recursive=true&limit=1000"
        while url:
            r = self._get(url, stream=True)
            if r is None:
                break
            for e in json.loads(r.read() or b"[]"):
                if e["type"] == "file":
                    out[e["path"][len(path) + 1:]] = e.get("size", 0)
            m = re.search(r'<([^>]+)>;\s*rel="next"', r.headers.get("Link") or "")
            url = m.group(1) if m else None
        return out

    def read(self, rev, path):
        return self._get(f"{HF}/datasets/{self.dataset}/resolve/{urllib.parse.quote(rev, safe='')}/{urllib.parse.quote(path)}")

    def open(self, rev, path):
        return self._get(f"{HF}/datasets/{self.dataset}/resolve/{urllib.parse.quote(rev, safe='')}/{urllib.parse.quote(path)}",
                         stream=True)

    def url(self, rev, path):
        return f"{HF}/datasets/{self.dataset}/blob/{urllib.parse.quote(rev, safe='')}/{path}"


class Local:
    def __init__(self, root):
        self.root = root
        self.dataset = os.path.abspath(root)

    def bundles(self):
        out = []
        for h in sorted(os.listdir(self.root)):
            for b in sorted(os.listdir(os.path.join(self.root, h))):
                for u in sorted(os.listdir(os.path.join(self.root, h, b))):
                    p = os.path.join(self.root, h, b, u)
                    if os.path.isfile(os.path.join(p, "MANIFEST.md")) or os.path.isdir(os.path.join(p, "jobs")):
                        date = dt.datetime.fromtimestamp(os.path.getmtime(p), dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                        out.append((f"{h}__{b}__{u}", "local", "local", f"{h}/{b}/{u}", date))
        return out

    def files(self, rev, path):
        top = os.path.join(self.root, path)
        return {os.path.relpath(os.path.join(d, f), top): os.path.getsize(os.path.join(d, f))
                for d, _, fs in os.walk(top) for f in fs}

    def read(self, rev, path):
        p = os.path.join(self.root, path)
        return open(p, "rb").read() if os.path.isfile(p) else None

    def open(self, rev, path):
        p = os.path.join(self.root, path)
        return open(p, "rb") if os.path.isfile(p) else None

    def url(self, rev, path):
        return None


# ---------- parsing ----------

def parse_manifest(text):
    """MANIFEST.md 'key: value' lines (continuation lines indented) -> dict, plus the parsed host, GPUs and runner."""
    raw, key = {}, None
    for line in text.splitlines():
        m = re.match(r"^([A-Za-z0-9_ ]+?):\s{1,}(.*)$", line)
        if m and not line.startswith(" "):
            key = m.group(1).strip()
            raw[key] = m.group(2).strip()
        elif key and line.strip():
            raw[key] += "\n" + line.strip()
    out = {"raw": raw}
    h = re.match(r"^(.*?),\s*(\d+) CPUs,\s*(\d+) GB RAM", raw.get("host", ""))
    if h:
        out["host"] = {"cpu_model": h.group(1), "cpus": int(h.group(2)), "ram_gb": int(h.group(3))}
    gpus = []
    for g in filter(None, (s.strip() for s in raw.get("GPUs", "").split(";"))):
        parts = [p.strip() for p in g.split(",")]
        if len(parts) >= 3:
            gpus.append({"index": parts[0], "name": parts[1], "driver": parts[2]})
    out["gpus"] = gpus
    r = re.search(r"runner (\d+): (\S+) (\S+) effort (\S+), run id (\S+), modes ([^,]+), web search (\w+)"
                  r"(?:, usage gateway ([^,]+))?(?:, (GPUs [0-9,]+ \(.*\)|GPU scheduling off))?", raw.get("runner", ""))
    if r:
        out["runner"] = {"pid": r.group(1), "agent": r.group(2), "model": r.group(3), "effort": r.group(4),
                         "run_id": r.group(5), "modes": r.group(6).split(), "web_search": r.group(7),
                         "usage_gateway": (r.group(8) or "off").strip(), "gpu_placement": r.group(9)}
    t = re.search(r"planned jobs (\S+), trial dirs (\S+), with a verdict (\S+)", raw.get("trials", ""))
    if t:
        out["trials"] = {"planned_jobs": t.group(1), "trial_dirs": t.group(2), "with_verdict": t.group(3)}
    s = re.search(r"K = (\d+)", raw.get("seeds", ""))
    if s:
        out["K"] = int(s.group(1))
    return out


TS = re.compile(r"^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\] (.*)$")


def parse_batch_log(text):
    """The runner's lanes (one runner pid per lane), concurrency, start/done times per job and the notable lines."""
    lanes, jobs, notable, times, conc, runner = set(), {}, [], [], [], None
    for line in text.splitlines():
        m = TS.match(line)
        if not m:
            if re.search(r"error|failed|traceback|refused|killed|oom", line, re.I):
                notable.append(line[:LINE])
            continue
        t, msg = m.groups()
        times.append(t)
        p = re.match(r"runner (\d+): ", msg)
        if p:
            lanes.add(p.group(1))
            runner = runner or msg
        s = re.match(r"start (\S+): .*\(concurrency (\d+)[,;)]", msg)
        if s:
            jobs.setdefault(s.group(1), {})["start"] = t
            conc.append(int(s.group(2)))
        d = re.match(r"done (\S+) \(harbor rc=(-?\d+)\)", msg)
        if d:
            jobs.setdefault(d.group(1), {}).update(done=t, harbor_rc=int(d.group(2)))
        if re.search(r"FAILED|stop|error|voided|retry|refused|killed|OOM|account", msg, re.I) and not s and not d:
            notable.append(f"[{t}] {msg}"[:LINE])
    return {"lanes": len(lanes), "concurrency_max": max(conc) if conc else None, "first": times[0] if times else None,
            "last": times[-1] if times else None, "jobs": jobs, "notable": notable[-200:], "pids": sorted(lanes),
            "runner": runner}


def read_tar(fobj, want):
    """Stream a .tar.gz; call want(path, size) -> bool for each regular file and return {path: bytes} of those wanted."""
    got = {}
    with tarfile.open(fileobj=fobj, mode="r|gz") as tf:
        for m in tf:
            if m.isfile() and m.size <= SMALL and want(m.name, m.size):
                got[m.name] = tf.extractfile(m).read()
    return got


JOB_FILES = ("result.json", "exception.txt", "trial.log", "verifier/reward.json", "verifier/verdict.json",
             "verifier/resource_limits.json", "verifier/grade.log", "verifier/reward.txt", "gateway/totals.json")


def digest_job(src, rev, path, job, jobs_dir):
    """Per trial directory of one job archive: what the page shows (summary) and the log tails (detail)."""
    f = src.open(rev, f"{path}/jobs/{job}.tar.gz")
    if f is None:
        return {}, None, "archive missing"
    pre = f"{jobs_dir}/{job}/"

    def want(name, size):
        if name == f"{jobs_dir}/.seeds/{job}.json" or name == pre + "seed.json":
            return True
        rest = name[len(pre):] if name.startswith(pre) else None
        return bool(rest) and rest.count("/") >= 1 and rest.split("/", 1)[1] in JOB_FILES

    try:
        files = read_tar(f, want)
    except (tarfile.TarError, OSError, EOFError) as e:
        return {}, None, f"archive unreadable: {e}"
    finally:
        f.close()
    return job_records(files, pre, f"{jobs_dir}/.seeds/{job}.json") + (None,)


def digest_job_loose(src, rev, path, job, listing):
    """The same records, read file by file from a loose delivery's jobs/<job>/ (listing: the delivery's files)."""
    pre = f"jobs/{job}/"
    names = [n for n, size in listing.items() if size <= SMALL and (
        n == pre + "seed.json" or n == f"jobs/.seeds/{job}.json"
        or (n.startswith(pre) and n[len(pre):].count("/") >= 1 and n[len(pre):].split("/", 1)[1] in JOB_FILES))]
    with ThreadPoolExecutor(8) as ex:
        data = list(ex.map(lambda n: src.read(rev, f"{path}/{n}"), names))
    return job_records({n: d for n, d in zip(names, data) if d is not None}, pre, f"jobs/.seeds/{job}.json")


def job_records(files, pre, seed_name):
    """({trial dir: record}, seed record) from a job's files ({path: bytes}, the job folder at <pre>)."""
    seed = load_json(files.get(pre + "seed.json") or files.get(seed_name) or b"null")
    trials = {}
    for name, data in files.items():
        rest = name[len(pre):] if name.startswith(pre) else ""
        if "/" not in rest:
            continue
        trial, rel = rest.split("/", 1)
        trials.setdefault(trial, {})[rel] = data
    out = {}
    for trial, fs in trials.items():
        res = load_json(fs.get("result.json", b"null")) or {}
        exc = res.get("exception_info") or {}
        rw = load_json(fs.get("verifier/reward.json", b"null")) or {}
        ar = res.get("agent_result") or {}
        lim = load_json(fs.get("verifier/resource_limits.json", b"null")) or {}
        cap = ((lim.get("limits") or {}).get("caps") or {}).get("main") or {}
        wall = None
        try:
            a = dt.datetime.fromisoformat(res["started_at"].replace("Z", "+00:00"))
            b = dt.datetime.fromisoformat(res["finished_at"].replace("Z", "+00:00"))
            wall = round((b - a).total_seconds())
        except (KeyError, TypeError, ValueError, AttributeError):
            pass
        out[trial] = {
            "task_name": res.get("task_name"),
            "started_at": res.get("started_at"), "finished_at": res.get("finished_at"), "wall_s": wall,
            "exception_type": exc.get("exception_type"),
            "reward": rw.get("success") if rw else None,
            "infra_error": rw.get("infra_error"), "grader_error": rw.get("grader_error"),
            "peak_memory_gb": rw.get("peak_memory_gb"), "peak_gpu_memory_gb": rw.get("peak_gpu_memory_gb"),
            "oom_kills": sum(rw.get(k) or 0 for k in ("resource_oom_kills", "resource_host_oom_kills",
                                                       "resource_service_oom_kills", "resource_emergency_kills")) if rw else None,
            "tokens_in": ar.get("n_input_tokens"), "tokens_out": ar.get("n_output_tokens"), "cost_usd": ar.get("cost_usd"),
            # the container caps the trial ran under (the task's, clamped to the host) and whether they were enforced
            "cap_cpus": cap.get("cpus"), "cap_memory_gb": cap.get("memory_gb"), "limits_enforced": lim.get("enforced"),
            "detail": {
                "exception_message": (exc.get("exception_message") or "")[:4000] or None,
                "exception_tail": tail(fs["exception.txt"]) if "exception.txt" in fs else None,
                "grade_tail": tail(fs["verifier/grade.log"]) if "verifier/grade.log" in fs else None,
                "trial_tail": tail(fs["trial.log"], 30) if "trial.log" in fs else None,
                "reward": rw or None,
                "verdict": load_json(fs["verifier/verdict.json"]) if "verifier/verdict.json" in fs else None,
                "resource_limits": load_json(fs["verifier/resource_limits.json"]) if "verifier/resource_limits.json" in fs else None,
                "gateway_totals": load_json(fs["gateway/totals.json"]) if "gateway/totals.json" in fs else None,
            },
        }
    return out, seed


def gather_bundle(src, rev, path, man_b, idx):
    """A send_results.sh bundle: MANIFEST.md, index.json, batch.tar.gz and one archive per job."""
    man = parse_manifest(man_b.decode("utf-8", "replace") if man_b else "")
    batch = idx.get("batch") or path.split("/")[1]
    jobs_dir = idx.get("jobs_dir") or "agents"
    errors = []

    # batch.tar.gz: the batch log, the summary, the plan and the official per-trial results
    log, summary, plan, results = None, None, None, {}
    f = src.open(rev, f"{path}/batch.tar.gz")
    if f is None:
        errors.append("batch.tar.gz missing")
    else:
        try:
            files = read_tar(f, lambda n, s: n.endswith((".log", ".summary.md", ".json")) and not n.endswith("attempts.json")
                             and (n.startswith(f"{jobs_dir}/") or n.startswith("results/")))
        except (tarfile.TarError, OSError, EOFError) as e:
            files = {}
            errors.append(f"batch.tar.gz unreadable: {e}")
        finally:
            f.close()
        for name, data in files.items():
            if name == f"{jobs_dir}/{batch}.log":
                log = parse_batch_log(data.decode("utf-8", "replace"))
            elif name == f"{jobs_dir}/{batch}.summary.md":
                summary = data.decode("utf-8", "replace")[:300000]
            elif name == f"{jobs_dir}/.plan/{batch}.json":
                plan = load_json(data)
            elif name.startswith("results/") and name.endswith("/config.json"):
                c = load_json(data) or {}
                if c.get("job") and c.get("trial_dir"):
                    results[(c["job"], c["trial_dir"])] = c
    return {"man": man, "manifest_text": man_b.decode("utf-8", "replace") if man_b else None, "batch": batch,
            "run_id": idx.get("run_id") or (man.get("runner") or {}).get("run_id"), "log": log, "summary": summary,
            "plan": plan, "results": results, "jobs": idx.get("jobs", []), "errors": errors,
            "read_job": lambda job: digest_job(src, rev, path, job, jobs_dir),
            "archive": lambda job, trial: f"{path}/jobs/{job}.tar.gz"}


def gather_loose(src, rev, path, listing):
    """A delivery of loose files: the runner's jobs/ (one or more batches) and results/, maybe REDACTION.json. The run
    settings come from the batch logs' runner lines, the jobs and trials from the folders, the tasks from the plans."""
    def read(n):
        return src.read(rev, f"{path}/{n}") if n in listing else None

    red = load_json(read("REDACTION.json") or b"null")
    red = red if isinstance(red, dict) else None
    plans = {n[len("jobs/.plan/"):-5]: load_json(read(n) or b"null") or {} for n in listing
             if re.fullmatch(r"jobs/\.plan/[^/]+\.json", n)}
    batches = sorted(set(plans) | {n[5:-4] for n in listing
                                   if re.fullmatch(r"jobs/[^/]+\.log", n) and f"jobs/{n[5:-4]}.summary.md" in listing})
    logs, summaries, jobs, errors = [], [], [], []
    for bt in batches:
        text = read(f"jobs/{bt}.log")
        if text:
            logs.append(parse_batch_log(text.decode("utf-8", "replace")))
        s = read(f"jobs/{bt}.summary.md")
        if s:
            summaries.append(s.decode("utf-8", "replace"))
        planned = {}
        for p in plans.get(bt, {}).get("jobs", []):
            planned.setdefault(p.get("job"), []).append(p)
        dirs = {}   # job -> its trial directories: jobs/<job>/<trial>/...
        for n in listing:
            parts = n.split("/")
            if len(parts) >= 4 and parts[0] == "jobs" and (parts[1] in planned if planned else parts[1].startswith(bt + "-")):
                dirs.setdefault(parts[1], set()).add(parts[2])
        jobs += [{"job": j, "tasks": planned.get(j) or [{}],
                  "trials": [{"trial_dir": d, "exception": f"jobs/{j}/{d}/exception.txt" in listing} for d in sorted(ds)]}
                 for j, ds in sorted(dirs.items())]
    if not batches:
        errors.append("no batch log or plan under jobs/")
    results = {}
    cfgs = [n for n in listing if n.startswith("results/") and n.endswith("/config.json")]
    with ThreadPoolExecutor(8) as ex:
        for c in ex.map(lambda n: load_json(read(n) or b"null") or {}, cfgs):
            if c.get("job") and c.get("trial_dir"):
                results[(c["job"], c["trial_dir"])] = c

    man = parse_manifest("runner: " + next((l["runner"] for l in logs if l["runner"]), ""))
    ks = [p["trials"] for p in plans.values() if isinstance(p.get("trials"), int)]
    if ks:
        man["K"] = max(ks)
    man["trials"] = {"planned_jobs": sum(len(p.get("jobs", [])) for p in plans.values()) if plans else "?",
                     "trial_dirs": sum(len(j["trials"]) for j in jobs),
                     "with_verdict": sum(f"jobs/{j['job']}/{t['trial_dir']}/verifier/reward.json" in listing
                                         for j in jobs for t in j["trials"])}
    run_id = next((p["run_id"] for p in plans.values() if p.get("run_id")), None) or (man.get("runner") or {}).get("run_id")
    conc = [l["concurrency_max"] for l in logs if l["concurrency_max"] is not None]
    log = {"lanes": len({p for l in logs for p in l["pids"]}), "concurrency_max": max(conc) if conc else None,
           "first": min((l["first"] for l in logs if l["first"]), default=None),
           "last": max((l["last"] for l in logs if l["last"]), default=None),
           "jobs": {k: v for l in logs for k, v in l["jobs"].items()},
           "notable": [x for l in logs for x in l["notable"]][-200:]} if logs else None
    return {"man": man, "manifest_text": None, "batch": path.split("/")[1], "run_id": run_id, "log": log,
            "summary": "\n\n".join(summaries)[:300000] or None,
            "plan": {"jobs": [x for p in plans.values() for x in p.get("jobs", [])], "trials": max(ks) if ks else None,
                     "run_id": run_id} if plans else None,
            "results": results, "jobs": jobs, "errors": errors,
            "read_job": lambda job: digest_job_loose(src, rev, path, job, listing) + (None,),
            "archive": lambda job, trial: f"{path}/jobs/{job}/{trial}/",
            "loose": {"batches": batches, "official": red.get("official") if red else None, "redaction": red}}


def digest_bundle(src, key, rev, label, path, uploaded_at):
    man_b = src.read(rev, f"{path}/MANIFEST.md")
    idx = load_json(src.read(rev, f"{path}/index.json") or b"null") or {}
    listing = src.files(rev, path) if not man_b and not idx else None
    if listing is not None and "batch.tar.gz" not in listing and any(n.startswith("jobs/") for n in listing):
        g = gather_loose(src, rev, path, listing)
    else:
        g = gather_bundle(src, rev, path, man_b, idx)
    man, log, plan, results, run_id, errors = g["man"], g["log"], g["plan"], g["results"], g["run_id"], g["errors"]

    trials, detail = [], {}
    for j in g["jobs"]:
        per, seed_rec, err = g["read_job"](j["job"])
        if err:
            errors.append(f"{j['job']}: {err}")
        planned = (j.get("tasks") or [{}])
        for t in j.get("trials", []):
            d = per.get(t["trial_dir"], {})
            c = results.get((j["job"], t["trial_dir"]), {})
            # Harbor's task_name may carry a dataset prefix ("<dataset>/<task>")
            task = (d.get("task_name") or (planned[0].get("task") if len(planned) == 1 else None) or "").rsplit("/", 1)[-1]
            base = re.sub(r"-(privileged|standard|standard-realtime)$", "", task) if task else None
            p = next((x for x in planned if x.get("task") in (task, base)), planned[0] if len(planned) == 1 else {})
            mode = c.get("mode") or next((m for m in ("standard-realtime", "privileged", "standard") if task.endswith("-" + m)),
                                         p.get("mode"))
            reward = t["reward"] if t.get("reward") is not None else d.get("reward")   # loose: no index.json
            if c.get("result"):
                result, source = c["result"], "results"
            elif reward is not None:
                result, source = ("success" if reward >= 1 else "fail"), "index"
            else:
                result, source = "no_verdict", "index"
            row = {
                "bundle": key, "job": j["job"], "trial_dir": t["trial_dir"], "base": base, "mode": mode,
                "k": c.get("trial") if isinstance(c.get("trial"), int) else p.get("trial"),
                "seed": c.get("seed") if isinstance(c.get("seed"), int) else p.get("seed"),
                "run_id": c.get("run_id") or run_id, "result": result, "result_source": source,
                "reason": c.get("not_a_result_reason"), "counted": c.get("counted"),
                "attempts": c.get("attempts"), "attempts_over_cap": c.get("attempts_over_cap"),
                "reward": t.get("reward"), "exception": bool(t.get("exception")),
                "archive": g["archive"](j["job"], t["trial_dir"]),
            }
            row.update({k: v for k, v in d.items() if k not in ("detail", "task_name")})
            row["harbor_rc"] = ((log or {}).get("jobs", {}).get(j["job"]) or {}).get("harbor_rc")
            trials.append(row)
            if d.get("detail"):
                detail[f"{j['job']}/{t['trial_dir']}"] = d["detail"]

    b = {
        "key": key, "helper": idx.get("helper") or path.split("/")[0], "batch": g["batch"],
        "bundle": idx.get("bundle") or path.split("/")[2], "path": path, "revision": rev, "source": label,
        "uploaded_at": uploaded_at, "url": src.url(rev, path), "run_id": run_id,
        "manifest": {k: v for k, v in man.items() if k != "raw"},
        "manifest_fields": {k: man["raw"].get(k) for k in ("repo", "software", "images", "mirror", "results", "notes",
                                                           "trials", "seeds", "runner") if man["raw"].get(k)},
        "plan": {"jobs": len(plan.get("jobs", [])), "K": plan.get("trials"), "run_id": plan.get("run_id")} if plan else None,
        "log": {k: v for k, v in (log or {}).items() if k not in ("jobs", "notable", "pids", "runner")} or None,
        "jobs": len(g["jobs"]), "trials": len(trials), "errors": errors,
        "detail_file": f"data/bundles/{key}.json", "digested_at": now(), "digest_version": DIGEST_VERSION,
    }
    det = {"key": key, "manifest_text": g["manifest_text"], "summary_md": g["summary"],
           "log_notable": (log or {}).get("notable", []), "trials": detail}
    if "loose" in g:   # what the helper's REDACTION.json says goes on the page; the whole file in the detail
        red = g["loose"]["redaction"] or {}
        b.update(layout="loose", batches=g["loose"]["batches"], official=g["loose"]["official"],
                 redaction={k: red[k] for k in ("notice", "sanitized_copy", "official", "provider_alias") if k in red} or None)
        det["redaction"] = g["loose"]["redaction"]
    return b, trials, det


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default="RoboARC/RoboARC-outputs")
    ap.add_argument("--local")
    ap.add_argument("--out", default=os.path.join(DATA, "digest.json"))
    ap.add_argument("--redo", action="store_true", help="digest every bundle again")
    args = ap.parse_args()
    src = Local(args.local) if args.local else Hub(args.dataset)
    bdir = os.path.join(os.path.dirname(os.path.abspath(args.out)), "bundles")
    os.makedirs(bdir, exist_ok=True)

    old = {}
    if os.path.isfile(args.out) and not args.redo:
        prev = json.load(open(args.out))
        if prev.get("dataset") == src.dataset:
            old = {b["key"]: (b, [t for t in prev["trials"] if t["bundle"] == b["key"]]) for b in prev["bundles"]}

    listed = src.bundles()
    seen, bundles, trials, new = set(), [], [], 0
    # main first: a bundle that is both in main and in a pull request is the merged one
    for key, rev, label, path, date in sorted(listed, key=lambda x: (x[1] != "main", x[0])):
        if key in seen:
            continue
        seen.add(key)
        if (key in old and old[key][0].get("revision") in (rev, "main") and not old[key][0].get("errors")
                and old[key][0].get("digest_version") == DIGEST_VERSION):
            b, ts = old[key]
            if b["revision"] != rev:   # a pull request merged since: the same bundle, now in main
                b.update(revision=rev, source=label, url=src.url(rev, path), uploaded_at=date or b.get("uploaded_at"))
                new += 1
        else:
            print(f"digest {label} {path}", flush=True)
            b, ts, det = digest_bundle(src, key, rev, label, path, date)
            with open(os.path.join(bdir, f"{key}.json"), "w") as f:
                json.dump(det, f, ensure_ascii=False, separators=(",", ":"))
            new += 1
        bundles.append(b)
        trials.extend(ts)
    for f in os.listdir(bdir):   # a bundle no longer in the dataset (deleted, or its pull request closed)
        if f.endswith(".json") and f[:-5] not in seen:
            os.remove(os.path.join(bdir, f))

    bundles.sort(key=lambda b: b.get("uploaded_at") or "", reverse=True)
    if not new and os.path.isfile(args.out) and set(old) == seen:
        print(f"no change: {len(bundles)} bundles, {len(trials)} trials ({os.path.normpath(args.out)} kept)")
        return
    out = {"generated_at": now(), "dataset": src.dataset, "bundles": bundles, "trials": trials}
    with open(args.out, "w") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    print(f"wrote {os.path.normpath(args.out)}: {len(bundles)} bundles ({new} digested now), {len(trials)} trials")


if __name__ == "__main__":
    sys.exit(main())
