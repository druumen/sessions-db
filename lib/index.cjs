var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// lib/index.mjs
var index_exports = {};
__export(index_exports, {
  MAX_ASCEND_DEPTH: () => MAX_ASCEND_DEPTH,
  MAX_EVENT_BYTES: () => MAX_EVENT_BYTES,
  MAX_PARENT_CANDIDATES: () => MAX_PARENT_CANDIDATES,
  PATHS: () => PATHS,
  STORAGE_FILENAMES: () => STORAGE_FILENAMES,
  STRONG_CORROBORATORS: () => STRONG_CORROBORATORS,
  WEAK_CORROBORATORS: () => WEAK_CORROBORATORS,
  appendEvent: () => appendEvent,
  applyEvent: () => applyEvent,
  capParentCandidates: () => capParentCandidates,
  classifyCorroborators: () => classifyCorroborators,
  closeSession: () => closeSession,
  collectParentCandidates: () => collectParentCandidates,
  computeEffectiveLastProgress: () => computeEffectiveLastProgress,
  computeSweepTransitions: () => computeSweepTransitions,
  emptyProjection: () => emptyProjection,
  emptySession: () => emptySession,
  extractTimestamp: () => extractTimestamp,
  findByClaudeSessionId: () => findByClaudeSessionId,
  findByTranscriptLineage: () => findByTranscriptLineage,
  generateSessionId: () => generateSessionId,
  initProjection: () => initProjection,
  isSessionId: () => isSessionId,
  linkTask: () => linkTask,
  loadProjection: () => loadProjection,
  meetsThreshold: () => meetsThreshold,
  newEvent: () => newEvent,
  pathsFromRoot: () => pathsFromRoot,
  readAllEvents: () => readAllEvents,
  rebuildFromEvents: () => rebuildFromEvents,
  rebuildProjection: () => rebuildProjection,
  recordSessionSeen: () => recordSessionSeen,
  resolveIdentity: () => resolveIdentity,
  resolveStoragePaths: () => resolveStoragePaths,
  runSweep: () => runSweep,
  sanitizeFirstPrompt: () => sanitizeFirstPrompt,
  saveProjection: () => saveProjection,
  scanFingerprintCandidates: () => scanFingerprintCandidates,
  setAlias: () => setAlias,
  setParent: () => setParent,
  stripIdeWrappers: () => stripIdeWrappers,
  stripSystemReminders: () => stripSystemReminders,
  tryUpdateProjection: () => tryUpdateProjection,
  unlinkTask: () => unlinkTask,
  watchProjection: () => watchProjection
});
module.exports = __toCommonJS(index_exports);

// lib/storage.mjs
var import_node_fs3 = require("node:fs");
var import_node_path2 = require("node:path");

// lib/lock.mjs
var import_node_fs = require("node:fs");
var import_promises = require("node:timers/promises");
var DEFAULT_TIMEOUT_MS = 5e3;
var DEFAULT_RETRY_MS = 50;
async function acquireLock(lockPath, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    let fd;
    try {
      fd = (0, import_node_fs.openSync)(lockPath, "wx");
    } catch (err) {
      if (err && err.code === "EEXIST") {
        if (Date.now() >= deadline) {
          throw new Error(
            `acquireLock: timeout after ${timeoutMs}ms (path=${lockPath})`
          );
        }
        await (0, import_promises.setTimeout)(retryMs);
        continue;
      }
      throw err;
    }
    try {
      const stamp = `${process.pid}	${(/* @__PURE__ */ new Date()).toISOString()}
`;
      (0, import_node_fs.writeSync)(fd, stamp);
    } catch {
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      try {
        (0, import_node_fs.closeSync)(fd);
      } catch {
      }
      try {
        (0, import_node_fs.unlinkSync)(lockPath);
      } catch {
      }
    };
    return { release };
  }
}

