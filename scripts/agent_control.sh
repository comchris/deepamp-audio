#!/usr/bin/env bash
# agent_control.sh — command-line control of the Audi Play plugin HTTP API.
#
# Everything the floating panel can do is also a plain HTTP call, so an agent
# (or a shell script, or cron) can drive TTS/STT without touching the browser.
# This script wraps those calls with sensible defaults and readable output.
#
# Base URL:  ${AP_ORIGIN}/api/deepamp   (AP_ORIGIN defaults to $DSH_WEB_URL; override with AP_BASE=...)
# Audio files are served at  ${AP_ORIGIN}/deepamp/<job_id>  (Range-aware).
#
# USAGE
#   agent_control.sh status                        server_status + queue_status + save paths
#   agent_control.sh endpoints                     configured endpoints (tts/stt)
#   agent_control.sh set-endpoint FN URL [ROUTE]   ROUTE = speech (default) | tasks
#   agent_control.sh models [FN]                   models for fn (default tts)
#   agent_control.sh voices FN [MODEL]             voices for fn (+ model)
#   agent_control.sh load FN MODEL | unload FN MODEL
#
#   agent_control.sh say TEXT [--model M] [--voice V] [--format wav|mp3|ogg] [--instructions TXT] [--wait]
#       Queued TTS dispatch. Never rejects when busy: returns job_id + position.
#       --instructions TXT rides to the engine as options["instruction"]: the
#       voice-design prompt for a vdes model, or the style/emotion fine-control for a
#       design-capable model (qwen3-tts/customvoice, omnivoice, voxcpm2, breeze).
#       --wait polls to a terminal status and prints the file/route when done.
#   agent_control.sh listen FILE [--model M]       STT of an audio file ON THE DSH
#                                                  HOST's filesystem (transcript
#                                                  comes back inline).
#   agent_control.sh task KIND MODEL [FLAGS]       tool lane via /v1/tasks/run:
#                                                  KIND = sep | gen | vc | s2s (the wire
#                                                  task of MODEL decides the lane).
#                                                  --file PATH | --text TXT | --voice V |
#                                                  --target-file P | --target-job ID |
#                                                  --opt K=V (repeat) | --wait.
#   agent_control.sh wait JOB_ID                   poll one job to a terminal status
#   agent_control.sh download JOB_ID [DEST]        save the job's audio/transcript
#
#   agent_control.sh batch FILE [--model M] [--title T] [--part-seconds S]
#                          [--cost-per-second C] [--max-speakers N] [--save-dir DIR] [--wait]
#       Whole scene -> bounded takes on a model read from the rendering lane (dispatch_batch). With
#       no --model the model is taken from get_models and the choice is printed; FILE is a batch
#       JSON in either shape the audiobook pipeline already uses: scene_config+dialogue (Web UI) or
#       batch_config+items (CLI). --part-seconds is a wish; the host caps it at
#       job_timeout / cost_per_second so a part can never be aborted mid-render.
#       --save-dir makes every finished part land there as <batch_id>_pNN.wav.
#       --wait polls the whole batch to a terminal state and prints the part table.
#   agent_control.sh batch-status BATCH_ID          one batch: parts, done, failed, delivered
#
#   agent_control.sh play FILE [TITLE]              queue an existing audio file for listening
#                                                  (play_file: copies it into the output dir,
#                                                  registers a kind:"file" row, no engine load).
#                                                  Safe with filenames containing spaces/pipes.
#   agent_control.sh verify BATCH_ID [--asr] [--max-wait N]
#                                                  diar every finished part and compare the
#                                                  speakers heard against the cast the host sent;
#                                                  --asr also scores how much of the script was
#                                                  actually spoken. Writes a report under
#                                                  the plugin's artifacts/ dir.
#
#   agent_control.sh playlist [N]                  latest N rows (default 15) as a table
#   agent_control.sh job JOB_ID                    full job row (JSON)
#   agent_control.sh cancel JOB_ID                 dequeue (queued) or kill (running)
#   agent_control.sh delete JOB_ID [--file]        remove row; --file also rm's the file
#   agent_control.sh clear                         clear the whole playlist (rows only)
#
#   agent_control.sh pause FN | resume FN          queue control (tts|stt)
#   agent_control.sh save-path [DIR]               show or set the TTS save directory
#                                                  (DIR empty/"default" resets it)
#
# NOTES
#   - CPU audio.cpp loads ONE model at a time: dispatches run strictly FIFO per
#     endpoint; just fire them and poll, do not parallelize across jobs.
#   - Never curl the remote TTS server (/status) while a job is generating; poll
#     THIS API (job/playlist) instead.
#   - Exit code: 0 ok, 1 usage, 2 HTTP/host error, 3 job ended error/aborted.
set -u

