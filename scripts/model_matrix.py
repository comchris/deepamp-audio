#!/usr/bin/env python3
"""Serialized TTS model matrix through the DEEPAMP plugin API, across named engine slots.

WHY THIS EXISTS. The older `model_sweep.py` in the source tree swept the primary lane only: it read
`/get_models?fn=tts` (the primary's catalog) and dispatched with no pin, so a "matrix" was one engine's
numbers. This runner is the two-node form the operator asked for on 2026-11-08 ("test runs: model matrix on
the 2 CPU nodes"): it asks EACH slot for its OWN catalog with `POST endpoint_models {fn,id}`, plans against
that list, and pins every dispatch to the slot the row belongs to. audio.cpp loads one model per endpoint
(`max_loaded_models=1`), so the run is strictly serialized: one dispatch, poll to a terminal status, then the
next. Load time and generation time are recorded separately per model, with family and quant frozen into each
row, so a result says which engine and which file produced it.

HARD GATES
  * dry-run by DEFAULT. Nothing is dispatched until `--go`.
  * no model name is baked in here: every candidate comes from the slot's own catalog, read at run time.
  * no address is baked in here: the origin comes from $DSH_WEB_URL (or --origin), the slots from
    `GET endpoint_registry?fn=`.
  * refuses to start if the lane is paused or the queue has anything running or queued (--ignore-busy to pass).
  * refuses an empty or missing --text-file when --go is given. Testing Discipline: real story dialogue only,
    never a fabricated test sentence.
  * writes only inside this package: the run directory under `artifacts/`, never outside the package unless
    --out names a path.

EXAMPLES
  # what would run, nothing dispatched:
  python3 scripts/model_matrix.py --text-file ../scratch/matrix_text.txt
  # the run itself, both CPU slots:
  python3 scripts/model_matrix.py --go --text-file ../scratch/matrix_text.txt
  # one slot, a bounded slice, a voice for the clone models:
  python3 scripts/model_matrix.py --go --slots e-11 --limit 6 --default-voice <name from voice_registry>

Results land in `artifacts/model_matrix/<UTC timestamp>/` as plan.json, matrix.json and SUMMARY.md.
"""

import argparse
import datetime
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

TERMINAL = ("ok", "error", "aborted", "cancelled")
TTS_TASKS = ("tts", "clon")
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = os.path.join(HERE, "..", "artifacts", "model_matrix")


def die(msg, code=2):
    print("ERROR: " + msg, file=sys.stderr)
    sys.exit(code)


def origin_of(args):
    o = args.origin or os.environ.get("DSH_WEB_URL") or os.environ.get("AP_ORIGIN") or ""
    if not o:
        die("no harness origin: pass --origin or set DSH_WEB_URL (the plugin's verbs live on the harness HTTP surface)")
    return o.rstrip("/") + "/api/deepamp"