// lib/identity.mjs
var DEFAULT_TIME_WINDOW_HOURS = 72;
var DEFAULT_MIN_CORROBORATORS = 2;
var MAX_PARENT_CANDIDATES = 10;
var STRONG_CORROBORATORS = Object.freeze([
  "same_cwd",
  "same_worktree_realpath"
]);
var WEAK_CORROBORATORS = Object.freeze([
  "same_branch_at_start",
  "within_time_window"
]);
function classifyCorroborators(hits) {
  let strong = 0;
  let weak = 0;
  for (const k of STRONG_CORROBORATORS) if (hits && hits[k] === true) strong += 1;
  for (const k of WEAK_CORROBORATORS) if (hits && hits[k] === true) weak += 1;
  return { strong, weak, total: strong + weak };
}
function meetsThreshold(counts, opts = {}) {
  if (!counts || typeof counts !== "object") return false;
  const min = typeof opts.minCorroborators === "number" ? opts.minCorroborators : DEFAULT_MIN_CORROBORATORS;
  return counts.strong >= 1 && counts.total >= min;
}
function resolveIdentity(input) {
  if (!input || typeof input !== "object") {
    throw new TypeError("resolveIdentity: input required");
  }
  const {
    projection,
    claudeSessionId,
    transcriptMeta = null,
    gitContext = null,
    cwd = null,
    fingerprints = null,
    now = Date.now(),
    timeWindowHours = DEFAULT_TIME_WINDOW_HOURS,
    minCorroborators = DEFAULT_MIN_CORROBORATORS,
    mintStableId
  } = input;
  if (typeof mintStableId !== "function") {
    throw new TypeError("resolveIdentity: mintStableId callback required");
  }
  if (typeof claudeSessionId !== "string" || claudeSessionId.length === 0) {
    throw new TypeError("resolveIdentity: claudeSessionId required");
  }
  const p1 = findByClaudeSessionId(projection, claudeSessionId);
  if (p1 !== null) {
    return {
      stableId: p1,
      source: "claude_session_id_index",
      confidence: "exact",
      matched: { claude_session_id: claudeSessionId },
      // P1 hit — do NOT compute parentCandidates. The session is identified;
      // hub-spoke parent surfacing is only meaningful when we cannot resolve
      // the exact identity from a stable cross-session signal.
      parentCandidates: [],
      parentCandidatesOmittedCount: 0
    };
  }
  const p2 = findByTranscriptLineage(projection, transcriptMeta);
  if (p2 !== null) {
    return {
      stableId: p2.stableId,
      source: "transcript_lineage",
      confidence: "high",
      matched: {
        first_parent_uuid: transcriptMeta?.firstParentUuid ?? null,
        matched_transcript_path: p2.matchedPath,
        matched_last_uuid: p2.matchedLastUuid
      },
      parentCandidates: [],
      parentCandidatesOmittedCount: 0
    };
  }
  const corrCtx = {
    cwd: typeof cwd === "string" && cwd.length > 0 ? cwd : null,
    worktreeRealpath: gitContext && typeof gitContext.worktreeRealpath === "string" && gitContext.worktreeRealpath.length > 0 ? gitContext.worktreeRealpath : null,
    branch: gitContext && typeof gitContext.branch === "string" && gitContext.branch.length > 0 ? gitContext.branch : null,
    now,
    timeWindowHours
  };
  const fpScan = scanFingerprintCandidates(projection, fingerprints, corrCtx);
  const above = [];
  const below = [];
  for (const c of fpScan) {
    if (meetsThreshold(c.strengthCounts, { minCorroborators })) above.push(c);
    else below.push(c);
  }
  if (above.length === 1) {
    const accepted = above[0];
    const { list: list2, omitted: omitted2 } = capParentCandidates(
      // Other above-threshold (none in this branch) + all below-threshold.
      below.filter((c) => c.stableId !== accepted.stableId)
    );
    return {
      stableId: accepted.stableId,
      source: "fingerprint_corroborator",
      confidence: "low",
      matched: {
        fingerprints_matched: accepted.fingerprintsMatched,
        corroborators: accepted.corroborators,
        corroborator_count: accepted.corroboratorCount,
        strong_corroborator_count: accepted.strengthCounts.strong
      },
      parentCandidates: list2,
      parentCandidatesOmittedCount: omitted2
    };
  }
  const minted = mintStableId();
  const matched = above.length >= 2 ? { ambiguous: true, ambiguous_count: above.length } : {};
  const { list, omitted } = capParentCandidates([...above, ...below]);
  return {
    stableId: minted,
    source: "minted",
    confidence: "minted",
    matched,
    parentCandidates: list,
    parentCandidatesOmittedCount: omitted
  };
}
function findByClaudeSessionId(projection, csid) {
  if (!projection || !projection.sessions || typeof projection.sessions !== "object") {
    return null;
  }
  if (typeof csid !== "string" || csid.length === 0) return null;
  for (const [stableId, session] of Object.entries(projection.sessions)) {
    if (!session || !Array.isArray(session.claude_session_ids)) continue;
    if (session.claude_session_ids.length === 0) continue;
    if (session.claude_session_ids.includes(csid)) return stableId;
  }
  return null;
}
function findByTranscriptLineage(projection, transcriptMeta) {
  if (!transcriptMeta || typeof transcriptMeta !== "object") return null;
  const parent = typeof transcriptMeta.firstParentUuid === "string" ? transcriptMeta.firstParentUuid : null;
  if (!parent || parent.length === 0) return null;
  if (!projection || !projection.sessions || typeof projection.sessions !== "object") {
    return null;
  }
  for (const [stableId, session] of Object.entries(projection.sessions)) {
    if (!session || !Array.isArray(session.transcript_files)) continue;
    for (const tf of session.transcript_files) {
      if (!tf || typeof tf !== "object") continue;
      const lastUuid = typeof tf.last_uuid === "string" && tf.last_uuid.length > 0 ? tf.last_uuid : typeof tf.lastUuid === "string" && tf.lastUuid.length > 0 ? tf.lastUuid : null;
      if (lastUuid && lastUuid === parent) {
        return {
          stableId,
          matchedPath: typeof tf.path === "string" ? tf.path : null,
          matchedLastUuid: lastUuid
        };
      }
    }
  }
  return null;
}
function scanFingerprintCandidates(projection, fingerprints, corrCtx) {
  const out = [];
  if (!projection || !projection.sessions || typeof projection.sessions !== "object") {
    return out;
  }
  if (!fingerprints || typeof fingerprints !== "object") return out;
  const fpHuman = typeof fingerprints.first_human_prompt_v1 === "string" && fingerprints.first_human_prompt_v1.length > 0 ? fingerprints.first_human_prompt_v1 : null;
  const fpLineage = typeof fingerprints.lineage_prefix_v1 === "string" && fingerprints.lineage_prefix_v1.length > 0 ? fingerprints.lineage_prefix_v1 : null;
  if (fpHuman === null && fpLineage === null) return out;
  const windowMs = (typeof corrCtx.timeWindowHours === "number" && corrCtx.timeWindowHours >= 0 ? corrCtx.timeWindowHours : DEFAULT_TIME_WINDOW_HOURS) * 3600 * 1e3;
  for (const [stableId, session] of Object.entries(projection.sessions)) {
    if (!session || !session.fingerprints || typeof session.fingerprints !== "object") continue;
    const matched = [];
    if (fpHuman !== null && typeof session.fingerprints.first_human_prompt_v1 === "string" && session.fingerprints.first_human_prompt_v1 === fpHuman) {
      matched.push("first_human_prompt_v1");
    }
    if (fpLineage !== null && typeof session.fingerprints.lineage_prefix_v1 === "string" && session.fingerprints.lineage_prefix_v1 === fpLineage) {
      matched.push("lineage_prefix_v1");
    }
    if (matched.length === 0) continue;
    const corroborators = {
      same_cwd: corrCtx.cwd !== null && typeof session.cwd === "string" && session.cwd.length > 0 && session.cwd === corrCtx.cwd,
      same_worktree_realpath: corrCtx.worktreeRealpath !== null && typeof session.worktree_realpath === "string" && session.worktree_realpath.length > 0 && session.worktree_realpath === corrCtx.worktreeRealpath,
      same_branch_at_start: corrCtx.branch !== null && typeof session.branch_at_start === "string" && session.branch_at_start.length > 0 && session.branch_at_start === corrCtx.branch,
      within_time_window: false
    };
    if (typeof session.last_progress_at === "string" && session.last_progress_at.length > 0) {
      const lastMs = Date.parse(session.last_progress_at);
      if (Number.isFinite(lastMs)) {
        const diffMs = corrCtx.now - lastMs;
        corroborators.within_time_window = diffMs >= 0 && diffMs <= windowMs;
      }
    }
    const corroboratorCount = Object.values(corroborators).filter(Boolean).length;
    const strengthCounts = classifyCorroborators(corroborators);
    out.push({
      stableId,
      fingerprintsMatched: matched,
      corroborators,
      corroboratorCount,
      strengthCounts,
      sessionLastProgressAt: typeof session.last_progress_at === "string" ? session.last_progress_at : null
    });
  }
  return out;
}
function collectParentCandidates(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const seen = /* @__PURE__ */ new Map();
  for (const r of rows) {
    if (!r || typeof r.stableId !== "string") continue;
    if (seen.has(r.stableId)) continue;
    const strength = r.strengthCounts ?? classifyCorroborators(r.corroborators);
    seen.set(r.stableId, {
      stable_id: r.stableId,
      source: "fingerprint",
      confidence: "low",
      reason: {
        fingerprints_matched: [...r.fingerprintsMatched],
        corroborator_count: r.corroboratorCount,
        strong_corroborator_count: strength.strong,
        weak_corroborator_count: strength.weak
      }
    });
  }
  return Array.from(seen.values());
}
function capParentCandidates(rows, opts = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { list: [], omitted: 0 };
  }
  const cap = typeof opts.cap === "number" && opts.cap > 0 ? opts.cap : MAX_PARENT_CANDIDATES;
  const dedup = /* @__PURE__ */ new Map();
  for (const r of rows) {
    if (!r || typeof r.stableId !== "string") continue;
    if (!dedup.has(r.stableId)) dedup.set(r.stableId, r);
  }
  const sorted = Array.from(dedup.values()).sort((a, b) => {
    const aStrong = (a.strengthCounts ?? classifyCorroborators(a.corroborators)).strong;
    const bStrong = (b.strengthCounts ?? classifyCorroborators(b.corroborators)).strong;
    if (bStrong !== aStrong) return bStrong - aStrong;
    const aTs = a.sessionLastProgressAt ?? "";
    const bTs = b.sessionLastProgressAt ?? "";
    if (aTs !== bTs) return bTs.localeCompare(aTs);
    return a.stableId.localeCompare(b.stableId);
  });
  const kept = sorted.slice(0, cap);
  const omitted = Math.max(0, sorted.length - kept.length);
  return { list: collectParentCandidates(kept), omitted };
}