ORIGIN="${AP_ORIGIN:-${DSH_WEB_URL:-http://127.0.0.1:3080}}"
BASE="${AP_BASE:-$ORIGIN/api/deepamp}"

die() { echo "agent_control: $1" >&2; exit "${2:-2}"; }
usage() { awk 'NR>1 { if ($0 !~ /^#/) exit; line = $0; sub(/^# ?/, "", line); print line }' "$0"; exit 1; }

req() { # req METHOD PATH [JSON_BODY]
  local m="$1" p="$2" b="${3:-}"
  if [ "$m" = GET ]; then
    curl -fsS --max-time 3600 "$BASE$p" 2>/dev/null || die "GET $p failed (is dsh web up? plugin loaded?)"
  else
    curl -fsS --max-time 3600 -X POST -H 'content-type: application/json' \
      --data-raw "$b" "$BASE$p" 2>/dev/null || die "POST $p failed (is dsh web up? plugin loaded?)"
  fi
}

py() { python3 -c "$1" ; } # py PROGRAM (stdin = JSON)

jqp() { # jqp EXPR  — python eval against json.load(stdin), print result
  python3 -c 'import sys,json; v=json.load(sys.stdin); r=('"$1"'); print("" if r is None else (json.dumps(r) if isinstance(r,(dict,list)) else r))'
}

post_json() { # post_json KEY=VAL... (string values, safely encoded)
  python3 - "$@" <<'PY'
import json, sys
d = {}
for a in sys.argv[1:]:
    k, _, v = a.partition('=')
    if v == '': d[k] = v
    elif v in ('true','false'): d[k] = (v == 'true')
    else:
        try: d[k] = json.loads(v)
        except Exception: d[k] = v
print(json.dumps(d))
PY
}

poll_job() { # poll_job ID — prints final row JSON to stdout, progress to stderr
  local id="$1" st=""
  while :; do
    local row; row="$(req GET "/job_status/$id")"
    st="$(printf '%s' "$row" | jqp 'v.get("status")')"
    case "$st" in ok|error|aborted|cancelled) printf '%s\n' "$row"; [ "$st" = ok ] && return 0 || return 3;; esac
    local act pos
    act="$(printf '%s' "$row" | jqp 'v.get("activity") or ""')"
    pos="$(printf '%s' "$row" | jqp 'v.get("position") or ""')"
    echo "  [$id] $st${pos:+ #$pos}${act:+ $act}" >&2
    sleep 2
  done
}

poll_batch() { # poll_batch ID — waits for the whole batch, prints the aggregate row
  local id="$1"
  local row parts ndone failed running
  while :; do
    row="$(req GET "/batch_status/$id")"
    parts="$(printf '%s' "$row" | jqp 'v.get("parts") or 0')"
    ndone="$(printf '%s' "$row" | jqp 'v.get("done") or 0')"
    failed="$(printf '%s' "$row" | jqp 'v.get("failed") or 0')"
    running="$(printf '%s' "$row" | jqp 'v.get("running") or 0')"
    echo "  [$id] parts=$parts done=$ndone failed=$failed running=$running" >&2
    [ "$running" = 0 ] && break
    sleep 10
  done
  printf '%s\n' "$row"
  [ "$failed" = 0 ] && return 0 || return 3
}

# --- the model is read from the lane, not carried here (WM-23 item 9, plugin card T-775) ------
# The operator's ruling of 2026-11-10 on the scripts this package ships, verbatim: "the other scripts
# should have default fallbacks". A model a script names is a claim with no date, and this one had gone
# stale in exactly the way the rule exists to prevent: the live catalog read of 2026-11-10 lists
# `moss_ttsd_q8`, `moss_ttsd_q4_k` and `moss_ttsd_bf16` and NOT plain `moss_ttsd`, so the default this
# file carried was a model the lane would refuse. What happens now: the model is taken from
# `get_models?fn=`, preferring one the engine already has loaded (a default that forces a 60-120 s model
# load is not a default, it is a cost), and the fallback is a named id that is printed out loud as the
# fallback it is. Which model a job SHOULD use is still the caller's call: `--model` overrides all of
# this, and `agent_control.sh models` is the read that answers what is available.
MODEL_FALLBACK="moss_ttsd_q8"

