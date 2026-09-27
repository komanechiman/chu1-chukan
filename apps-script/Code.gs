/**
 * 中1 中間テスト 500 ─ 写真採点の受付係（Google Apps Script）
 *
 * アプリ（GitHub Pages）から答案の写真を受け取って Google ドライブに保存し、
 * 「まとめて採点」が押されたら Claude のルーティン（クラウド）を起動する。
 * ルーティンはこのスクリプトから写真を取りに来て、採点結果を返してくる。
 *
 * 設定のしかたは SETUP.md を見てください。書きかえるのは下の3行だけです。
 */
const PAGE_KEY = "ここに合言葉";                                  // アプリの設定に入れる合言葉（自分で決める）
const ROUTINE_URL = "ここにルーティンのURL（…/fire で終わる）";      // ルーティンの API トリガーの URL
const ROUTINE_TOKEN = "ここにルーティンのトークン（sk-ant-oat01-…）"; // 同じ画面で発行したトークン

const FOLDER_NAME = "中1中間テスト 写真採点";  // 写真を保存するドライブのフォルダ
const KEEP_DAYS = 30;          // これより古い答案は自動でゴミ箱へ
const STALE_MINUTES = 20;      // 採点中のままこれだけたったら、もう一度「まとめて採点」できる
const SUBJECTS = ["japanese", "math", "english", "science", "social"];

/* ---------- 入口 ---------- */

function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    if (p.action === "batch") return out_(graderBatch_(p));
    if (p.action === "photo") return out_(graderPhoto_(p));
    return ContentService.createTextOutput("OK: 写真採点の受付係は動いています。");
  } catch (err) {
    return out_({ ok: false, error: String((err && err.message) || err) });
  }
}

function doPost(e) {
  let p;
  try { p = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: "bad_json" }); }
  try {
    switch (p.action) {
      case "ping":   checkKey_(p); return out_({ ok: true, configured: routineConfigured_() });
      case "submit": return out_(submit_(p));
      case "grade":  return out_(grade_(p));
      case "status": return out_(status_(p));
      case "remove": return out_(remove_(p));
      case "result": return out_(graderResult_(p));
      case "fail":   return out_(graderFail_(p));
    }
    return out_({ ok: false, error: "unknown_action" });
  } catch (err) {
    return out_({ ok: false, error: String((err && err.message) || err) });
  }
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- 保存まわり ---------- */

function props_() { return PropertiesService.getScriptProperties(); }

function checkKey_(p) {
  if (!PAGE_KEY || PAGE_KEY === "ここに合言葉" || p.key !== PAGE_KEY) throw new Error("bad_key");
}

function routineConfigured_() {
  return /^https:\/\/api\.anthropic\.com\/.+\/fire$/.test(ROUTINE_URL) && /^sk-ant-/.test(ROUTINE_TOKEN);
}

