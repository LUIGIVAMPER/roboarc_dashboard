#!/usr/bin/env python3
"""Write data/rebuttal/plan.json, the planned trials of the RoboARC rebuttal experiments E1-E5, for rebuttal.html.

    python3 tools/build_rebuttal_plan.py --roboarc <checkout of RoboARC's dev/qineng-rebuttal-exp>

The plan is RoboARC's scripts/rebuttal/experiments.py (tasks, conditions, modes, repeats, batch names, agent, run id)
and the condition labels of scripts/rebuttal/make_variants.py REGISTRY, read from the checkout (Python >= 3.11, as the
checkout needs). Run it again whenever the experiments change on that branch. Standard library only.
"""
import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data", "rebuttal", "plan.json")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--roboarc", required=True, help="a checkout of RoboARC's rebuttal branch")
    ap.add_argument("--out", default=OUT)
    a = ap.parse_args()
    root = os.path.abspath(a.roboarc)
    sys.path.insert(0, os.path.join(root, "scripts", "rebuttal"))
    import experiments as ex      # noqa: E402  (the checkout's)
    import make_variants as mv    # noqa: E402
    commit = subprocess.run(["git", "-C", root, "rev-parse", "--short=8", "HEAD"], capture_output=True, text=True).stdout.strip()
    exps = []
    for e in ex.EXPERIMENTS.values():
        bases = list(e.bases())
        exps.append({
            "id": e.id, "purpose": e.purpose, "agent": e.agent, "model": e.model, "run_id": e.run_id, "effort": e.effort,
            "repeats": e.repeats, "modes": list(e.modes), "batches": e.batches(), "smoke_batch": f"rebuttal-smoke-{e.id.lower()}",
            "smoke_base": bases[0], "bases": bases,
            "conditions": [{"token": t, "label": mv.REGISTRY[t].label, "note": mv.REGISTRY[t].note} for t in e.conditions],
            "trials": len(ex.plan(e.id)),
        })
    plan = {
        "note": "The rebuttal experiments as RoboARC's scripts/rebuttal/experiments.py plans them (tools/build_rebuttal_plan.py). "
                "Every trial runs at appearance seed 0; a repeat is a batch of its own (rebuttal-e<n>-r<k>); the variant of a "
                "base for a condition and mode is the task <base>-<token>-<mode>.",
        "commit": commit, "branch": "dev/qineng-rebuttal-exp", "dataset": ex.RESULTS_DATASET, "total": sum(x["trials"] for x in exps),
        "experiments": exps,
    }
    assert plan["total"] == ex.TOTAL_TRIALS, (plan["total"], ex.TOTAL_TRIALS)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w") as f:
        json.dump(plan, f, indent=1)
        f.write("\n")
    print(f"wrote {os.path.normpath(a.out)}: {len(exps)} experiments, {plan['total']} trials, commit {commit}")


if __name__ == "__main__":
    sys.exit(main())