resolve_model() { # resolve_model FN — fills $model from the live catalog, and says which way it resolved
  local fn="${1:-tts}" read
  [ -n "$model" ] && return 0
  read="$(req GET "/get_models?fn=$fn" 2>/dev/null)" || read=""
  model="$(printf '%s' "$read" | py '
import json, sys
try:
    models = json.load(sys.stdin).get("models") or []
except Exception:
    models = []
rows = [m for m in models if isinstance(m, dict) and m.get("id")]
loaded = [m["id"] for m in rows if m.get("loaded")]
print((loaded or [m["id"] for m in rows] or [""])[0])')"
  if [ -n "$model" ]; then
    echo "agent_control: model resolved from the live catalog read at $BASE: $model" >&2
  else
    model="$MODEL_FALLBACK"
    echo "agent_control: the catalog read answered nothing usable, so this runs on the named fallback $MODEL_FALLBACK. The lane may still refuse it; --model overrides this, and \`agent_control.sh models\` lists what the lane answers." >&2
  fi
}

cmd="${1:-}"; shift || true
case "$cmd" in
  status)
    echo '--- server_status'; req GET /server_status | python3 -m json.tool
    echo '--- queue_status';   req GET /queue_status 2>/dev/null | python3 -m json.tool 2>/dev/null || echo '  (older host: no queue_status — restart dsh web for rev 5)'
    echo '--- save paths';     req GET /get_save_paths 2>/dev/null | python3 -m json.tool 2>/dev/null || echo '  (older host: no get_save_paths — restart dsh web for rev 5)'
    ;;
  endpoints) req GET /get_endpoints | python3 -m json.tool ;;
  set-endpoint)
    [ $# -ge 2 ] || usage
    req POST /set_endpoint "$(post_json fn="$1" url="$2" route="${3:-speech}")" | python3 -m json.tool ;;
  models) req GET "/get_models?fn=${1:-tts}" | python3 -m json.tool ;;
  voices)
    # `voices <fn> [model]`. With no model named the engine answers no builtins at all, so an empty
    # read is not an empty registry - say what the command needs instead of printing the whole usage page.
    [ $# -ge 1 ] || { echo "voices needs <fn> [model] - fn is tts or stt; without a model the engine names no builtins" >&2; exit 2; }
    req GET "/refresh_voices?fn=$1${2:+&model=$2}" | python3 -m json.tool ;;
  load|unload)
    [ $# -ge 2 ] || usage
    req POST "/$cmd" "$(post_json fn="$1" model="$2")" | python3 -m json.tool ;;

  say)
    [ $# -ge 1 ] || usage
    text="$1"; shift
    model="" voice="" format=wav wait=0 instr=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --model) model="$2"; shift 2;;
        --voice) voice="$2"; shift 2;;
        --format) format="$2"; shift 2;;
        --instructions|--instruct) instr="$2"; shift 2;;
        --wait) wait=1; shift;;
        *) die "say: unknown flag $1" 1;;
      esac
    done
    resp="$(req POST /dispatch_tts "$(post_json text="$text" model="$model" voice="$voice" format="$format" instructions="$instr")")"
    echo "$resp" | python3 -m json.tool
    jid="$(printf '%s' "$resp" | jqp 'v.get("job_id")')"
    [ "$wait" = 1 ] || exit 0
    row="$(poll_job "$jid")"; rc=$?
    printf '%s\n' "$row" | python3 -m json.tool
    exit $rc
    ;;
  listen)
    [ $# -ge 1 ] || usage
    file="$1"; shift; model=""
    while [ $# -gt 0 ]; do case "$1" in --model) model="$2"; shift 2;; *) die "listen: unknown flag $1" 1;; esac; done
    req POST /dispatch_stt "$(post_json file_path="$file" model="$model")" | python3 -m json.tool
    ;;
  task)
    # Tool lane (T-124/125/128, 2026-09-26): KIND = sep|gen|vc|s2s on /v1/tasks/run.
    # The WIRE task of the model decides the lane; a mismatch is refused by the host
    # before any network call. Separation answers one file per stem (the row carries
    # them; download one with  curl ${ORIGIN}/deepamp/<job>?stem=<name> ).
    #   --file PATH        source audio on the dsh host disk (sep / vc / s2s)
    #   --text TXT         prompt (gen)
    #   --voice V          target voice, plugin registry name (vc)
    #   --target-file P    target sample path (vc)
    #   --target-job ID    target sample = playlist row (vc)
    #   --opt K=V          repeatable engine option (duration_seconds, guidance_scale,
    #                      num_inference_steps, seed, ...)
    #   --wait             poll to a terminal status afterwards
    [ $# -ge 2 ] || usage
    tk="$1"; model="$2"; shift 2
    wt=0; args=()
    for a in "$@"; do if [ "$a" = --wait ]; then wt=1; else args+=("$a"); fi; done
    body="$(python3 - "$tk" "$model" "${args[@]}" <<'PY'
import json, sys
tk, model = sys.argv[1], sys.argv[2]
d = {"task_kind": tk, "model": model}
opts = {}
rest = sys.argv[3:]
i = 0
while i < len(rest):
    f = rest[i]
    if i + 1 >= len(rest): sys.stderr.write("task: flag %s needs a value\n" % f); sys.exit(1)
    val = rest[i + 1]
    i += 2
    if f == "--opt":
        k, _, v = val.partition("="); opts[k] = v
    elif f == "--file": d["file_path"] = val
    elif f == "--text": d["text"] = val
    elif f == "--voice": d["target_voice"] = val
    elif f == "--target-file": d["target_wav_path"] = val
    elif f == "--target-job": d["target_job_id"] = val
    else: sys.stderr.write("task: unknown flag %s\n" % f); sys.exit(1)
if opts: d["options"] = opts
print(json.dumps(d))
PY
)" || die "task: bad arguments" 1
    out="$(req POST /dispatch_task "$body")"
    echo "$out" | python3 -m json.tool
    jid="$(echo "$out" | jqp 'v.get("job_id")')"
    if [ "$wt" = 1 ] && [ -n "$jid" ]; then poll_job "$jid" | python3 -m json.tool; fi
    ;;
  batch)
    # Scene -> bounded multi-voice takes (T-173 / T-175 / T-174). The host does the splitting,
    # the per-take cast, the [S1..Sk] tagging, the max_frames budget and — with --save-dir —
    # the delivery into the project directory as <batch_id>_pNN.wav. Parts run sequentially.
    [ $# -ge 1 ] || usage
    file="$1"; shift
    model="" title="" psec="" cost="" spk="" sdir="" wt=0
    while [ $# -gt 0 ]; do
      case "$1" in
        --model) model="$2"; shift 2;;
        --title) title="$2"; shift 2;;
        --part-seconds) psec="$2"; shift 2;;
        --cost-per-second) cost="$2"; shift 2;;
        --max-speakers) spk="$2"; shift 2;;
        --save-dir) sdir="$2"; shift 2;;
        --wait) wt=1; shift;;
        *) die "batch: unknown flag $1" 1;;
      esac
    done
    [ -f "$file" ] || die "batch: no such batch file: $file" 1
    resolve_model tts
    body="$(python3 - "$file" "$model" "$title" "$psec" "$cost" "$spk" "$sdir" <<'PY'
