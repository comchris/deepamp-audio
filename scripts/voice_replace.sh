#!/usr/bin/env bash
# voice_replace.sh - the measured order of the voice-replacement route, as one runnable chain.
#
# Written 2026-10-13 after the first full run of this route on the Terminator-2 clip (see
# yt-downloads/extracted/fullregression_20261013/REPORT.md and WORKFLOW_VOICE_REPLACE.md). It exists because the
# route has a natural failure mode: each stage costs tens of CPU minutes on a shared lane, and the expensive
# mistakes are all made in the cheap local stages - a window separated too short to cover the picture, a script
# whose lines cannot be spoken in the seconds their speakers had, a part the planner already called over budget.
#
# WHAT THIS SCRIPT RUNS: only the local, cheap, reversible stages, and only in the order that was measured to
# work. WHAT IT DOES NOT RUN: every stage that asks the fleet for an hour of generation. Those are printed as
# the exact command to run, because dispatching them is a deliberate act against a shared lane and this script
# must not do it by accident. Each printed lane command is the shape that was actually used on this material,
# with the model read from the lane at run time rather than carried in this file (T-894).
#
# Usage:
#   scripts/voice_replace.sh plan   --dir <workdir> --stem <vocals.wav> --diar-json <resp.json> \
#                                   --map speaker_0=NAME --map speaker_1=NAME [--rate 16.3] \
#                                   [--sep-model M] [--diar-model M] [--asr-model M]
#   scripts/voice_replace.sh budget --dir <workdir> --script <scene.json> [--rate 16.3]
#   scripts/voice_replace.sh import --dir <workdir> --diar-json <resp.json> --map ... --out <scene.json> [--model M]
#   scripts/voice_replace.sh status --dir <workdir>
set -euo pipefail

SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API="${DEEPAMP_API:-${AUDIO_PLAY_API:-${DSH_WEB_URL:-http://127.0.0.1:3080}/api/deepamp}}"   # T-744: DEEPAMP_API first, the older name still accepted
RATE_DEFAULT=16.3   # moss_ttsd, measured 2026-10-13: 1247 chars over 76.7 estimated seconds

# T-894 (WM-23 item 9, the rule `agent_control.sh` already follows in this package): no model is carried in
# this file any more. The model each printed lane command names is READ from the lane at run time --
# `GET get_models?fn=` -- preferring a model the engine already has loaded, because a default that forces a
# cold model load is a cost and not a default. A flag names one outright and the read is not asked. When a
# read answers nothing usable, the command is printed with a placeholder that names the read which answers
# it, rather than with a name this file carried and a later lane would refuse. Measured 2026-11-19, because
# it decides one line of this route: the tts catalog read carries the tasks `tts`, `clon` and `vdes` and no
# `sep` task at all, so the separator is the one model here that cannot be picked by task from that read.
MODEL=""        # --model       : the scene render model (import)
SEPMODEL=""     # --sep-model   : the separation model (plan)
DIARMODEL=""    # --diar-model  : the diarisation model (plan)
ASRMODEL=""     # --asr-model   : the transcription model (plan)

step() { printf '\n=== %s ===\n' "$*"; }
lane() { printf 'LANE (not run here, it costs lane time): %s\n' "$*"; }

resolve_model() { # resolve_model FN [TASK] -> one model id read from the lane, or an empty answer
  local fn="${1:-tts}" task="${2:-}" read
  read="$(curl -s --max-time 15 "$API/get_models?fn=$fn" 2>/dev/null || true)"
  printf '%s' "$read" | python3 -c '
import json, sys
task = (sys.argv[1] or "").lower()
try:
    models = json.load(sys.stdin).get("models") or []
except Exception:
    models = []
rows = [m for m in models if isinstance(m, dict) and m.get("id")]
if task:
    hit = [m["id"] for m in rows if task in str(m.get("task") or "").lower()]
    if hit:
        print(hit[0]); raise SystemExit
# No task match, or no task asked: a model the engine already has loaded is the cheap answer, because a
# pick that forces a cold load is a cost the caller was never asked to pay.
loaded = [m["id"] for m in rows if m.get("loaded")]
print((loaded or [m["id"] for m in rows] or [""])[0])' "$task"
}