function folder_() {
  const it = DriveApp.getFoldersByName(FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(FOLDER_NAME);
}

// 答案1枚 = プロパティ "j_<id>"。採点結果は "r_<id>"、いま動いている採点は "batch"
function getJob_(id) { const v = props_().getProperty("j_" + id); return v ? JSON.parse(v) : null; }
function putJob_(job) { props_().setProperty("j_" + job.id, JSON.stringify(job)); }
function allJobs_() {
  const all = props_().getProperties(), list = [];
  Object.keys(all).forEach(function (k) { if (k.indexOf("j_") === 0) list.push(JSON.parse(all[k])); });
  return list;
}
function getBatch_() { const v = props_().getProperty("batch"); return v ? JSON.parse(v) : null; }

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function dropJob_(j) {
  [j.photo, j.meta].forEach(function (fid) { try { DriveApp.getFileById(fid).setTrashed(true); } catch (e) {} });
  props_().deleteProperty("j_" + j.id);
  props_().deleteProperty("r_" + j.id);
}

function cleanup_() {
  const limit = Date.now() - KEEP_DAYS * 86400000;
  allJobs_().forEach(function (j) { if (j.at < limit && j.status !== "grading") dropJob_(j); });
}

/* ---------- アプリから ---------- */

function submit_(p) {
  checkKey_(p);
  if (SUBJECTS.indexOf(p.subj) < 0) throw new Error("bad_subject");
  if (!Array.isArray(p.items) || !p.items.length || p.items.length > 10) throw new Error("bad_items");
  const m = String(p.image || "").match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new Error("bad_image");
  if (m[1].length > 8 * 1024 * 1024) throw new Error("image_too_large");

  const id = Utilities.getUuid().replace(/-/g, "").slice(0, 16);
  const folder = folder_();
  const photo = folder.createFile(Utilities.newBlob(Utilities.base64Decode(m[1]), "image/jpeg", id + ".jpg"));
  const meta = folder.createFile(id + ".json", JSON.stringify({ subj: p.subj, items: p.items }), MimeType.PLAIN_TEXT);
  return withLock_(function () {
    cleanup_();
    putJob_({ id: id, subj: p.subj, at: Date.now(), status: "pending", photo: photo.getId(), meta: meta.getId() });
    return { ok: true, id: id };
  });
}

function grade_(p) {
  checkKey_(p);
  if (!routineConfigured_()) return { ok: false, error: "routine_not_set" };

  const plan = withLock_(function () {
    let batch = getBatch_();
    if (batch) {
      const open = allJobs_().filter(function (j) { return j.batch === batch.id && j.status === "grading"; });
      const stale = Date.now() - batch.at > STALE_MINUTES * 60000;
      if (open.length && !stale) return { running: true, since: batch.at };
      // 止まってしまった採点は、送信済みにもどしてやり直す
      open.forEach(function (j) { j.status = "pending"; delete j.batch; putJob_(j); });
      props_().deleteProperty("batch");
    }
    const pend = allJobs_().filter(function (j) { return j.status === "pending"; });
    if (!pend.length) return { none: true };
    batch = { id: Utilities.getUuid().slice(0, 8), token: Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, ""), at: Date.now() };
    pend.forEach(function (j) { j.status = "grading"; j.batch = batch.id; putJob_(j); });
    props_().setProperty("batch", JSON.stringify(batch));
    return { batch: batch, count: pend.length };
  });
  if (!plan.batch) return Object.assign({ ok: true, fired: false }, plan);

  // ルーティンに渡すのは「どこへ・どの束を・どの鍵で」取りに来るかだけ
  const self = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(p.self || "") ? p.self : ScriptApp.getService().getUrl();
  let res = null;
  try {
    res = UrlFetchApp.fetch(ROUTINE_URL, {
      method: "post",
      contentType: "application/json",
      headers: {
        "Authorization": "Bearer " + ROUTINE_TOKEN,
        "anthropic-beta": "experimental-cc-routine-2026-04-01",
        "anthropic-version": "2023-06-01"
      },
      payload: JSON.stringify({ text: JSON.stringify({ url: self, batch: plan.batch.id, token: plan.batch.token }) }),
      muteHttpExceptions: true
    });
  } catch (err) { res = null; }

  const code = res ? res.getResponseCode() : 0;
  if (code >= 200 && code < 300) {
    let session = "";
    try { session = JSON.parse(res.getContentText()).claude_code_session_url || ""; } catch (e) {}
    return { ok: true, fired: true, count: plan.count, session: session };
  }

  // 起動できなかったら元にもどす
  withLock_(function () {
    allJobs_().forEach(function (j) {
      if (j.batch === plan.batch.id) { j.status = "pending"; delete j.batch; putJob_(j); }
    });
    const b = getBatch_();
    if (b && b.id === plan.batch.id) props_().deleteProperty("batch");
  });
  const body = res ? res.getContentText().slice(0, 300) : "";
  const limit = code === 429 || /limit|quota|cap/i.test(body);
  return { ok: false, error: limit ? "limit" : "fire_failed", code: code, detail: body };
}