// lib/paths.mjs
var import_node_fs2 = require("node:fs");
var import_node_path = require("node:path");
var MAX_ASCEND_DEPTH = 12;
var STORAGE_FILENAMES = Object.freeze({
  eventsJsonl: "sessions-db-events.jsonl",
  projectionJson: "sessions-db.json",
  lockFile: "sessions-db.json.lock"
});
function resolveStoragePaths(opts = {}) {
  if (typeof opts.rootPath === "string" && opts.rootPath.length > 0) {
    const root = (0, import_node_path.resolve)(opts.rootPath);
    return { root, ...buildFilePaths(root), source: "arg" };
  }
  const envRoot = process.env.DRUUMEN_SESSIONS_DB_ROOT;
  if (typeof envRoot === "string" && envRoot.length > 0) {
    const root = (0, import_node_path.resolve)(envRoot);
    return { root, ...buildFilePaths(root), source: "env" };
  }
  const startCwd = (0, import_node_path.resolve)(
    typeof opts.cwd === "string" && opts.cwd.length > 0 ? opts.cwd : process.cwd()
  );
  const found = ascendForExistingDb(startCwd);
  if (found) {
    return { root: found.root, ...buildFilePaths(found.root), source: found.source };
  }
  const defaultRoot = (0, import_node_path.join)(startCwd, ".dru-code");
  return { root: defaultRoot, ...buildFilePaths(defaultRoot), source: "default" };
}
function buildFilePaths(root) {
  return {
    eventsJsonl: (0, import_node_path.join)(root, STORAGE_FILENAMES.eventsJsonl),
    projectionJson: (0, import_node_path.join)(root, STORAGE_FILENAMES.projectionJson),
    lockFile: (0, import_node_path.join)(root, STORAGE_FILENAMES.lockFile)
  };
}
function ascendForExistingDb(startCwd) {
  let cwd = startCwd;
  for (let depth = 0; depth < MAX_ASCEND_DEPTH; depth++) {
    const ticketsLogsRoot = (0, import_node_path.join)(cwd, "tickets", "_logs");
    if ((0, import_node_fs2.existsSync)((0, import_node_path.join)(ticketsLogsRoot, STORAGE_FILENAMES.projectionJson))) {
      return { root: ticketsLogsRoot, source: "tickets-logs" };
    }
    const druCodeRoot = (0, import_node_path.join)(cwd, ".dru-code");
    if ((0, import_node_fs2.existsSync)((0, import_node_path.join)(druCodeRoot, STORAGE_FILENAMES.projectionJson))) {
      return { root: druCodeRoot, source: "dru-code" };
    }
    const parent = (0, import_node_path.dirname)(cwd);
    if (parent === cwd) break;
    cwd = parent;
  }
  return null;
}
function pathsFromRoot(root) {
  if (typeof root !== "string" || root.length === 0) {
    throw new TypeError("pathsFromRoot: root must be a non-empty string");
  }
  const abs = (0, import_node_path.isAbsolute)(root) ? root : (0, import_node_path.resolve)(root);
  return { root: abs, ...buildFilePaths(abs) };
}

// lib/projection.mjs
var SCHEMA_VERSION = 2;
var FINGERPRINT_VERSIONS = ["first_human_prompt_v1", "lineage_prefix_v1"];
function emptyProjection() {
  return {
    _meta: {
      schema_version: SCHEMA_VERSION,
      fingerprint_versions: [...FINGERPRINT_VERSIONS],
      updated: null,
      event_count: 0,
      last_event_id: null
    },
    sessions: {}
  };
}
function emptySession(stableId, ts) {
  return {
    stable_id: stableId,
    alias: null,
    claude_session_ids: [],
    transcript_files: [],
    fingerprints: {
      first_human_prompt_v1: null,
      lineage_prefix_v1: null
    },
    parent_session_id: null,
    parent_candidate_ids: [],
    // Count of parent candidates that resolveIdentity omitted from the most
    // recent session_seen due to the MAX_PARENT_CANDIDATES cap. 0 means the
    // surfaced parent_candidate_ids are complete; >0 means CLI / audit
    // should render "+ N more" or trigger a rebuild-from-events drill-down.
    // Last-write-wins (mirrors identity_resolution semantics).
    parent_candidates_omitted_count: 0,
    // Audit trail of how the most recent session_seen resolved this stable_id
    // — overwritten on every session_seen (always reflects the latest signal
    // set). Null on first creation; populated by reduceSessionSeen when the
    // event payload carries it. See identity.mjs / recordSessionSeen.
    identity_resolution: null,
    worktree_path_observed: null,
    worktree_realpath: null,
    worktree_registry_name: null,
    git_common_dir: null,
    branch_at_start: null,
    branch_current: null,
    head_at_start: null,
    head_last_seen: null,
    tasks: [],
    projects: [],
    activity_state: "active",
    outcome: "open",
    closed_at: null,
    closed_reason: null,
    created_at: ts,
    last_progress_at: ts,
    first_prompt_preview: null
  };
}
function applyEvent(projection, event) {
  if (!projection || typeof projection !== "object" || !projection.sessions) {
    throw new TypeError("applyEvent: projection missing or malformed");
  }
  if (!event || typeof event !== "object") {
    throw new TypeError("applyEvent: event missing");
  }
  const { op, stable_id: stableId, ts } = event;
  if (typeof stableId !== "string" || stableId.length === 0) {
    throw new TypeError("applyEvent: event.stable_id required");
  }
  let session = projection.sessions[stableId];
  if (!session) {
    session = emptySession(stableId, ts);
    projection.sessions[stableId] = session;
  }
  switch (op) {
    case "session_seen":
      reduceSessionSeen(session, event);
      break;
    case "session_link":
      reduceSessionLink(session, event);
      break;
    case "alias_set":
      reduceAliasSet(session, event);
      break;
    case "parent_set":
      reduceParentSet(session, event);
      break;
    case "close":
      reduceClose(session, event);
      break;
    case "sweep":
      reduceSweep(session, event);
      break;
    case "session_unlink":
      reduceSessionUnlink(session, event);
      break;
    case "manual_link":
      reduceManualLink(session, event);
      break;
    default:
      break;
  }
  if (op !== "sweep" && ts && (!session.last_progress_at || ts > session.last_progress_at)) {
    session.last_progress_at = ts;
  }
  projection._meta.event_count += 1;
  projection._meta.last_event_id = event.event_id ?? projection._meta.last_event_id;
  projection._meta.updated = ts ?? projection._meta.updated;
  return projection;
}
function rebuildFromEvents(events) {
  const projection = emptyProjection();
  if (!Array.isArray(events)) return projection;
  for (const event of events) {
    applyEvent(projection, event);
  }
  return projection;
}
function reduceSessionSeen(session, event) {
  const p = event.payload ?? {};
  if (typeof p.claude_session_id === "string" && p.claude_session_id.length > 0) {
    if (!session.claude_session_ids.includes(p.claude_session_id)) {
      session.claude_session_ids.push(p.claude_session_id);
    }
  }
  if (p.transcript_file && typeof p.transcript_file === "object") {
    const tf = p.transcript_file;
    const idx = session.transcript_files.findIndex((t) => t && t.path === tf.path);
    if (idx === -1) {
      session.transcript_files.push({ ...tf });
    } else {
      session.transcript_files[idx] = { ...session.transcript_files[idx], ...tf };
    }
  }
  if (p.fingerprints && typeof p.fingerprints === "object") {
    if (session.fingerprints.first_human_prompt_v1 == null && typeof p.fingerprints.first_human_prompt_v1 === "string") {
      session.fingerprints.first_human_prompt_v1 = p.fingerprints.first_human_prompt_v1;
    }
    if (session.fingerprints.lineage_prefix_v1 == null && typeof p.fingerprints.lineage_prefix_v1 === "string") {
      session.fingerprints.lineage_prefix_v1 = p.fingerprints.lineage_prefix_v1;
    }
  }
  setIfPresent(session, p, "worktree_path_observed");
  setIfPresent(session, p, "worktree_realpath");
  setIfPresent(session, p, "worktree_registry_name");
  setIfPresent(session, p, "git_common_dir");
  setIfPresent(session, p, "branch_current");
  setIfPresent(session, p, "head_last_seen");
  setIfMissing(session, p, "branch_at_start");
  setIfMissing(session, p, "head_at_start");
  setIfMissing(session, p, "first_prompt_preview");
  if (typeof p.cwd === "string" && session.cwd == null) {
    session.cwd = p.cwd;
  }
  if (p.identity_resolution && typeof p.identity_resolution === "object") {
    session.identity_resolution = p.identity_resolution;
  }
  if (typeof p.parent_candidates_omitted_count === "number" && p.parent_candidates_omitted_count >= 0 && Number.isFinite(p.parent_candidates_omitted_count)) {
    session.parent_candidates_omitted_count = p.parent_candidates_omitted_count;
  }
  if (typeof session.parent_candidates_omitted_count !== "number") {
    session.parent_candidates_omitted_count = 0;
  }
  if (Array.isArray(p.parent_candidate_ids)) {
    for (const candidate of p.parent_candidate_ids) {
      if (!candidate || typeof candidate !== "object") continue;
      const candidateId = typeof candidate.stable_id === "string" && candidate.stable_id.length > 0 ? candidate.stable_id : typeof candidate.parent_id === "string" && candidate.parent_id.length > 0 ? candidate.parent_id : typeof candidate.id === "string" && candidate.id.length > 0 ? candidate.id : null;
      if (candidateId === null) continue;
      const dup = session.parent_candidate_ids.find((c) => {
        const existingId = typeof c.stable_id === "string" ? c.stable_id : typeof c.parent_id === "string" ? c.parent_id : typeof c.id === "string" ? c.id : null;
        return existingId !== null && existingId === candidateId;
      });
      if (!dup) session.parent_candidate_ids.push({ ...candidate });
    }
  }
}
function reduceSessionLink(session, event) {
  const p = event.payload ?? {};
  if (p.remove === true) return;
  if (Array.isArray(p.tasks)) {
    for (const t of p.tasks) {
      if (typeof t === "string" && t.length > 0 && !session.tasks.includes(t)) {
        session.tasks.push(t);
      }
    }
  }
  if (Array.isArray(p.projects)) {
    for (const proj of p.projects) {
      if (typeof proj === "string" && proj.length > 0 && !session.projects.includes(proj)) {
        session.projects.push(proj);
      }
    }
  }
}
function reduceAliasSet(session, event) {
  const p = event.payload ?? {};
  if (p.alias === null) {
    session.alias = null;
  } else if (typeof p.alias === "string" && p.alias.length > 0) {
    session.alias = p.alias;
  }
}
function reduceParentSet(session, event) {
  const p = event.payload ?? {};
  if (p.parent_session_id === null) {
    session.parent_session_id = null;
  } else if (typeof p.parent_session_id === "string" && p.parent_session_id.length > 0) {
    session.parent_session_id = p.parent_session_id;
  }
}
function reduceClose(session, event) {
  const p = event.payload ?? {};
  if (typeof p.outcome === "string" && p.outcome.length > 0) {
    session.outcome = p.outcome;
  }
  session.closed_at = event.ts ?? session.closed_at;
  if (typeof p.closed_reason === "string") {
    session.closed_reason = p.closed_reason;
  } else if (p.closed_reason === null) {
    session.closed_reason = null;
  }
}
function reduceSweep(session, event) {
  const p = event.payload ?? {};
  if (typeof p.activity_state === "string" && p.activity_state.length > 0) {
    session.activity_state = p.activity_state;
  }
  if (typeof p.effective_last_progress === "string") {
    if (!session.last_progress_at || p.effective_last_progress > session.last_progress_at) {
      session.last_progress_at = p.effective_last_progress;
    }
  }
}
function reduceSessionUnlink(session, event) {
  const p = event.payload ?? {};
  if (Array.isArray(p.tasks) && p.tasks.length > 0) {
    const removeSet = new Set(
      p.tasks.filter((t) => typeof t === "string" && t.length > 0)
    );
    if (removeSet.size > 0 && Array.isArray(session.tasks)) {
      session.tasks = session.tasks.filter((t) => !removeSet.has(t));
    }
  }
  if (Array.isArray(p.projects) && p.projects.length > 0) {
    const removeSet = new Set(
      p.projects.filter((proj) => typeof proj === "string" && proj.length > 0)
    );
    if (removeSet.size > 0 && Array.isArray(session.projects)) {
      session.projects = session.projects.filter((proj) => !removeSet.has(proj));
    }
  }
}
function reduceManualLink(session, event) {
  const p = event.payload ?? {};
  if (Array.isArray(p.parent_candidate_ids)) {
    for (const candidate of p.parent_candidate_ids) {
      if (!candidate || typeof candidate !== "object") continue;
      const candidateId = typeof candidate.parent_id === "string" ? candidate.parent_id : typeof candidate.id === "string" ? candidate.id : null;
      const dup = session.parent_candidate_ids.find((c) => {
        const existingId = typeof c.parent_id === "string" ? c.parent_id : typeof c.id === "string" ? c.id : null;
        return existingId !== null && candidateId !== null && existingId === candidateId;
      });
      if (!dup) {
        session.parent_candidate_ids.push({ ...candidate });
      }
    }
  }
}
function setIfPresent(target, source, key) {
  const v = source[key];
  if (v !== void 0 && v !== null) {
    target[key] = v;
  }
}
function setIfMissing(target, source, key) {
  const v = source[key];
  if (target[key] == null && v !== void 0 && v !== null) {
    target[key] = v;
  }
}