fill_model() { # fill_model VAR FN TASK FLAGNAME -- a flag wins, otherwise the lane is read, and the way it
              # resolved is printed so the person running the printed command knows where the name came from
  local __var="$1" fn="$2" task="$3" flag="$4" val=""
  eval "val=\"\${$__var:-}\""
  if [ -n "$val" ]; then
    echo "model for $flag : $val -- named by the caller, no read asked"
    return 0
  fi
  val="$(resolve_model "$fn" "$task")"
  if [ -n "$val" ]; then
    echo "model for $flag : $val -- read from the lane at GET $API/get_models?fn=$fn${task:+ (task $task)}; $flag overrides it"
  else
    val="<read GET $API/get_models?fn=$fn${task:+ and pick a task $task model}>"
    echo "model for $flag : the lane read answered nothing usable, so the command carries a placeholder and no name. Read the lane, then pass $flag."
  fi
  eval "$__var=\$val"
}

WORK=""
STEM=""
DIAR=""
SCRIPT=""
OUT=""
MAPS=()
RATE="$RATE_DEFAULT"

parse() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir) WORK="$2"; shift 2 ;;
      --stem) STEM="$2"; shift 2 ;;
      --diar-json) DIAR="$2"; shift 2 ;;
      --script) SCRIPT="$2"; shift 2 ;;
      --out) OUT="$2"; shift 2 ;;
      --map) MAPS+=("$2"); shift 2 ;;
      --rate) RATE="$2"; shift 2 ;;
      --model) MODEL="$2"; shift 2 ;;
      --sep-model) SEPMODEL="$2"; shift 2 ;;
      --diar-model) DIARMODEL="$2"; shift 2 ;;
      --asr-model) ASRMODEL="$2"; shift 2 ;;
      *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
  done
  if [ -z "$WORK" ]; then echo "--dir <workdir> is required" >&2; exit 2; fi
  cd "$WORK"
}

cmd="${1:-status}"; shift || true
parse "$@"

case "$cmd" in
  import)
    [ -n "$DIAR" ] && [ -n "$OUT" ] || { echo "import needs --diar-json and --out" >&2; exit 2; }
    [ ${#MAPS[@]} -gt 0 ] || { echo "import needs at least one --map LABEL=NAME" >&2; exit 2; }
    mapargs=(); for m in "${MAPS[@]}"; do mapargs+=(--map "$m"); done
    step "1. import the diarisation as a multi-speaker script, fitted to the renderer's rate ($RATE chars/s)"
    python3 "$SCRIPTS/transcript_to_script.py" --diar-json "$DIAR" "${mapargs[@]}" \
      --out "$OUT" --out-text "${OUT%.json}.txt" --fit-rate "$RATE" --frame-seconds 30
    step "2. predict the fit BEFORE asking the lane for a render"
    set +e
    python3 "$SCRIPTS/script_budget.py" --script "$OUT" --chars-per-second "$RATE" --frame-seconds 30 \
      --out "${OUT%.json}.budget.json"
    rc=$?; set -e
    if [ $rc -ne 0 ]; then
      echo "STOP: script_budget exited $rc. Fix the TEXT (its character budget per line), not the timing margin."
      echo "A render that is predicted to overrun costs ~15 CPU minutes to prove what this line already says."
      exit $rc
    fi
    step "3. the two lane commands, with the render model read from the lane"
    fill_model MODEL tts tts --model
    echo "   A cast of registered plugin voices is taken by a voice_samples family only, and the door is what"
    echo "   says so when the family named is not one. --model overrides this read; nothing here is a default."
    lane "curl -s -X POST -H 'Content-Type: application/json' -d '{\"model\":\"$MODEL\",\"file\":\"$(pwd)/$OUT\",\"max_speakers\":${#MAPS[@]},\"part_seconds\":45,\"dry_run\":true}' $API/batch_plan"
    echo "Run the dry plan next: it answers the cast, the part split and over_budget without queueing anything."
    lane "curl -s -X POST -H 'Content-Type: application/json' -d '{\"model\":\"$MODEL\",\"file\":\"$(pwd)/$OUT\",\"max_speakers\":${#MAPS[@]},\"part_seconds\":45}' $API/dispatch_batch"
    ;;
  budget)
    [ -n "$SCRIPT" ] || { echo "budget needs --script" >&2; exit 2; }
    step "predict per-line fit against each speaker's own seconds"
    if [ -n "$DIAR" ]; then
      mapargs=(); for m in "${MAPS[@]}"; do mapargs+=(--map "$m"); done
      python3 "$SCRIPTS/script_budget.py" --script "$SCRIPT" --diar-json "$DIAR" "${mapargs[@]}" \
        --chars-per-second "$RATE" --frame-seconds 30
    else
      python3 "$SCRIPTS/script_budget.py" --script "$SCRIPT" --chars-per-second "$RATE" --frame-seconds 30
    fi
    ;;
  plan)
    [ -n "$STEM" ] && [ -n "$DIAR" ] || { echo "plan needs --stem and --diar-json" >&2; exit 2; }
    step "what the route still owes the lane, in order, for this stem"
    echo "stem in hand : $STEM"
    ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$STEM" | \
      awk '{printf "stem seconds : %s  (a separated stem is exactly as long as what was separated)\n", $1}'
    echo "diar in hand : $DIAR"
    python3 - "$DIAR" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