function status_(p) {
  checkKey_(p);
  const ids = Array.isArray(p.ids) ? p.ids.slice(0, 50) : [];
  const batch = getBatch_();
  const jobs = ids.map(function (id) {
    const j = getJob_(String(id));
    if (!j) return { id: id, status: "gone" };
    const o = { id: j.id, status: j.status };
    if (j.status === "done") { const r = props_().getProperty("r_" + j.id); o.result = r ? JSON.parse(r) : null; }
    if (j.status === "error") o.reason = j.reason || "";
    return o;
  });
  return { ok: true, jobs: jobs, running: !!batch, since: batch ? batch.at : null };
}

function remove_(p) {
  checkKey_(p);
  return withLock_(function () {
    const j = getJob_(String(p.id));
    if (!j) return { ok: true };
    if (j.status === "grading") return { ok: false, error: "grading" };
    dropJob_(j);
    return { ok: true };
  });
}

/* ---------- ルーティン（採点係）から ---------- */

function checkBatch_(p) {
  const b = getBatch_();
  if (!b || p.batch !== b.id || p.token !== b.token) throw new Error("bad_batch");
  return b;
}

function graderBatch_(p) {
  const b = checkBatch_(p);
  const jobs = allJobs_().filter(function (j) { return j.batch === b.id && j.status === "grading"; }).map(function (j) {
    const meta = JSON.parse(DriveApp.getFileById(j.meta).getBlob().getDataAsString("UTF-8"));
    return { id: j.id, subj: meta.subj, items: meta.items };
  });
  return { ok: true, jobs: jobs };
}

function graderPhoto_(p) {
  const b = checkBatch_(p);
  const j = getJob_(String(p.id));
  if (!j || j.batch !== b.id) throw new Error("bad_job");
  return { ok: true, mime: "image/jpeg", data: Utilities.base64Encode(DriveApp.getFileById(j.photo).getBlob().getBytes()) };
}

function graderResult_(p) {
  const b = checkBatch_(p);
  return withLock_(function () {
    const j = getJob_(String(p.id));
    if (!j || j.batch !== b.id || j.status !== "grading") throw new Error("bad_job");
    const r = p.result || {};
    const clean = {
      items: (Array.isArray(r.items) ? r.items : []).slice(0, 10).map(function (x) {
        const g = Number(x && x.g);
        return {
          no: Number(x && x.no) || 0,
          read: String((x && x.read) == null ? "" : x.read).slice(0, 300),
          g: g === 0 || g === 1 || g === 2 ? g : 0,
          comment: String((x && x.comment) || "").slice(0, 200)
        };
      }),
      note: String(r.note || "").slice(0, 200),
      at: Date.now()
    };
    // プロパティは1つ 9KB まで。はみ出すときは文を短くする
    let s = JSON.stringify(clean), lim = [300, 200];
    while (Utilities.newBlob(s).getBytes().length > 8500 && lim[0] > 20) {
      lim = [lim[0] >> 1, lim[1] >> 1];
      clean.items.forEach(function (x) { x.read = x.read.slice(0, lim[0]); x.comment = x.comment.slice(0, lim[1]); });
      clean.note = clean.note.slice(0, lim[1]);
      s = JSON.stringify(clean);
    }
    props_().setProperty("r_" + j.id, s);
    j.status = "done";
    putJob_(j);
    closeBatchIfDone_(b);
    return { ok: true };
  });
}

function graderFail_(p) {
  const b = checkBatch_(p);
  return withLock_(function () {
    const j = getJob_(String(p.id));
    if (!j || j.batch !== b.id || j.status !== "grading") throw new Error("bad_job");
    j.status = "error";
    j.reason = String(p.reason || "").slice(0, 100);
    putJob_(j);
    closeBatchIfDone_(b);
    return { ok: true };
  });
}

function closeBatchIfDone_(b) {
  const left = allJobs_().filter(function (j) { return j.batch === b.id && j.status === "grading"; });
  if (!left.length) props_().deleteProperty("batch");
}