import json, sys
path, model, title, psec, cost, spk, sdir = sys.argv[1:8]
d = {"fn": "tts", "model": model, "file": path}
if title: d["title"] = title
if psec:  d["part_seconds"] = int(psec)
if cost:  d["cost_per_second"] = float(cost)
if spk:   d["max_speakers"] = int(spk)
if sdir:  d["save_dir"] = sdir
print(json.dumps(d))
PY
)" || die "batch: bad arguments" 1
    out="$(req POST /dispatch_batch "$body")"
    echo "$out" | python3 -m json.tool
    bid="$(echo "$out" | jqp 'v.get("batch_id")')"
    if [ "$wt" = 1 ] && [ -n "$bid" ]; then poll_batch "$bid" | python3 -m json.tool; fi
    ;;
  batch-status) [ $# -ge 1 ] || usage; req GET "/batch_status/$1" | python3 -m json.tool ;;
  play)
    # play_file (no engine load): queue an existing audio file so it can be listened to from the
    # panel. The body is built by python3 on purpose — scene WAV filenames contain spaces and
    # pipes, and a hand-written -d '{...}' body is what used to mangle them into "unsupported
    # file type ." (audiobook/AGENTS.md, learned 2026-09-23).
    [ $# -ge 1 ] || usage
    f="$1"; shift
    t="${1:-}"
    [ -f "$f" ] || die "play: no such file: $f" 1
    body="$(python3 - "$f" "$t" <<'PY'
import json, os, sys
path, title = sys.argv[1], sys.argv[2]
print(json.dumps({"path": os.path.abspath(path), "title": title or os.path.basename(path)}))
PY
)" || die "play: bad arguments" 1
    req POST /play_file "$body" | python3 -m json.tool
    ;;
  verify)
    # Thin delegation to scripts/batch_verify.py (same directory as this script) so the whole
    # batch lane is reachable from one entry point. It dispatches diar jobs through the plugin,
    # so it queues behind whatever is already running rather than fighting it.
    [ $# -ge 1 ] || usage
    here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    [ -f "$here/batch_verify.py" ] || die "verify: batch_verify.py not found next to agent_control.sh" 1
    bid="$1"; shift
    exec python3 "$here/batch_verify.py" --batch-id "$bid" "$@"
    ;;
  wait) [ $# -ge 1 ] || usage; poll_job "$1" | python3 -m json.tool ;;
  download)
    [ $# -ge 1 ] || usage
    jid="$1"; dest="${2:-$jid.audio}"
    curl -fS --max-time 600 "$ORIGIN/deepamp/$jid" -o "$dest" || die "download failed (job not ok, or file gone)"
    echo "saved -> $dest"
    ;;

  playlist)
    n="${1:-15}"
    req GET "/playlist_list?page_size=$n" | python3 -c '