t=d.get("speaker_turns") or []
by={}
for x in t:
    k=str(x.get("speaker_id")); s=max(0.0,float(x.get("end",0))-float(x.get("start",0))); c=len((x.get("text") or "").strip())
    a=by.setdefault(k,[0,0.0,0]); a[0]+=1; a[1]+=s; a[2]+=c
print("turns %d over %d speaker labels" % (len(t), len(by)))
for k,v in sorted(by.items()):
    rate=(v[2]/v[1]) if v[1] else 0.0
    print("   %-12s %2d turns  %6.2f s  %4d chars  %5.1f chars/second (what this speaker actually did)" % (k,v[0],v[1],v[2],rate))
PY
    step "longest clean sample each speaker could give (this is the ceiling on a clone sample)"
    python3 - "$DIAR" "${MAPS[@]:-}" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); maps={}
for pair in sys.argv[2:]:
    if "=" in pair:
        k,v=pair.split("=",1); maps[k.strip()]=v.strip()
by={}
for x in (d.get("speaker_turns") or []):
    k=str(x.get("speaker_id")); s=max(0.0,float(x.get("end",0))-float(x.get("start",0)))
    by.setdefault(k,[0.0,0]); by[k][0]+=s; by[k][1]+=1
for k,v in sorted(by.items()):
    name=maps.get(k,"(unmapped)")
    flag="under the 20 s target" if v[0] < 20.0 else "meets the 20 s target"
    print("   %-12s %-14s %6.2f s across %d turns  %s" % (k, name, v[0], v[1], flag))
PY
    echo
    echo "Ceiling rule measured on this material: a speaker's TOTAL attributed speech is the ceiling for one clean"
    echo "sample from them. Sarah's block gave 14.08 s across 10 turns and no 20 s sample exists for her; asking for"
    echo "one means separating a longer window, not cutting harder."
    fill_model DIARMODEL stt diar --diar-model
    fill_model ASRMODEL stt asr --asr-model
    if [ -n "$SEPMODEL" ]; then
      echo "model for --sep-model : $SEPMODEL -- named by the caller, no read asked"
    else
      SEPMODEL="<pass --sep-model>"
      echo "model for --sep-model : no read is asked here on purpose. Measured 2026-11-19: GET get_models?fn=tts"
      echo "   answers the tasks tts, clon and vdes and no sep task at all, so that read cannot name a separator."
    fi
    lane "curl -s -X POST -H 'Content-Type: application/json' -d '{\"file_path\":\"<the source wav>\",\"task_kind\":\"sep\",\"model\":\"$SEPMODEL\"}' $API/dispatch_task   # separation: 44100 Hz input, stem length == input length, ~15.25 s of lane per second of audio"
    lane "curl -s -X POST -H 'Content-Type: application/json' -d '{\"file_path\":\"<stem>\",\"diar_model\":\"$DIARMODEL\",\"asr_model\":\"$ASRMODEL\",\"return_timestamps\":true}' $API/dispatch_speaker_asr"
    lane "curl -s -X POST -H 'Content-Type: application/json' -d '{\"name\":\"<voice>\",\"file_path\":\"<sample.wav>\",\"asr_model\":\"$ASRMODEL\",\"transcribe\":true}' $API/save_voice   # the transcription model is named by the caller since T-892: this door carries no default for it"
    ;;
  status)
    step "workdir contents, so the next run knows where the chain stopped"
    ls -l --time-style=+%Y-%m-%dT%H:%M 2>/dev/null | grep -vE '^total' | head -30 || true
    for d in stems samples_kitchen render render_kitchen artifacts; do
      [ -d "$d" ] && printf '%-16s %s file(s)\n' "$d/" "$(ls -1 "$d" 2>/dev/null | wc -l)"
    done
    ;;
  *)
    echo "unknown stage: $cmd  (expected: import | budget | plan | status)" >&2
    exit 2
    ;;
esac