class Api:
    def __init__(self, base):
        self.base = base

    def call(self, method, path, body=None, timeout=60):
        url = self.base + path
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(url, data=data, method=method,
                                    headers={"content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as e:
            try:
                return json.loads(e.read().decode("utf-8") or "{}")
            except Exception:
                die("HTTP %s on %s" % (e.code, path))
        except Exception as e:
            die("%s on %s: %s" % (method, path, e))

    def get(self, path, timeout=60):
        return self.call("GET", path, None, timeout)

    def post(self, path, body, timeout=60):
        return self.call("POST", path, body, timeout)


def wait_lane_free(api, fn, url, sid, cap, min_pause):
    """Wait until the target lane is free before the next dispatch, bounded by cap seconds. Returns
    (waited_s, note). This replaces the fixed --settle sleep of the first version.
    Why it exists (operator item 10 of 2026-11-08, and the four 503s of the 2026-11-07 run that read
    "max_loaded_models=1 and every loaded model is busy"): an engine with max_loaded_models=1 releases the
    model a finished row used a moment after that row ends, and a dispatch sent 2 s later lands on an engine
    that is still holding it. The gate is the plugin's lane state, because that is the busy signal: a job the lane
    is still running. What the engine is holding is read and reported on the row, not waited off — corrected the same
    day this function was first written, on this measurement: a live engine's model entry carries `loaded` and
    nothing that says busy, and these units run `--idle-unload-ms 3600000`, so a model stays resident for an hour
    and a matrix WANTS a resident model, it is the row that pays no load. Waiting for `loaded` to disappear is
    waiting for an idle timer, not for a lane. A wait that reaches its cap dispatches anyway and says so: a matrix
    that refuses to try is a matrix with a hole in it."""
    t0 = time.time()
    if min_pause:
        time.sleep(min_pause)
    last = ""
    while time.time() - t0 < cap:
        try:
            qs = api.get("/queue_status", timeout=20).get("queues", {}).get(fn, {})
            if qs.get("running"):
                last = "the plugin's %s lane still reports a running job" % fn
                time.sleep(3)
                continue
        except Exception as ex:
            last = "queue_status unreadable (%s)" % ex
        if not url:
            return round(time.time() - t0, 1), "no engine url for slot %s; waited on the lane state only" % sid
        try:
            with urllib.request.urlopen(url + "/v1/models", timeout=20) as r:
                body = json.loads(r.read().decode("utf-8") or "{}")
            entries = [m for m in (body.get("data") or body.get("models") or []) if isinstance(m, dict)]
            loaded = [str(m.get("id")) for m in entries if m.get("loaded")]
            if loaded:
                return round(time.time() - t0, 1), ("engine holds %s resident - reported, not waited off: a "
                                                    "resident model is the row that costs no load"
                                                    % ", ".join(loaded[:3]))
            if not any("loaded" in m for m in entries):
                return round(time.time() - t0, 1), ("this engine's /v1/models carries no loaded flag; readiness "
                                                    "rested on the plugin's lane state")
            return round(time.time() - t0, 1), "engine holds nothing resident"
        except Exception as ex:
            return round(time.time() - t0, 1), "engine model list unreadable (%s); readiness rested on the lane state" % ex
    return round(time.time() - t0, 1), "wait cap %ds reached: %s" % (int(cap), last or "no reason given")


def engine_build(url):
    """What the engine says it is, read from its own /health. The plugin's registry carries a build string per slot
    and never reads one from an engine (TODOS.md WM-35 item 4), so a measurement record that quotes the registry
    quotes a hand-written value - and it was wrong on 2026-11-08, naming a build neither node was running. This is
    the engine's own answer, kept BESIDE the recorded one rather than in place of it. It is a GET on /health, the
    liveness route, never /status."""
    if not url:
        return ""
    try:
        with urllib.request.urlopen(url + "/health", timeout=15) as r:
            h = json.loads(r.read().decode("utf-8") or "{}")
    except Exception as ex:
        return "engine /health unreadable (%s)" % ex
    got = " ".join(str(h.get(k) or "") for k in ("version", "git", "git_date")).strip()
    return got or "engine /health answered without a version or git field"


def read_job_once(api, job_id):
    """One read of a finished row. Used a second time after a row reaches a terminal status, because the
    plugin publishes status 'ok' before its own duration and generation measurements land
    (lib/index.js: finishOk sets the status, finishJob computes elapsed_gen). The first read of the loop is
    the one that saw the terminal status; without a second read the record carries zeros for a row that has
    real numbers. Measured 2026-11-08 on four rows of the 2026-11-07 run."""
    try:
        return api.get("/job_status?job_id=" + urllib.parse.quote(job_id), timeout=30) or {}
    except Exception:
        return {}


# The one error the plugin is known to recover from inside the same row. It is named by the engine's own
# sentence, and lib/index.js treats it as such: the staged map for that endpoint is dropped and the SAME row
# is retried once, gated by job.stage_restaged, no new row and no loop. Measured live 2026-11-08 on ap-1065:
# a read showed status "error" with 'could not open WAV input: /tmp/audiocpp-ui-.../1-kael.wav', and the same
# row finished "ok" carrying elapsed_load 30 497 ms, elapsed_gen 98 623 ms, stage_restaged true and the engine's
# first sentence kept as stage_restage_error. A matrix that records the first read as the verdict records a
# failure that never happened.
RESTAGE_ERROR_MARK = "could not open WAV input"

# The engine's own busy sentence, word for word from the four 503s of the 2026-11-07 run: "cannot load model
# 'x': max_loaded_models=1 and every loaded model is busy; retry later". It names a moment and not a model, and
# the engine itself says "retry later", so the runner waits and asks once more instead of writing it as a verdict
# on the model. The earlier attempt is kept on the retried row as busy_retry_of, so the record shows both.
BUSY_MARK = "every loaded model is busy"


def settle_row(api, job_id, js, until):
    """Wait out a recovery the plugin is running on this row, bounded by `until`. Returns (js, note).
    The bound is a real parameter and not a constant, because the first bound this function had was wrong: a
    fixed 90 s missed `ap-1100` (breeze_tts on e-11, 2026-11-08). The plugin re-staged the sample, the row
    carried stage_restaged, and the take then rendered for 102.9 s and finished `ok`. A bound shorter than the
    row's own window writes a recovery as a failure, which is the exact thing this function exists to avoid."""
    first = js.get("status") or ""
    err = str(js.get("error") or "")
    # Two things are "not finished yet" from a reader's point of view: a row the plugin is recovering, and a row
    # that has published its status but not its own measurements. The second is not hypothetical - four ok rows of
    # the 2026-11-08 run (kitten_tts2, pocket_tts_en_bf16, omnivoice_f16, moss_ttsd_q4_k) carried no generation
    # time and two of them no duration at the moment the run recorded them, and all four carry them now.
    unsettled = (first == "error" and (RESTAGE_ERROR_MARK in err or js.get("stage_restaged") is True)) \
                or (first == "ok" and not (js.get("elapsed_gen") or js.get("duration")))
    if not unsettled:
        return js, ""
    started = time.time()
    while time.time() < until:
        time.sleep(5)
        again = read_job_once(api, job_id)
        status = again.get("status") or ""
        still_measuring = status == "ok" and not (again.get("elapsed_gen") or again.get("duration"))
        if status and (status != first or (status == "ok" and not still_measuring)):
            if first == "error":
                return again, "the plugin re-staged the sample and retried this row: it read 'error' and ended '%s'" % status
            return again, "the row published its status before its own measurements; this read waited them out"
        if again:
            js = again
    return js, "still reading '%s' after %ds of waiting; the row's own numbers or recovery did not land in time" \
             % (first, int(time.time() - started))


def human(ms):
    return "-" if not ms else ("%.2fs" % (ms / 1000.0))


def read_text_file(p):
    if not os.path.isfile(p):
        die("--text-file not found: " + p)
    txt = open(p, "r", encoding="utf-8").read().strip()
    if len(txt) < 20:
        die("--text-file looks empty/too short (%d chars) - use a real story line" % len(txt))
    return txt


def slot_label(slot):
    return "%s@%s" % (slot.get("id", "?"), slot.get("host", "?"))


def main():
    ap = argparse.ArgumentParser(description="serialized audio.cpp model matrix via the DEEPAMP plugin")
    ap.add_argument("--origin", default="", help="harness origin (default: $DSH_WEB_URL)")
    ap.add_argument("--fn", default="tts", choices=["tts", "stt"])
    ap.add_argument("--slots", default="",
                    help="slot ids to matrix (default: every slot the registry reports as enabled and unheld)")
    ap.add_argument("--text", default="", help="inline text (prefer --text-file)")
    ap.add_argument("--text-file", default="", help="file with real story dialogue")
    ap.add_argument("--max-chars", type=int, default=600, help="trim the text to this many characters")
    ap.add_argument("--voice", action="append", default=[], metavar="MODEL=VOICE")
    ap.add_argument("--default-voice", default="", help="voice for models that need one and have no --voice entry")
    ap.add_argument("--limit", type=int, default=0, help="cap models per slot (0 = every model the slot lists)")
    ap.add_argument("--skip-models", default="", help="comma-separated model ids to leave out")
    ap.add_argument("--format", default="wav", choices=["wav", "mp3", "ogg"])
    ap.add_argument("--job-timeout", type=int, default=0,
                    help="seconds to wait for one job. 0 (the default) reads the plugin's own window through "
                         "GET job_timeout. Operator item 12 of 2026-11-08: 'the default timeout in the plugin "
                         "setting should already be longer - maybe let the plugin use its setting, instead of "
                         "the option --job-timeout'. Measured reason: every timeout of the 2026-11-07 run was "
                         "this flag's 600 s, not the plugin's 3600 s. Give the flag only to override.")
    ap.add_argument("--settle", type=float, default=0.5,
                    help="minimum pause before the readiness wait of each row (seconds)")
    ap.add_argument("--max-wait-free", type=float, default=180.0,
                    help="seconds to wait for the target engine and lane to be free before dispatching the next "
                         "row (0 dispatches immediately). Replaces the fixed 2 s sleep of the first version.")
    ap.add_argument("--busy-retry", type=int, default=1,
                    help="re-dispatches allowed for a row the engine refused because its one model slot was busy "
                         "(0 turns the retry off). The engine's own sentence ends 'retry later'.")
    ap.add_argument("--busy-wait", type=float, default=45.0,
                    help="seconds to wait before such a re-dispatch")
    ap.add_argument("--ignore-busy", action="store_true", help="do not refuse a busy or paused lane")
    ap.add_argument("--out", default=DEFAULT_OUT, help="run root (default: this package's artifacts/model_matrix)")
    ap.add_argument("--go", action="store_true", help="actually dispatch (default is dry-run)")
    a = ap.parse_args()

    api = Api(origin_of(a))
    # The window a job is given is the plugin's, read from the plugin: GET job_timeout answers
    # {ok:true,seconds:...} (measured 2026-11-08: 3600). --job-timeout is an override and nothing else.
    ceiling = int(a.job_timeout or 0)
    ceiling_source = "--job-timeout override"
    if not ceiling:
        jt = api.get("/job_timeout", timeout=30)
        if jt.get("ok"):
            ceiling = int(jt.get("seconds") or 0)
            ceiling_source = "the plugin's own job_timeout, read through GET job_timeout"
    if not ceiling:
        die("no job window: the plugin did not answer job_timeout and --job-timeout was not given")
    text = read_text_file(a.text_file) if a.text_file else (a.text or "")
    if text and a.max_chars:
        text = text[:a.max_chars]

    # ---- slots: read them, do not name them ----------------------------------
    reg = api.get("/endpoint_registry?fn=" + a.fn)
    known = {}
    prim = reg.get("primary") or {}
    if prim.get("id"):
        known[prim["id"]] = prim
    for e in reg.get("endpoints") or []:
        if e.get("id"):
            known[e["id"]] = e
    if not known:
        die("the registry answered no slots - is the plugin loaded?")

    if a.slots:
        want_ids = [s.strip() for s in a.slots.split(",") if s.strip()]
        missing = [s for s in want_ids if s not in known]
        if missing:
            die("slots the registry does not name: " + ", ".join(missing) + " (ask endpoint_registry?fn=" + a.fn + ")")
    else:
        want_ids = [i for i, e in known.items() if e.get("enabled") and not e.get("held_by")]
    if not want_ids:
        die("no slot to matrix, and none was named with --slots")

    # ---- lane discipline ------------------------------------------------------
    qs = api.get("/queue_status").get("queues", {}).get(a.fn, {})
    paused = bool(qs.get("paused")) or bool(qs.get("lane_paused"))
    busy = bool(qs.get("running")) or int(qs.get("queued") or 0) > 0
    if (paused or busy) and not a.ignore_busy:
        die("the %s lane is %s (running=%s queued=%s) - this run is serialized, wait or pass --ignore-busy"
            % (a.fn, "paused" if paused else "busy", qs.get("running"), qs.get("queued")))

    # ---- catalogs: one press per slot, that engine's own list -----------------
    # The endpoint record carries the model NAMES its last catalog press returned. The per-model fields
    # (task, family, path, loaded) come from that engine's own `/v1/models`, read from the url the record
    # names - so a row is planned against what THIS engine lists, and the dispatch names a model the plugin
    # will accept. `get_models?fn=` is read once for the plugin's own capability fields (clone_required,
    # ref_text_required, quant); a model the plugin has no row for simply carries no guard prediction.
    cap = {}
    for m in api.get("/get_models?fn=" + a.fn, timeout=120).get("models") or []:
        if isinstance(m, dict) and m.get("id"):
            cap[m["id"]] = m

    voices = {}
    for kv in a.voice:
        if "=" not in kv:
            die("--voice wants MODEL=VOICE, got: " + kv)
        k, v = kv.split("=", 1)
        voices[k] = v
    skip = {m.strip() for m in a.skip_models.split(",") if m.strip()}

    # A voice the plugin's own registry holds carries its ref_wav and its ref_text, so a model that wants a
    # reference is satisfiable by a registered name. A name the registry does not hold is refused before a job
    # is spent on it.
    registered = set((api.get("/voice_registry").get("voices") or {}).keys())

    # The route a model can actually take is READ, not guessed (operator item 10 of 2026-11-08, and the eight
    # refusals of the 2026-11-07 run that read "unknown <Family> request option: reference_text"). Two answers
    # are asked, each for its own half:
    #   GET voice_modes?fn=&model=&endpoint_id=  -> the modes this model serves on this slot, in the plugin's
    #     one vocabulary (no_voice | preset_speaker | clone_sample | voice_design | dialogue_positional).
    #     Measured on the live plugin the same morning: a family whose only mode is preset_speaker answers with
    #     "the engine lists 54 built_in_voices ... default ..." and names no clone_sample - a plugin voice
    #     cannot be used for it at all, and naming one is what made that row fail.
    #   <engine>/v1/models?include_params=true   -> the request options that model's own spec declares.
    # A model that clones a sample but does not declare reference_text is recorded as what it is: the plugin
    # carries reference_text with every registered voice (lib/index.js applyStagedPayload), so a refusal naming
    # that option is about the plugin's payload, not a verdict on the model.
    vm_cache = {}

    def voice_modes_for(mid, sid):
        key = (mid, sid)
        if key not in vm_cache:
            modes, note = [], ""
            try:
                q = urllib.parse.urlencode({"fn": a.fn, "model": mid, "endpoint_id": sid})
                vm = api.get("/voice_modes?" + q, timeout=60)
                modes = [str(m.get("mode")) for m in (vm.get("voice_modes") or []) if isinstance(m, dict)]
                if not vm.get("ok"):
                    note = "voice_modes refused: %s" % vm.get("error", "")
            except Exception as ex:
                note = "voice_modes unreadable: %s" % ex
            vm_cache[key] = (modes, note)
        return vm_cache[key]

    plan = []
    slot_info = {}
    for sid in want_ids:
        e = known[sid]
        pressed = api.post("/endpoint_models", {"fn": a.fn, "id": sid}, timeout=120)
        ep = pressed.get("endpoint") or pressed
        names = [n for n in (ep.get("models") or []) if isinstance(n, str)]
        url = (ep.get("url") or e.get("url") or "").rstrip("/")
        eng = {}
        eng_note = ""
        if url:
            try:
                # include_params=true is the engine's own answer to "which request options does THIS model
                # accept" (app/server/api.md: it adds `params`, the options the model's spec declares). Read
                # here because the matrix must not send an option a model does not declare: eight rows of the
                # 2026-11-07 run were refused by the engine for exactly that ("unknown <Family> request
                # option: reference_text"). An engine that does not honour the parameter answers with no
                # params, and _options stays empty and says so.
                with urllib.request.urlopen(url + "/v1/models?include_params=true", timeout=30) as r:
                    body = json.loads(r.read().decode("utf-8") or "{}")
                for m in body.get("data") or body.get("models") or []:
                    if isinstance(m, dict) and m.get("id"):
                        ps = m.get("params") or []
                        m["_options"] = [p.get("name") or p.get("key") or "?" for p in ps if isinstance(p, dict)]
                        m["_options_declared"] = bool(ps)
                        eng[m["id"]] = m
            except Exception as ex:
                eng_note = "engine /v1/models unreadable (%s); planned from the plugin's catalog names alone" % ex
        slot_info[sid] = {
            "id": sid, "host": e.get("host", ""), "url": url,
            "build_recorded": ep.get("build", ""), "build_at": ep.get("build_at", 0),
            "build_measured": engine_build(url),
            "catalog_at": ep.get("models_at", 0), "catalog_count": len(names),
            "engine_catalog_count": len(eng), "engine_read_note": eng_note,
            "backend": ep.get("backend", ""),
        }
        ids = [n for n in (names if not eng else [n for n in names if n in eng]) if n not in skip]
        kept = []
        for mid in ids:
            obj = dict(eng.get(mid) or {})
            obj.update({k: v for k, v in (cap.get(mid) or {}).items() if v not in (None, "")})
            if a.fn == "tts" and obj.get("task") not in TTS_TASKS:
                continue
            kept.append((mid, obj))
        if a.limit:
            kept = kept[:a.limit]
        for mid, m in kept:
            explicit = mid in voices
            voice = voices.get(mid) or a.default_voice or ""
            needs_voice = bool(m.get("clone_required"))
            needs_ref = bool(m.get("ref_text_required"))
            declared = [str(o) for o in (m.get("_options") or [])]
            samples_only = bool(m.get("samples_only"))
            modes, vm_note = voice_modes_for(mid, sid)
            route, route_note = "", ""
            if a.fn == "tts":
                if samples_only:
                    # Read from the plugin's own capability field (get_models carries samples_only), not guessed.
                    # This is the exact reason the six refusals of the 2026-11-07 run gave: "clones through
                    # voice_samples (positional WAV paths staged on the endpoint that renders the take), not
                    # through the plugin voice_ref" - lib/index.js refuses a single voice on such a family
                    # before a model load and before a row. A single-voice matrix therefore runs it with no
                    # voice, on its own voice, and says so; a cloned render of this family is a scene with
                    # ordered speakers, which is dispatch_batch and not this runner.
                    route, voice = "samples_only_family", ""
                    route_note = ("clones only through positional voice_samples (a scene with ordered speakers); "
                                  "a single-voice take runs it with no voice. A voice named for it would be "
                                  "refused by the plugin's capability bar, so it is dropped here")
                elif "clone_sample" in modes:
                    route = "clone_sample"
                    if declared and "reference_text" not in declared:
                        route_note = ("its declared options do not include reference_text, and the plugin carries "
                                      "it with every registered voice. Some families reject an option they do not "
                                      "declare - the eight refusals of the 2026-11-07 run - and some take it "
                                      "anyway (the pocket_tts rows rendered with it), so this names the cause if "
                                      "a refusal comes, it does not predict one: the cause would be the plugin's "
                                      "payload, not this model")
                elif "voice_design" in modes:
                    route, voice = "voice_design", ""
                    route_note = "design lane: the voice is shaped by instructions, a registry voice is not sent"
                elif "preset_speaker" in modes:
                    route = "preset_speaker"
                    if voice and not explicit:
                        voice = ""
                        route_note = ("this model's only mode is preset_speaker: it renders on the engine's own "
                                      "built-in voice names, so the registry voice was dropped rather than sent")
                    elif voice and explicit:
                        route_note = "voice named through --voice is sent as the engine's own built-in name"
                elif "no_voice" in modes:
                    route, voice = "no_voice", ""
                    route_note = "the model renders on its own voice; no voice is sent"
                else:
                    route = "unknown"
                    route_note = vm_note or "voice_modes named no mode for this model"
            row = {
                "slot": sid, "host": slot_info[sid]["host"], "model": mid,
                "family": m.get("family", ""), "task": m.get("task", ""), "quant": m.get("quant", ""),
                "model_path": m.get("path", ""), "voice": voice,
                "clone_required": needs_voice, "ref_text_required": needs_ref,
                "loaded_on_engine": bool(m.get("loaded")),
                "voice_route": route, "voice_modes": modes, "samples_only": samples_only,
                "declared_options": declared, "options_declared": bool(m.get("_options_declared")),
                "route_note": route_note, "note": "",
            }
            if voice and voice not in registered and route != "preset_speaker":
                # A name this plugin's registry does not hold is only a problem on the routes that send a stored
                # sample. On a preset_speaker route the name IS the engine's own built-in speaker, and that is the
                # only way to drive such a family at all (TODOS item 84, four small families measured outside this
                # runner for exactly this reason). An unknown route keeps the old guard: no claim, no dispatch.
                row["blocked"] = "voice '%s' is not in the plugin voice registry" % voice
            elif needs_voice and not voice and route == "clone_sample":
                row["blocked"] = "clone_required and no voice given"
            else:
                row["blocked"] = ""
                if needs_ref and voice:
                    row["note"] = "ref_text from the registry entry for '%s'" % voice
            plan.append(row)

    ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d_%H%M%S")
    out_dir = os.path.abspath(os.path.join(a.out, ts))
    os.makedirs(out_dir, exist_ok=True)
    meta = {
        "created_utc": ts, "api": api.base, "fn": a.fn,
        "slots": [slot_info[s] for s in want_ids],
        "text_chars": len(text),
        "text_source": os.path.abspath(a.text_file) if a.text_file else ("inline" if text else ""),
        "format": a.format, "lane_at_plan": qs, "go": bool(a.go),
        "job_ceiling_s": ceiling, "job_ceiling_source": ceiling_source,
        "max_wait_free_s": a.max_wait_free, "min_settle_s": a.settle,
        "busy_retry_allowed": a.busy_retry, "busy_wait_s": a.busy_wait,
        "note": ("build_recorded is what the plugin's registry carries for that slot; the plugin records a build "
                 "string, it does not read one from an engine. build_measured is the engine's own /health answer, "
                 "read by this run. The catalog is the engine's own answer too."),
    }
    with open(os.path.join(out_dir, "plan.json"), "w") as f:
        json.dump({"meta": meta, "plan": plan}, f, indent=2)

    print("matrix plan -> %s" % os.path.join(out_dir, "plan.json"))
    for s in meta["slots"]:
        print("slot %s@%s catalog=%d build_recorded=%s build_measured=%s"
              % (s["id"], s["host"], s["catalog_count"], s["build_recorded"] or "-", s["build_measured"] or "-"))
    print("job window: %d s, taken from %s" % (ceiling, ceiling_source))
    print("%-8s %-18s %-16s %-6s %-14s %-16s %s"
          % ("SLOT", "MODEL", "FAMILY", "QUANT", "VOICE", "VOICE ROUTE", "NOTE"))
    for r in plan:
        note = r["blocked"] or r["route_note"] or (
            "model already loaded on that engine" if r["loaded_on_engine"] else "")
        print("%-8s %-18s %-16s %-6s %-14s %-16s %s" % (
            r["slot"], r["model"], r["family"], r["quant"] or "?", r["voice"] or "-",
            r.get("voice_route") or "-", note))
    blocked = [r["model"] for r in plan if r["blocked"]]
    if blocked:
        print("\nblocked (capability guard, no voice given): " + ", ".join(blocked))

    if not a.go:
        print("\nDRY RUN - nothing dispatched (%d rows planned). Re-run with --go" % len(plan))
        return 0
    if not text:
        die("--go needs --text-file (or --text) with real story dialogue")

    results = []

    def run_row(r, waited, ready_note):
        """Dispatch one planned row, poll it to a terminal state, wait out a recovery the plugin is running on
        it, and build the record. One function so the busy-slot retry below can run the same row again without
        a second copy of this code."""
        t0 = time.time()
        d = api.post("/dispatch_tts", {
            "fn": a.fn, "model": r["model"], "text": text, "voice": r["voice"],
            "format": a.format, "endpoint_id": r["slot"],
        }, timeout=120)
        if not d.get("ok"):
            row = dict(r, status="rejected", error=d.get("error", ""),
                       ready_wait_s=waited, ready_note=ready_note)
            print("   rejected: %s" % d.get("error"))
            return row
        job_id = d.get("job_id") or str(d.get("route_url", "")).split("/")[-1]
        deadline = time.time() + ceiling
        js = {}
        while time.time() < deadline:
            js = api.get("/job_status?job_id=" + urllib.parse.quote(job_id))
            if js.get("status") in TERMINAL:
                break
            time.sleep(3)
        else:
            # The row is still running. Cancelling it is what keeps a serialized run honest: without this the
            # next dispatch queues behind a job this run has already stopped measuring, and every later number
            # in the matrix is polluted by the one that hung.
            cancelled = api.post("/cancel_job", {"job_id": job_id})
            row = dict(r, status="timeout", job_id=job_id, ceiling_s=ceiling,
                       ceiling_source=ceiling_source, ready_wait_s=waited, ready_note=ready_note,
                       cancel_answer=cancelled.get("ok"),
                       cancel_error=cancelled.get("error", ""))
            print("   timeout after %ds (%s) -> cancel_job ok=%s" % (ceiling, ceiling_source, cancelled.get("ok")))
            return row
        # A row that has just reached a terminal status is read once more before its numbers are recorded;
        # see read_job_once. The zeros that fixes are the runner's record, not the plugin's row.
        again = read_job_once(api, job_id)
        re_read = again.get("status") in TERMINAL
        if re_read:
            js = again
        js, settled_note = settle_row(api, job_id, js, t0 + ceiling + 300)
        if settled_note:
            print("   %s" % settled_note)
        row = dict(r, status=js.get("status"), job_id=job_id,
                   elapsed_load_ms=js.get("elapsed_load", 0), elapsed_gen_ms=js.get("elapsed_gen", 0),
                   duration_s=js.get("duration", 0),
                   quant=js.get("quant") or r["quant"], family=js.get("family") or r["family"],
                   model_path=js.get("model_path") or r["model_path"],
                   output_path=js.get("route_url", ""), file_name=js.get("filename", ""),
                   error=js.get("error", ""), wall_s=round(time.time() - t0, 2),
                   ready_wait_s=waited, ready_note=ready_note, row_re_read=bool(re_read),
                   settled_note=settled_note, stage_restaged=bool(js.get("stage_restaged")),
                   stage_restage_error=str(js.get("stage_restage_error") or ""))
        print("   %s  load=%s gen=%s audio=%s -> %s" % (
            row["status"], human(row["elapsed_load_ms"]), human(row["elapsed_gen_ms"]),
            ("%.2fs" % row["duration_s"]) if row["duration_s"] else "-",
            row["file_name"] or row["output_path"]))
        if row["error"]:
            print("   error: %s" % row["error"])
        return row

    for r in plan:
        if r["blocked"]:
            results.append(dict(r, status="skipped"))
            continue
        print("\n>> %s on %s (voice=%s, route=%s)" % (
            r["model"], r["slot"], r["voice"] or "-", r.get("voice_route") or "-"))
        attempt = 0
        prior = None
        while True:
            waited, ready_note = wait_lane_free(api, a.fn, slot_info[r["slot"]]["url"], r["slot"],
                                                a.max_wait_free, a.settle)
            print("   lane ready after %ss: %s" % (waited, ready_note))
            row = run_row(r, waited, ready_note)
            if prior:
                row["busy_retry_of"] = prior
            if BUSY_MARK in str(row.get("error") or "") and attempt < a.busy_retry:
                attempt += 1
                print("   the engine said its one model slot is full; %d s, then this row is dispatched again "
                      "(attempt %d of %d)" % (int(a.busy_wait), attempt + 1, a.busy_retry + 1))
                prior = {"job_id": row.get("job_id"), "status": row.get("status"),
                         "error": str(row.get("error") or "")[:240], "wall_s": row.get("wall_s")}
                time.sleep(a.busy_wait)
                continue
            results.append(row)
            break
        # No fixed sleep here any more: the next row waits for the lane to be free (wait_lane_free), with
        # --settle kept as that wait's minimum pause.

    with open(os.path.join(out_dir, "matrix.json"), "w") as f:
        json.dump({"meta": meta, "results": results}, f, indent=2)

    lines = ["# model matrix %s" % ts, "",
             "text: %s (%d chars) | format: %s | serialized: yes | every dispatch pinned to the slot it is planned on" % (
                 meta["text_source"] or "inline", meta["text_chars"], a.format),
             "job window: %d s, taken from %s | readiness: each row waits up to %s s for the lane and the engine "
             "to report nothing loaded before it is dispatched" % (ceiling, ceiling_source, a.max_wait_free), "",
             "| slot | model | family | quant | voice | route | status | load | gen | audio | note |",
             "|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in results:
        note = r.get("error") or r.get("settled_note") or r.get("blocked") or r.get("route_note") or ""
        if r.get("busy_retry_of"):
            note = ((note + " | ") if note else "") + "re-dispatched after the engine's busy 503 (earlier job %s)" \
                     % r["busy_retry_of"].get("job_id")
        lines.append("| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |" % (
            r["slot"], r["model"], r["family"], r.get("quant") or "?", r["voice"] or "-",
            r.get("voice_route") or "-",
            r.get("status"), human(r.get("elapsed_load_ms", 0)), human(r.get("elapsed_gen_ms", 0)),
            ("%.2fs" % r["duration_s"]) if r.get("duration_s") else "-",
            note[:80]))
    with open(os.path.join(out_dir, "SUMMARY.md"), "w") as f:
        f.write("\n".join(lines) + "\n")

    ok = sum(1 for r in results if r.get("status") == "ok")
    print("\ndone: %d/%d ok - %s" % (ok, len(results), out_dir))
    print("REMINDER: exit 0 does not prove a take rendered correctly - listen before trusting it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