import sys, json
d = json.load(sys.stdin)
qs = d.get("queues") or {}
for fn, q in qs.items():
    print("%s queue: %s running=%s queued=%s" % (fn, "PAUSED" if q.get("paused") else "live", q.get("running") or "-", q.get("queued", 0)))
fmt = lambda s, w: (str(s) if s not in (None, "") else "-")[:w].ljust(w)
print(fmt("JOB",9), fmt("FN",4), fmt("STATUS",9), fmt("MODEL",14), fmt("VOICE",12), fmt("DUR",7), fmt("FILE",46))
for j in d.get("items", []):
    dur = j.get("duration"); durs = ("%.1fs" % dur) if dur else "-"
    extra = ""
    if j.get("status") == "queued":  extra = " #%s%s" % (j.get("position", "?"), " (paused)" if j.get("waiting_for_model") else "")
    if j.get("status") == "running": extra = " (%s)" % (j.get("activity") or "running")
    print(fmt(j.get("id"),9), fmt(j.get("fn"),4), fmt((j.get("status") or "")+extra,9), fmt(j.get("model"),14), fmt(j.get("voice"),12), fmt(durs,7), fmt(j.get("filename"),46))
'
    ;;
  job) [ $# -ge 1 ] || usage; req GET "/job_status/$1" | python3 -m json.tool ;;
  cancel) [ $# -ge 1 ] || usage; req POST "/cancel_job/$1" '{}' | python3 -m json.tool ;;
  delete)
    [ $# -ge 1 ] || usage
    jid="$1"; delfile=false; [ "${2:-}" = --file ] && delfile=true
    req POST /playlist_delete "$(post_json job_id="$jid" delete_file="$delfile")" | python3 -m json.tool
    ;;
  clear) req POST /playlist_clear '{}' | python3 -m json.tool ;;

  pause|resume)
    [ $# -ge 1 ] || usage
    req POST "/${cmd}_fn" "$(post_json fn="$1")" | python3 -m json.tool ;;
  save-path)
    if [ $# -eq 0 ]; then req GET /get_save_paths | python3 -m json.tool
    else
      d="$1"; [ "$d" = default ] && d=""
      req POST /set_save_path "$(post_json dir="$d")" | python3 -m json.tool
    fi
    ;;
  *) usage ;;
esac