// lib/uuid.mjs
var import_node_crypto = require("node:crypto");
var PREFIX = "sess_";
var UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
var SESSION_ID_RE = new RegExp(`^${PREFIX}${UUIDV7_RE.source.slice(1, -1)}$`);
var lastTimestampMs = -1;
var lastRandA = 0;
function generateSessionId() {
  const bytes = Buffer.alloc(16);
  (0, import_node_crypto.randomFillSync)(bytes);
  const nowMs = Date.now();
  let timestampMs = nowMs;
  let randA;
  if (nowMs <= lastTimestampMs) {
    timestampMs = lastTimestampMs;
    randA = lastRandA + 1 & 4095;
    if (randA === 0) {
      timestampMs += 1;
    }
  } else {
    randA = (bytes[6] & 15) << 8 | bytes[7];
  }
  bytes.writeUIntBE(timestampMs, 0, 6);
  bytes[6] = 112 | randA >>> 8 & 15;
  bytes[7] = randA & 255;
  bytes[8] = bytes[8] & 63 | 128;
  lastTimestampMs = timestampMs;
  lastRandA = randA;
  const hex = bytes.toString("hex");
  const uuid = hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20, 32);
  return PREFIX + uuid;
}
function isSessionId(s) {
  return typeof s === "string" && SESSION_ID_RE.test(s);
}
function extractTimestamp(sessionId) {
  if (!isSessionId(sessionId)) {
    throw new TypeError(`extractTimestamp: not a sessions-db id: ${sessionId}`);
  }
  const hex = sessionId.slice(PREFIX.length).replace(/-/g, "").slice(0, 12);
  return Number.parseInt(hex, 16);
}

