# RoboARC run dashboard

A static site that tracks the external RoboARC runs delivered to the Hugging Face dataset
[RoboARC/RoboARC-outputs](https://huggingface.co/datasets/RoboARC/RoboARC-outputs): progress of each harness + model
pair (90 task bases x 2 modes x 3 trials = 540 trials), the machine and runner settings of every delivery, errors and
reruns with their logs, a per-task matrix and the first frames.

## How it works

- `index.html`, `assets/`: the page. No build step, no framework. `assets/common.js` holds what the two pages share.
- On every load the browser lists the dataset through the Hugging Face API (main and open pull requests) and reads the
  `MANIFEST.md` and `index.json` of any delivery the digest has not seen yet, so a new upload shows up at once.
- `tools/digest.py` (standard library only) reads every new delivery in full: the official per-trial results from
  `batch.tar.gz`, and from each `jobs/<job>.tar.gz` the Harbor exception, the grader's reward fields, peak memory and GPU
  memory and the log tails. It writes `data/digest.json` and `data/bundles/*.json`. A delivery is never overwritten in
  the dataset, so each one is digested once.
- `.github/workflows/digest.yml` runs the digest every 30 minutes, commits `data/` when it changed and publishes the
  site to GitHub Pages.
- Opening a trial (a row of the errors table, a square of the task matrix, a trial of a delivery) goes to its timeline,
  `timeline.html?rev=<revision>&path=<helper>/<batch>/<bundle>&job=<job>&trial=<trial dir>`: every model turn of the agent
  (Harbor's ATIF trajectory, `agent/trajectory.json`: thinking, messages, each command with its output, tokens) merged by
  time with the robot's record (`artifacts/data/episode.jsonl` in standard mode, the self-reported
  `rcb_session_log.jsonl` in privileged mode), with an activity strip, filters and a search. The page reads them from
  the trial's job archive on Hugging Face in the browser and stops downloading once it has them (the archive is sorted
  by name, so they come first), so a delivery has its timelines before it is digested and nothing is added to `data/`.
  The result panel above the timeline is the digest's record of the trial, or the delivery's `index.json` before then.
- The timeline page also plays the trial's replay video, on request: it reads the same archive on to
  `artifacts/data/replay.mp4` (standard mode: the sim service's replay of the live episode) or `verifier/replay.mp4`
  (privileged mode: the verifier's replay of the submitted trajectory), with the frame map and recording manifest next
  to it. A gzip archive cannot be read from the middle, so this downloads the archive up to the video, in standard mode
  nearly all of it. In standard mode each robot row jumps the video to the start of its motion (the control steps
  before its call, from the robot service's checkpoints, times the replay's simulated time per step, looked up in the
  frame map), and the line under the video names the call on screen. The replay's forcing and review events are listed
  as jump points. In privileged mode the agent built the trajectory offline, so the rows have no moment in the video.
- Run time: each trial's wall time is Harbor's `started_at` to `finished_at`. A pair's estimated total time is
  elapsed + work left / parallelism, where elapsed runs from its first trial's start to its last trial's end, the
  work left is the expected wall time of every trial without a result (the median of the same pair and base, else of
  the base, the family, the pair, all trials), and parallelism is the summed wall time of its trials over elapsed.

The delivery format is RoboARC's `scripts/send_results.sh`: `<helper>/<batch>/<bundle id>/` with `MANIFEST.md`,
`index.json`, `SHA256SUMS`, `INVENTORY.tsv`, `batch.tar.gz` and `jobs/<job>.tar.gz`.

## Set up

1. Create a GitHub repository and push this directory to its `main` branch.
2. Settings > Pages > Build and deployment > Source: **GitHub Actions**.
3. Settings > Actions > General: allow actions, and "Read and write permissions" for the workflow token.
4. Run the workflow once (Actions > digest and publish > Run workflow). The site is then at
   `https://<owner>.github.io/<repository>/`.

## Data files

| File | Written by | When to change it |
|---|---|---|
| `data/tasks.json` | `python3 tools/build_tasks.py <RoboARC checkout> [--ref origin/main]` | after a RoboARC release that changes the task bases |
| `data/targets.json` | by hand | the harness + model pairs the run must cover, with the patterns that match a delivery's runner line or run id |
| `data/helpers.json` | by hand | the name printed for each helper in the daily progress text |
| `data/frames.json`, `frames/` | by hand (renders) | first frames: `frames[<base>][<seed>] = "frames/<base>/seed<k>.jpg"` |
| `data/digest.json`, `data/bundles/` | `tools/digest.py` (the workflow) | never by hand |

## Local preview

    python3 tools/digest.py                 # or: --local <dir with <helper>/<batch>/<bundle>/ bundles>
    python3 -m http.server 8000             # then open http://localhost:8000/ (add ?offline to skip the live listing)
