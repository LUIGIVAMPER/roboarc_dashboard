#!/usr/bin/env python3
"""Write data/tasks.json: the release's task bases, each with its family, task type, machine type, allowed seeds and
the container caps its task.toml declares.

    python3 tools/build_tasks.py <RoboARC checkout> [--ref origin/main]

Run it again after a RoboARC release that adds, removes or changes bases. It reads the files with `git show <ref>:...`,
so the checkout's working tree is never touched.
"""
import argparse
import json
import os
import re
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data", "tasks.json")

# Task types (material x constraint) and their families; the same six classes as the paper's results table.
CATEGORIES = [
    ("rigid", "Interlocking puzzles", ["interlocked-claws", "cast-keyhole", "cast-coil", "horseshoe-ring"]),
    ("rigid", "Narrow-passage traversal", ["hedgehog-in-cage", "buzz-wire-3d", "lock-picking"]),
    ("rigid", "Fitting and assembly", ["bed-bolt", "clock-assembling", "battery-replacement", "caliper-sorting", "ikea"]),
    ("deformable", "Untangling", ["knot-untying", "slotted-post-ring", "orbits"]),
    ("deformable", "Threading and routing", ["rope-threading", "fiber-bundling", "wire-splicing"]),
    ("deformable", "Shape control", ["blanket-flatten", "blanket-fold"]),
]
FAMILY_NAMES = {
    "interlocked-claws": "Interlocked claws", "cast-keyhole": "Cast keyhole", "cast-coil": "Cast coil",
    "horseshoe-ring": "Horseshoe ring", "hedgehog-in-cage": "Hedgehog in cage", "buzz-wire-3d": "3D buzz wire",
    "lock-picking": "Lock picking", "bed-bolt": "Bed bolt", "clock-assembling": "Clock assembling",
    "battery-replacement": "Battery replacement", "caliper-sorting": "Caliper sorting", "ikea": "IKEA furniture",
    "knot-untying": "Knot untying", "slotted-post-ring": "Slotted post ring", "orbits": "Orbits",
    "rope-threading": "Rope threading", "fiber-bundling": "Fiber bundling", "wire-splicing": "Wire splicing",
    "blanket-flatten": "Blanket flatten", "blanket-fold": "Blanket fold",
}
OWN_GROUP = {"roboarc-wire-splicing-01-i01"}  # 6 h budget, ranked as a group of its own


def git_show(repo, ref, path):
    return subprocess.run(["git", "-C", repo, "show", f"{ref}:{path}"], check=True, capture_output=True, text=True).stdout


def family(base):
    if base.startswith("roboarc-ikea-"):
        return "ikea"
    m = re.fullmatch(r"roboarc-(.+)-\d\d-i\d\d", base)
    assert m, base
    return m.group(1)


def section(toml, name):
    """The lines of one [name] table of a task.toml (no TOML parser needed for these flat keys)."""
    m = re.search(r"^\[" + re.escape(name) + r"\]\n(.*?)(?=^\[|\Z)", toml, re.M | re.S)
    return m.group(1) if m else ""


def value(sec, key):
    """A key's value: a quoted string without its quotes, else the text before any trailing comment."""
    m = re.search(r"^" + key + r'\s*=\s*(?:"([^"]*)"|([^#\n]*))', sec, re.M)
    if not m:
        return None
    return m.group(1) if m.group(1) is not None else m.group(2).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("repo")
    ap.add_argument("--ref", default="origin/main")
    args = ap.parse_args()

    names = subprocess.run(["git", "-C", args.repo, "ls-tree", "--name-only", args.ref, "tasks/"],
                           check=True, capture_output=True, text=True).stdout.split()
    bases = sorted(n[len("tasks/"):-len("-privileged")] for n in names if n.endswith("-privileged"))
    easy = set(re.findall(r'^base\s*=\s*"([^"]+)"', git_show(args.repo, args.ref, "docs/easy_set.toml"), re.M))
    version = re.search(r'^version\s*=\s*"([^"]+)"', git_show(args.repo, args.ref, "pyproject.toml"), re.M).group(1)
    where = {f: (mat, cat) for mat, cat, fs in CATEGORIES for f in fs}

    tasks = []
    for b in bases:
        toml = git_show(args.repo, args.ref, f"tasks/{b}-privileged/task.toml")
        env, meta = section(toml, "environment"), section(toml, "metadata")
        seeds = json.loads(value(section(toml, "metadata.seeds"), "allowed") or "[0]")
        fam = family(b)
        mat, cat = where[fam]
        tasks.append({
            "base": b, "family": fam, "family_name": FAMILY_NAMES[fam], "category": cat, "material": mat,
            "difficulty": value(meta, "difficulty") or "", "seeds": seeds,
            "easy_set": b in easy, "own_group": b in OWN_GROUP,
            "cpus": float(value(env, "cpus") or 0), "memory_mb": int(float(value(env, "memory_mb") or 0)),
        })
    assert {t["family"] for t in tasks} == set(where), {t["family"] for t in tasks} ^ set(where)
    commit = subprocess.run(["git", "-C", args.repo, "rev-parse", "--short=8", args.ref],
                            check=True, capture_output=True, text=True).stdout.strip()
    out = {"release": version, "commit": commit, "modes": ["privileged", "standard"], "trials_per_task_mode": 3,
           "categories": [{"material": m, "name": c, "families": fs} for m, c, fs in CATEGORIES], "tasks": tasks}
    with open(OUT, "w") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)
        f.write("\n")
    print(f"wrote {os.path.normpath(OUT)}: {len(tasks)} bases of RoboARC {version} ({commit}), "
          f"{sum(t['easy_set'] for t in tasks)} in the easy set")


if __name__ == "__main__":
    main()