// lib/storage.mjs
var REPO_ROOT_DEFAULT = process.cwd();
var MAX_EVENT_BYTES = 4096;
var PATHS = Object.freeze({
  eventsJsonl: "tickets/_logs/sessions-db-events.jsonl",
  projectionJson: "tickets/_logs/sessions-db.json",
  lockFile: "tickets/_logs/sessions-db.lock"
});
function newEvent({ op, stable_id, payload, ts, event_id }) {
  if (typeof op !== "string" || op.length === 0) {
    throw new TypeError("newEvent: op required");
  }
  if (typeof stable_id !== "string" || stable_id.length === 0) {
    throw new TypeError("newEvent: stable_id required");
  }
  return {
    ts: ts ?? (/* @__PURE__ */ new Date()).toISOString(),
    // generateSessionId returns `sess_<uuidv7>` — re-prefix to `evt_` so
    // event ids and stable ids are visually distinct in jsonl tails.
    event_id: event_id ?? `evt_${generateSessionId().slice("sess_".length)}`,
    op,
    stable_id,
    payload: payload ?? {}
  };
}
async function appendEvent(event, opts = {}) {
  const { eventsPath } = resolvePaths(opts);
  ensureParentDir(eventsPath);
  const line = JSON.stringify(event) + "\n";
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes > MAX_EVENT_BYTES) {
    throw new Error(
      `appendEvent: event payload too large (${bytes} bytes, max ${MAX_EVENT_BYTES}). Reduce payload size (sanitize transcript previews / fingerprints) or split into multiple events.`
    );
  }
  (0, import_node_fs3.appendFileSync)(eventsPath, line, { flag: "a" });
}
function readAllEvents(opts = {}) {
  const { eventsPath } = resolvePaths(opts);
  if (!(0, import_node_fs3.existsSync)(eventsPath)) return { events: [], corruptions: [] };
  const raw = (0, import_node_fs3.readFileSync)(eventsPath, "utf8");
  const splitLines = raw.split("\n");
  const nonEmpty = [];
  for (let i = 0; i < splitLines.length; i++) {
    if (splitLines[i].length > 0) {
      nonEmpty.push({ lineNumber: i + 1, content: splitLines[i] });
    }
  }
  const endsWithNewline = raw.length > 0 && raw.endsWith("\n");
  const events = [];
  const corruptions = [];
  for (let idx = 0; idx < nonEmpty.length; idx++) {
    const { lineNumber, content } = nonEmpty[idx];
    try {
      events.push(JSON.parse(content));
    } catch (err) {
      const isLastNonEmpty = idx === nonEmpty.length - 1;
      const isTailPartial = isLastNonEmpty && !endsWithNewline;
      corruptions.push({
        lineNumber,
        kind: isTailPartial ? "tail_partial" : "middle_corruption",
        tolerated: isTailPartial,
        excerpt: content.slice(0, 80),
        error: String(err)
      });
    }
  }
  return { events, corruptions };
}
async function loadProjection(opts = {}) {
  const { projectionPath } = resolvePaths(opts);
  if (!(0, import_node_fs3.existsSync)(projectionPath)) {
    return rebuildProjectionInMemory(opts);
  }
  let raw;
  try {
    raw = (0, import_node_fs3.readFileSync)(projectionPath, "utf8");
  } catch {
    return rebuildProjectionInMemory(opts);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.sessions || typeof parsed.sessions !== "object" || !parsed._meta || typeof parsed._meta !== "object") {
      return rebuildProjectionInMemory(opts);
    }
    return parsed;
  } catch {
    return rebuildProjectionInMemory(opts);
  }
}
async function saveProjection(projection, opts = {}) {
  const { projectionPath, lockPath } = resolvePaths(opts);
  ensureParentDir(projectionPath);
  ensureParentDir(lockPath);
  const withLock = opts.withLock !== false;
  const lock = withLock ? await acquireLock(lockPath, {
    timeoutMs: opts.lockTimeoutMs,
    retryMs: opts.lockRetryMs
  }) : null;
  try {
    saveProjectionUnlocked(projection, projectionPath);
  } finally {
    if (lock) lock.release();
  }
}
function saveProjectionUnlocked(projection, projectionPath) {
  const tmpPath = `${projectionPath}.tmp.${process.pid}`;
  try {
    if (projection && projection._meta) {
      projection._meta.updated = (/* @__PURE__ */ new Date()).toISOString();
    }
    const body = JSON.stringify(projection, null, 2);
    const fd = (0, import_node_fs3.openSync)(tmpPath, "w");
    try {
      (0, import_node_fs3.writeSync)(fd, body);
      (0, import_node_fs3.fsyncSync)(fd);
    } finally {
      (0, import_node_fs3.closeSync)(fd);
    }
    (0, import_node_fs3.renameSync)(tmpPath, projectionPath);
  } catch (err) {
    try {
      if ((0, import_node_fs3.existsSync)(tmpPath)) (0, import_node_fs3.unlinkSync)(tmpPath);
    } catch {
    }
    throw err;
  }
}
async function rebuildProjection(opts = {}) {
  const { projection, toleratedCorruptions } = rebuildProjectionInMemoryDetailed(opts);
  await saveProjection(projection, opts);
  return {
    sessionCount: Object.keys(projection.sessions).length,
    eventCount: projection._meta.event_count,
    toleratedCorruptions
  };
}
async function tryUpdateProjection(event, opts = {}) {
  try {
    await appendEvent(event, opts);
  } catch (err) {
    return { ok: false, error: `append: ${err && err.message ? err.message : String(err)}` };
  }
  const { lockPath } = resolvePaths(opts);
  ensureParentDir(lockPath);
  let lock;
  try {
    lock = await acquireLock(lockPath, {
      timeoutMs: opts.lockTimeoutMs,
      retryMs: opts.lockRetryMs
    });
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
  try {
    const projection = await loadProjection(opts);
    applyEvent(projection, event);
    await saveProjection(projection, { ...opts, withLock: false });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  } finally {
    lock.release();
  }
}
async function recordSessionSeen(opts) {
  if (!opts || typeof opts !== "object") {
    return { ok: false, error: "recordSessionSeen: opts required" };
  }
  const { claudeSessionId, payloadBuilder } = opts;
  if (typeof claudeSessionId !== "string" || claudeSessionId.length === 0) {
    return { ok: false, error: "recordSessionSeen: claudeSessionId required" };
  }
  if (typeof payloadBuilder !== "function") {
    return { ok: false, error: "recordSessionSeen: payloadBuilder required" };
  }
  const { lockPath } = resolvePaths(opts);
  ensureParentDir(lockPath);
  let lock;
  try {
    lock = await acquireLock(lockPath, {
      timeoutMs: opts.lockTimeoutMs,
      retryMs: opts.lockRetryMs
    });
  } catch (err) {
    return { ok: false, error: `lock: ${err && err.message ? err.message : String(err)}` };
  }
  try {
    const projection = await loadProjection(opts);
    const identityResolution = resolveIdentity({
      projection,
      claudeSessionId,
      transcriptMeta: opts.transcriptMeta ?? null,
      gitContext: opts.gitContext ?? null,
      cwd: opts.cwd ?? null,
      fingerprints: opts.fingerprints ?? null,
      now: opts.now,
      timeWindowHours: opts.timeWindowHours,
      minCorroborators: opts.minCorroborators,
      mintStableId: generateSessionId
    });
    const stableId = identityResolution.stableId;
    const minted = identityResolution.source === "minted";
    let payload;
    try {
      payload = payloadBuilder(stableId, identityResolution);
    } catch (err) {
      return {
        ok: false,
        error: `payloadBuilder: ${err && err.message ? err.message : String(err)}`
      };
    }
    if (!payload || typeof payload !== "object") {
      payload = {};
    }
    if (typeof payload.claude_session_id !== "string" || payload.claude_session_id.length === 0) {
      payload = { ...payload, claude_session_id: claudeSessionId };
    }
    if (opts.storeFirstPrompt === false) {
      payload.first_prompt_preview = null;
    }
    if (payload.identity_resolution === void 0) {
      payload.identity_resolution = {
        source: identityResolution.source,
        confidence: identityResolution.confidence,
        matched: identityResolution.matched
      };
    }
    if (Array.isArray(identityResolution.parentCandidates) && identityResolution.parentCandidates.length > 0) {
      const existing = Array.isArray(payload.parent_candidate_ids) ? payload.parent_candidate_ids : [];
      payload.parent_candidate_ids = [
        ...existing,
        ...identityResolution.parentCandidates
      ];
    }
    if (typeof identityResolution.parentCandidatesOmittedCount === "number" && identityResolution.parentCandidatesOmittedCount > 0 && payload.parent_candidates_omitted_count === void 0) {
      payload.parent_candidates_omitted_count = identityResolution.parentCandidatesOmittedCount;
    }
    const event = newEvent({
      op: "session_seen",
      stable_id: stableId,
      payload
    });
    try {
      await appendEvent(event, opts);
    } catch (err) {
      return {
        ok: false,
        error: `append: ${err && err.message ? err.message : String(err)}`
      };
    }
    try {
      applyEvent(projection, event);
      await saveProjection(projection, { ...opts, withLock: false });
    } catch (err) {
      return {
        ok: false,
        error: `projection: ${err && err.message ? err.message : String(err)}`
      };
    }
    return {
      ok: true,
      stableId,
      eventId: event.event_id,
      minted,
      identityResolution
    };
  } finally {
    lock.release();
  }
}
function resolvePaths(opts) {
  if (opts && opts.paths) {
    const root = opts.root ?? REPO_ROOT_DEFAULT;
    const abs = (p) => (0, import_node_path2.isAbsolute)(p) ? p : (0, import_node_path2.resolve)(root, p);
    return {
      eventsPath: abs(opts.paths.eventsJsonl),
      projectionPath: abs(opts.paths.projectionJson),
      lockPath: abs(opts.paths.lockFile)
    };
  }
  if (opts && typeof opts.rootPath === "string" && opts.rootPath.length > 0) {
    const r2 = resolveStoragePaths({ rootPath: opts.rootPath });
    return { eventsPath: r2.eventsJsonl, projectionPath: r2.projectionJson, lockPath: r2.lockFile };
  }
  if (opts && typeof opts.root === "string" && opts.root.length > 0) {
    const root = opts.root;
    const abs = (p) => (0, import_node_path2.isAbsolute)(p) ? p : (0, import_node_path2.resolve)(root, p);
    return {
      eventsPath: abs(PATHS.eventsJsonl),
      projectionPath: abs(PATHS.projectionJson),
      lockPath: abs(PATHS.lockFile)
    };
  }
  const r = resolveStoragePaths({ cwd: opts && opts.cwd });
  return { eventsPath: r.eventsJsonl, projectionPath: r.projectionJson, lockPath: r.lockFile };
}
function ensureParentDir(filePath) {
  const dir = (0, import_node_path2.dirname)(filePath);
  (0, import_node_fs3.mkdirSync)(dir, { recursive: true });
}
function readAllEventsOrThrow(opts) {
  const { events, corruptions } = readAllEvents(opts);
  const fatal = corruptions.filter((c) => !c.tolerated);
  if (fatal.length > 0) {
    const summary = fatal.map((c) => `line ${c.lineNumber}: ${c.error}`).slice(0, 5).join("; ");
    const err = new Error(
      `events.jsonl middle-line corruption (${fatal.length} line${fatal.length === 1 ? "" : "s"}): ${summary}`
    );
    err.corruptions = fatal;
    throw err;
  }
  return { events, toleratedCorruptions: corruptions.length };
}
function rebuildProjectionInMemory(opts) {
  const { events } = readAllEventsOrThrow(opts);
  if (events.length === 0) return emptyProjection();
  return rebuildFromEvents(events);
}
function rebuildProjectionInMemoryDetailed(opts) {
  const { events, toleratedCorruptions } = readAllEventsOrThrow(opts);
  const projection = events.length === 0 ? emptyProjection() : rebuildFromEvents(events);
  return { projection, toleratedCorruptions };
}

// lib/sweep.mjs
var MS_PER_DAY = 24 * 60 * 60 * 1e3;
var DEFAULT_IDLE_THRESHOLD_DAYS = 14;
var DEFAULT_ARCHIVE_THRESHOLD_DAYS = 30;
function computeSweepTransitions(projection, opts = {}) {
  const now = typeof opts.now === "number" ? opts.now : Date.now();
  const idleThreshold = pickThreshold(
    opts.idleThresholdDays,
    projection && projection._meta && projection._meta.idle_threshold_days,
    DEFAULT_IDLE_THRESHOLD_DAYS
  );
  const archiveThreshold = pickThreshold(
    opts.archiveThresholdDays,
    projection && projection._meta && projection._meta.archive_threshold_days,
    DEFAULT_ARCHIVE_THRESHOLD_DAYS
  );
  const sessions = projection && projection.sessions ? projection.sessions : {};
  const transitions = [];
  for (const [stableId, session] of Object.entries(sessions)) {
    if (!session || typeof session !== "object") continue;
    if (session.activity_state === "archived") continue;
    const hasSignal = hasAnyParseableTimestamp(session);
    if (!hasSignal) {
      continue;
    }
    const effective = computeEffectiveLastProgress(session);
    const effectiveMs = Date.parse(effective);
    if (!Number.isFinite(effectiveMs)) continue;
    const ageMs = now - effectiveMs;
    const ageDays = Math.floor(ageMs / MS_PER_DAY);
    let target;
    if (ageDays >= archiveThreshold) target = "archived";
    else if (ageDays >= idleThreshold) target = "idle";
    else target = "active";
    if (target === session.activity_state) continue;
    transitions.push({
      stable_id: stableId,
      from_state: session.activity_state,
      to_state: target,
      effective_last_progress: effective,
      age_days: ageDays
    });
  }
  return transitions;
}
function computeEffectiveLastProgress(session) {
  if (!session || typeof session !== "object") {
    return (/* @__PURE__ */ new Date(0)).toISOString();
  }
  let maxEpoch = -Infinity;
  const considerCandidate = (raw) => {
    if (typeof raw !== "string" || raw.length === 0) return;
    const epoch = Date.parse(raw);
    if (!Number.isFinite(epoch)) return;
    if (epoch > maxEpoch) maxEpoch = epoch;
  };
  considerCandidate(session.last_progress_at);
  if (Array.isArray(session.transcript_files)) {
    for (const tf of session.transcript_files) {
      if (tf && typeof tf === "object") considerCandidate(tf.mtime);
    }
  }
  considerCandidate(session.hive_watcher_last_seen);
  if (maxEpoch === -Infinity) {
    return (/* @__PURE__ */ new Date(0)).toISOString();
  }
  return new Date(maxEpoch).toISOString();
}
function hasAnyParseableTimestamp(session) {
  if (typeof session.last_progress_at === "string" && Number.isFinite(Date.parse(session.last_progress_at))) {
    return true;
  }
  if (Array.isArray(session.transcript_files)) {
    for (const tf of session.transcript_files) {
      if (tf && typeof tf.mtime === "string" && Number.isFinite(Date.parse(tf.mtime))) {
        return true;
      }
    }
  }
  if (typeof session.hive_watcher_last_seen === "string" && Number.isFinite(Date.parse(session.hive_watcher_last_seen))) {
    return true;
  }
  return false;
}
function pickThreshold(optsValue, metaValue, fallback) {
  if (typeof optsValue === "number" && Number.isFinite(optsValue) && optsValue > 0) {
    return optsValue;
  }
  if (typeof metaValue === "number" && Number.isFinite(metaValue) && metaValue > 0) {
    return metaValue;
  }
  return fallback;
}

// lib/operations.mjs
var VALID_OUTCOMES = /* @__PURE__ */ new Set([
  "open",
  "done",
  "blocked",
  "abandoned",
  "merged",
  "superseded"
]);
var MAX_PARENT_CHAIN_DEPTH = 50;
function storageOpts({ rootPath, root, paths } = {}) {
  const out = {};
  if (rootPath !== void 0) out.rootPath = rootPath;
  if (root !== void 0) out.root = root;
  if (paths !== void 0) out.paths = paths;
  return out;
}
async function ensureSessionExists(stableId, opts) {
  const projection = await loadProjection(storageOpts(opts));
  const session = projection.sessions && projection.sessions[stableId];
  if (!session) {
    return { ok: false, error: `stable_id not found: ${stableId}`, projection: null };
  }
  return { ok: true, projection, session };
}
async function commitOp({ op, stableId, payload, opts }) {
  const event = newEvent({ op, stable_id: stableId, payload });
  const result = await tryUpdateProjection(event, storageOpts(opts));
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return { ok: true, event_id: event.event_id };
}
async function setAlias(opts) {
  if (!opts || typeof opts !== "object") {
    return { ok: false, error: "setAlias: opts required" };
  }
  const { stableId, alias, clear } = opts;
  if (typeof stableId !== "string" || stableId.length === 0) {
    return { ok: false, error: "setAlias: stableId required" };
  }
  const wantsClear = clear === true;
  const hasAlias = alias !== void 0 && alias !== null;
  if (wantsClear && hasAlias) {
    return { ok: false, error: "setAlias: alias and clear are mutually exclusive" };
  }
  if (!wantsClear && !hasAlias) {
    return { ok: false, error: "setAlias: provide alias or clear=true" };
  }
  if (hasAlias && (typeof alias !== "string" || alias.length === 0)) {
    return { ok: false, error: "setAlias: alias must be a non-empty string" };
  }
  const exists = await ensureSessionExists(stableId, opts);
  if (!exists.ok) return { ok: false, error: exists.error };
  const payload = wantsClear ? { alias: null } : { alias };
  return commitOp({ op: "alias_set", stableId, payload, opts });
}
async function linkTask(opts) {
  if (!opts || typeof opts !== "object") {
    return { ok: false, error: "linkTask: opts required" };
  }
  const { stableId } = opts;
  if (typeof stableId !== "string" || stableId.length === 0) {
    return { ok: false, error: "linkTask: stableId required" };
  }
  const tasks = normalizeIdList(opts.tasks);
  const projects = normalizeIdList(opts.projects);
  if (tasks.length === 0 && projects.length === 0) {
    return { ok: false, error: "linkTask: provide at least one task or project" };
  }
  const exists = await ensureSessionExists(stableId, opts);
  if (!exists.ok) return { ok: false, error: exists.error };
  const payload = {};
  if (tasks.length > 0) payload.tasks = tasks;
  if (projects.length > 0) payload.projects = projects;
  return commitOp({ op: "session_link", stableId, payload, opts });
}
async function unlinkTask(opts) {
  if (!opts || typeof opts !== "object") {
    return { ok: false, error: "unlinkTask: opts required" };
  }
  const { stableId } = opts;
  if (typeof stableId !== "string" || stableId.length === 0) {
    return { ok: false, error: "unlinkTask: stableId required" };
  }
  const tasks = normalizeIdList(opts.tasks);
  const projects = normalizeIdList(opts.projects);
  if (tasks.length === 0 && projects.length === 0) {
    return { ok: false, error: "unlinkTask: provide at least one task or project" };
  }
  const exists = await ensureSessionExists(stableId, opts);
  if (!exists.ok) return { ok: false, error: exists.error };
  const payload = {};
  if (tasks.length > 0) payload.tasks = tasks;
  if (projects.length > 0) payload.projects = projects;
  return commitOp({ op: "session_unlink", stableId, payload, opts });
}
async function setParent(opts) {
  if (!opts || typeof opts !== "object") {
    return { ok: false, error: "setParent: opts required" };
  }
  const { childId, parentId, clear } = opts;
  if (typeof childId !== "string" || childId.length === 0) {
    return { ok: false, error: "setParent: childId required" };
  }
  const wantsClear = clear === true;
  const hasParent = parentId !== void 0 && parentId !== null;
  if (wantsClear && hasParent) {
    return { ok: false, error: "setParent: parentId and clear are mutually exclusive" };
  }
  if (!wantsClear && !hasParent) {
    return { ok: false, error: "setParent: provide parentId or clear=true" };
  }
  if (hasParent && (typeof parentId !== "string" || parentId.length === 0)) {
    return { ok: false, error: "setParent: parentId must be a non-empty string" };
  }
  if (hasParent && parentId === childId) {
    return {
      ok: false,
      error: "setParent: parent and child cannot be the same stable_id"
    };
  }
  const childCheck = await ensureSessionExists(childId, opts);
  if (!childCheck.ok) return { ok: false, error: childCheck.error };
  if (hasParent) {
    const projection = childCheck.projection;
    const parentSession = projection.sessions && projection.sessions[parentId];
    if (!parentSession) {
      return { ok: false, error: `stable_id not found: ${parentId}` };
    }
    let cursor = parentId;
    for (let depth = 0; depth < MAX_PARENT_CHAIN_DEPTH && cursor; depth++) {
      if (cursor === childId) {
        return {
          ok: false,
          error: `setParent: would create a cycle: proposed parent ${parentId} reaches child ${childId} after ${depth} hop(s)`
        };
      }
      const ancestor = projection.sessions && projection.sessions[cursor];
      cursor = ancestor && ancestor.parent_session_id ? ancestor.parent_session_id : null;
    }
  }
  const payload = wantsClear ? { parent_session_id: null } : { parent_session_id: parentId };
  return commitOp({ op: "parent_set", stableId: childId, payload, opts });
}
async function closeSession(opts) {
  if (!opts || typeof opts !== "object") {
    return { ok: false, error: "closeSession: opts required" };
  }
  const { stableId, outcome, reason } = opts;
  if (typeof stableId !== "string" || stableId.length === 0) {
    return { ok: false, error: "closeSession: stableId required" };
  }
  if (typeof outcome !== "string" || outcome.length === 0) {
    return { ok: false, error: "closeSession: outcome required" };
  }
  if (!VALID_OUTCOMES.has(outcome)) {
    return {
      ok: false,
      error: `closeSession: outcome must be one of: ${[...VALID_OUTCOMES].join(", ")}`
    };
  }
  if (reason !== void 0 && reason !== null && typeof reason !== "string") {
    return { ok: false, error: "closeSession: reason must be a string" };
  }
  const exists = await ensureSessionExists(stableId, opts);
  if (!exists.ok) return { ok: false, error: exists.error };
  const payload = { outcome };
  if (reason !== void 0) payload.closed_reason = reason;
  return commitOp({ op: "close", stableId, payload, opts });
}
async function runSweep(opts = {}) {
  const idleThresholdDays = opts.idleThresholdDays;
  const archiveThresholdDays = opts.archiveThresholdDays;
  if (idleThresholdDays !== void 0 && (!Number.isFinite(idleThresholdDays) || idleThresholdDays <= 0)) {
    return {
      ok: false,
      error: `runSweep: idleThresholdDays must be a positive number (got: ${idleThresholdDays})`
    };
  }
  if (archiveThresholdDays !== void 0 && (!Number.isFinite(archiveThresholdDays) || archiveThresholdDays <= 0)) {
    return {
      ok: false,
      error: `runSweep: archiveThresholdDays must be a positive number (got: ${archiveThresholdDays})`
    };
  }
  if (idleThresholdDays !== void 0 && archiveThresholdDays !== void 0 && archiveThresholdDays < idleThresholdDays) {
    return {
      ok: false,
      error: `runSweep: archiveThresholdDays (${archiveThresholdDays}) must be >= idleThresholdDays (${idleThresholdDays})`
    };
  }
  const projection = await loadProjection(storageOpts(opts));
  const transitions = computeSweepTransitions(projection, {
    idleThresholdDays,
    archiveThresholdDays,
    now: opts.now
  });
  if (opts.dryRun === true) {
    return { ok: true, dryRun: true, transitions };
  }
  const applied = [];
  const failed = [];
  for (const t of transitions) {
    const event = newEvent({
      op: "sweep",
      stable_id: t.stable_id,
      payload: {
        activity_state: t.to_state,
        effective_last_progress: t.effective_last_progress
      }
    });
    const result = await tryUpdateProjection(event, storageOpts(opts));
    if (result.ok) {
      applied.push({ ...t, event_id: event.event_id });
    } else {
      failed.push({ ...t, error: result.error });
    }
  }
  const toIdle = applied.filter((a) => a.to_state === "idle").length;
  const toArchived = applied.filter((a) => a.to_state === "archived").length;
  return {
    ok: failed.length === 0,
    applied,
    failed,
    summary: {
      total: transitions.length,
      applied: applied.length,
      failed: failed.length,
      to_idle: toIdle,
      to_archived: toArchived
    }
  };
}
function normalizeIdList(input) {
  if (input === void 0 || input === null) return [];
  const arr = Array.isArray(input) ? input : [input];
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const v of arr) {
    if (typeof v !== "string" || v.length === 0) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

// lib/init.mjs
var import_node_fs4 = require("node:fs");
var import_node_path3 = require("node:path");
var SCHEMA_VERSION2 = 2;
var FINGERPRINT_VERSIONS2 = ["first_human_prompt_v1", "lineage_prefix_v1"];
async function initProjection(opts) {
  if (!opts || typeof opts !== "object") {
    return { ok: false, error: "initProjection: opts required" };
  }
  const { rootPath } = opts;
  let eventsPath;
  let projectionPath;
  let source = "arg";
  if (opts.paths) {
    if (typeof rootPath !== "string" || rootPath.length === 0) {
      return { ok: false, error: "initProjection: rootPath required when paths override is supplied" };
    }
    const eventsRel = opts.paths.eventsJsonl ?? PATHS.eventsJsonl;
    const projectionRel = opts.paths.projectionJson ?? PATHS.projectionJson;
    const abs = (p) => (0, import_node_path3.isAbsolute)(p) ? p : (0, import_node_path3.resolve)(rootPath, p);
    eventsPath = abs(eventsRel);
    projectionPath = abs(projectionRel);
  } else if (typeof rootPath === "string" && rootPath.length > 0) {
    const r = resolveStoragePaths({ rootPath });
    eventsPath = r.eventsJsonl;
    projectionPath = r.projectionJson;
    source = r.source;
  } else {
    const r = resolveStoragePaths();
    eventsPath = r.eventsJsonl;
    projectionPath = r.projectionJson;
    source = r.source;
  }
  const dirsToCreate = /* @__PURE__ */ new Set([(0, import_node_path3.dirname)(eventsPath), (0, import_node_path3.dirname)(projectionPath)]);
  const created = { dir: false, eventsJsonl: false, projectionJson: false };
  try {
    for (const dir of dirsToCreate) {
      if (!(0, import_node_fs4.existsSync)(dir)) {
        (0, import_node_fs4.mkdirSync)(dir, { recursive: true });
        created.dir = true;
      }
    }
    if (!(0, import_node_fs4.existsSync)(eventsPath)) {
      (0, import_node_fs4.writeFileSync)(eventsPath, "", { flag: "wx" });
      created.eventsJsonl = true;
    }
    if (!(0, import_node_fs4.existsSync)(projectionPath)) {
      const empty = emptyProjectionLiteral();
      try {
        (0, import_node_fs4.writeFileSync)(
          projectionPath,
          JSON.stringify(empty, null, 2),
          { flag: "wx" }
        );
        created.projectionJson = true;
      } catch (err) {
        if (err && err.code === "EEXIST") {
          created.projectionJson = false;
        } else {
          throw err;
        }
      }
    }
  } catch (err) {
    return {
      ok: false,
      error: `initProjection: ${err && err.message ? err.message : String(err)}`
    };
  }
  return {
    ok: true,
    created,
    paths: { eventsJsonl: eventsPath, projectionJson: projectionPath },
    source
  };
}
function emptyProjectionLiteral() {
  return {
    _meta: {
      schema_version: SCHEMA_VERSION2,
      fingerprint_versions: [...FINGERPRINT_VERSIONS2],
      updated: (/* @__PURE__ */ new Date()).toISOString(),
      event_count: 0,
      last_event_id: null
    },
    sessions: {}
  };
}

// lib/watch.mjs
var import_node_fs5 = require("node:fs");
var import_node_path4 = require("node:path");
var DEFAULT_POLL_INTERVAL_MS = 1e3;
var DEFAULT_DEBOUNCE_MS = 80;
function watchProjection(rootPath, listener, opts = {}) {
  if (typeof rootPath !== "string" || rootPath.length === 0) {
    throw new TypeError("watchProjection: rootPath required");
  }
  if (typeof listener !== "function") {
    throw new TypeError("watchProjection: listener function required");
  }
  let projectionPath;
  if (opts.paths && opts.paths.projectionJson) {
    const projectionRel = opts.paths.projectionJson;
    projectionPath = (0, import_node_path4.isAbsolute)(projectionRel) ? projectionRel : (0, import_node_path4.resolve)(rootPath, projectionRel);
  } else {
    const r = resolveStoragePaths({ rootPath });
    projectionPath = r.projectionJson;
  }
  const pollIntervalMs = typeof opts.pollIntervalMs === "number" && opts.pollIntervalMs > 0 ? opts.pollIntervalMs : DEFAULT_POLL_INTERVAL_MS;
  const debounceMs = typeof opts.debounceMs === "number" && opts.debounceMs >= 0 ? opts.debounceMs : DEFAULT_DEBOUNCE_MS;
  let pendingTimer = null;
  let pendingType = null;
  const fireSoon = (type) => {
    pendingType = type;
    if (pendingTimer !== null) return;
    pendingTimer = setTimeout(() => {
      const t = pendingType;
      pendingTimer = null;
      pendingType = null;
      try {
        listener({ type: t, path: projectionPath });
      } catch {
      }
    }, debounceMs);
  };
  let fsWatcher = null;
  const tryAttachWatcher = () => {
    if (!(0, import_node_fs5.existsSync)(projectionPath)) return;
    if (fsWatcher) return;
    try {
      fsWatcher = (0, import_node_fs5.watch)(projectionPath, { persistent: false }, (eventType) => {
        if (eventType === "rename") {
          try {
            fsWatcher && fsWatcher.close();
          } catch {
          }
          fsWatcher = null;
        }
        fireSoon(eventType === "rename" ? "rename" : "change");
      });
      fsWatcher.on("error", () => {
        try {
          fsWatcher && fsWatcher.close();
        } catch {
        }
        fsWatcher = null;
      });
    } catch {
      fsWatcher = null;
    }
  };
  tryAttachWatcher();
  let lastMtimeMs = readMtimeSafe(projectionPath);
  let pollTimer = setInterval(() => {
    if (!fsWatcher) tryAttachWatcher();
    const current = readMtimeSafe(projectionPath);
    if (current === null) {
      if (lastMtimeMs !== null) lastMtimeMs = null;
      return;
    }
    if (lastMtimeMs === null || current !== lastMtimeMs) {
      lastMtimeMs = current;
      fireSoon("poll");
    }
  }, pollIntervalMs);
  if (typeof pollTimer.unref === "function") pollTimer.unref();
  return {
    dispose() {
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
        pendingType = null;
      }
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (fsWatcher) {
        try {
          fsWatcher.close();
        } catch {
        }
        fsWatcher = null;
      }
    }
  };
}
function readMtimeSafe(path) {
  try {
    if (!(0, import_node_fs5.existsSync)(path)) return null;
    return (0, import_node_fs5.statSync)(path).mtimeMs;
  } catch {
    return null;
  }
}

// lib/sanitize.mjs
var SYSTEM_REMINDER_RE = /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi;
var SYSTEM_RE = /<system\b[^>]*>[\s\S]*?<\/system>/gi;
var THINKING_RE = /<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi;
var TOOL_USE_RE = /<tool_use\b[^>]*>[\s\S]*?<\/tool_use>/gi;
var TOOL_RESULT_RE = /<tool_result\b[^>]*>[\s\S]*?<\/tool_result>/gi;
var PARAMETER_RE = /<parameter\b[^>]*>[\s\S]*?<\/parameter>/gi;
var IDE_OPENED_RE = /<ide_opened_file\b[^>]*>[\s\S]*?<\/ide_opened_file>/gi;
var IDE_SELECTION_RE = /<ide_selection\b[^>]*>[\s\S]*?<\/ide_selection>/gi;
var COMMAND_WRAPPER_RE = /<command-name\b[^>]*>[\s\S]*?<\/command-message>/gi;
function stripSystemReminders(s) {
  if (typeof s !== "string") return "";
  return s.replace(SYSTEM_REMINDER_RE, "").replace(SYSTEM_RE, "").replace(THINKING_RE, "").replace(TOOL_USE_RE, "").replace(TOOL_RESULT_RE, "").replace(PARAMETER_RE, "");
}
function stripIdeWrappers(s) {
  if (typeof s !== "string") return "";
  return s.replace(IDE_OPENED_RE, "").replace(IDE_SELECTION_RE, "").replace(COMMAND_WRAPPER_RE, "");
}
function sanitizeFirstPrompt(raw, opts = {}) {
  if (typeof raw !== "string") return "";
  const maxLen = Number.isFinite(opts.maxLen) && opts.maxLen > 0 ? opts.maxLen : 200;
  let s = raw;
  s = s.normalize("NFKC");
  s = stripSystemReminders(s);
  s = stripIdeWrappers(s);
  s = stripSystemReminders(s);
  s = stripIdeWrappers(s);
  s = s.replace(/\r\n/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.trim();
  if (s.length <= maxLen) return s;
  const cps = Array.from(s);
  if (cps.length <= maxLen) return s;
  return cps.slice(0, Math.max(0, maxLen - 1)).join("") + "\u2026";
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MAX_ASCEND_DEPTH,
  MAX_EVENT_BYTES,
  MAX_PARENT_CANDIDATES,
  PATHS,
  STORAGE_FILENAMES,
  STRONG_CORROBORATORS,
  WEAK_CORROBORATORS,
  appendEvent,
  applyEvent,
  capParentCandidates,
  classifyCorroborators,
  closeSession,
  collectParentCandidates,
  computeEffectiveLastProgress,
  computeSweepTransitions,
  emptyProjection,
  emptySession,
  extractTimestamp,
  findByClaudeSessionId,
  findByTranscriptLineage,
  generateSessionId,
  initProjection,
  isSessionId,
  linkTask,
  loadProjection,
  meetsThreshold,
  newEvent,
  pathsFromRoot,
  readAllEvents,
  rebuildFromEvents,
  rebuildProjection,
  recordSessionSeen,
  resolveIdentity,
  resolveStoragePaths,
  runSweep,
  sanitizeFirstPrompt,
  saveProjection,
  scanFingerprintCandidates,
  setAlias,
  setParent,
  stripIdeWrappers,
  stripSystemReminders,
  tryUpdateProjection,
  unlinkTask,
  watchProjection
});
