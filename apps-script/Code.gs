/**
 * 中1 中間テスト 500 ─ 写真採点と結果メールの受付係（Google Apps Script）
 *
 * - アプリ（GitHub Pages）から答案の写真（複数枚可）を受け取って Google ドライブに保存し、
 *   「まとめて採点」が押されたら Claude のルーティン（クラウド）を起動する。
 *   ルーティンはこのスクリプトから写真を取りに来て、採点結果を返してくる。
 * - 4択・記述の結果と、写真の採点結果をメールで送る。
 *
 * 合言葉・ルーティンの URL・トークン・メールの送り先は settings.gs に書きます。
 * このファイル（Code.gs）は、新しい版が出たら中身を全部差しかえるだけで OK です。
 * 設定のしかたは SETUP.md を見てください。
 */

const FOLDER_NAME = "中1中間テスト 写真採点";  // 写真を保存するドライブのフォルダ
const KEEP_DAYS = 30;          // これより古い答案は自動でゴミ箱へ
const STALE_MINUTES = 20;      // 採点中のままこれだけたったら、もう一度「まとめて採点」できる
const MAX_PAGES = 6;           // 1回に送れる写真の枚数
const MAX_MAIL_PER_HOUR = 30;  // いたずら対策：1時間に送るメールの上限
const MAX_SUBMIT_PER_HOUR = 30;// いたずら対策：1時間に受け取る答案の上限
const SUBJECTS = { japanese: "国語", math: "数学", english: "英語", science: "理科", social: "社会" };

/* ---------- 入口 ---------- */

function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    if (p.action === "batch") return out_(graderBatch_(p));
    if (p.action === "photo") return out_(graderPhoto_(p));
    return ContentService.createTextOutput("OK: 写真採点の受付係は動いています。");
  } catch (err) {
    return errOut_(err);
  }
}

function doPost(e) {
  let p;
  try { p = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: "bad_json" }); }
  try {
    switch (p.action) {
      case "ping":   checkKey_(p); return out_({ ok: true, configured: routineConfigured_(), mail: true, weakKey: String(PAGE_KEY).length < 12 });
      case "submit": return out_(submit_(p));
      case "grade":  return out_(grade_(p));
      case "status": return out_(status_(p));
      case "remove": return out_(remove_(p));
      case "mail":   return out_(mail_(p));
      case "result": return out_(graderResult_(p));
      case "fail":   return out_(graderFail_(p));
    }
    return out_({ ok: false, error: "unknown_action" });
  } catch (err) {
    return errOut_(err);
  }
}

// こちらで決めたエラー名だけを返し、それ以外（Google 側の例外の文面など）は外に出さない
const KNOWN_ERRORS_ = ["bad_key", "bad_subject", "bad_items", "bad_image", "image_too_large", "bad_batch", "bad_job", "bad_page", "too_many"];
function errOut_(err) {
  const m = String((err && err.message) || err);
  if (KNOWN_ERRORS_.indexOf(m) >= 0) return out_({ ok: false, error: m });
  console.error(err);
  return out_({ ok: false, error: "server_error" });
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

// 答案1回分 = プロパティ "j_<id>"。採点結果は "r_<id>"、いま動いている採点は "batch"
function getJob_(id) { const v = props_().getProperty("j_" + id); return v ? JSON.parse(v) : null; }
function putJob_(job) { props_().setProperty("j_" + job.id, JSON.stringify(job)); }
function allJobs_() {
  const all = props_().getProperties(), list = [];
  Object.keys(all).forEach(function (k) { if (k.indexOf("j_") === 0) list.push(JSON.parse(all[k])); });
  return list;
}
function photosOf_(j) { return j.photos || (j.photo ? [j.photo] : []); }
function getBatch_() { const v = props_().getProperty("batch"); return v ? JSON.parse(v) : null; }

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function dropJob_(j) {
  photosOf_(j).concat([j.meta]).forEach(function (fid) { try { DriveApp.getFileById(fid).setTrashed(true); } catch (e) {} });
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
  if (!SUBJECTS[p.subj]) throw new Error("bad_subject");
  if (!Array.isArray(p.items) || !p.items.length || p.items.length > 10 || JSON.stringify(p.items).length > 40000) throw new Error("bad_items");
  const imgs = Array.isArray(p.images) ? p.images : (p.image ? [p.image] : []);
  if (!imgs.length || imgs.length > MAX_PAGES) throw new Error("bad_image");
  let total = 0;
  const datas = imgs.map(function (d) {
    const m = String(d || "").match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
    if (!m) throw new Error("bad_image");
    total += m[1].length;
    return m[1];
  });
  if (total > 20 * 1024 * 1024) throw new Error("image_too_large");
  if (!underLimit_("submithits", MAX_SUBMIT_PER_HOUR)) throw new Error("too_many");

  const id = Utilities.getUuid().replace(/-/g, "").slice(0, 16);
  const folder = folder_();
  const photos = datas.map(function (b64, k) {
    return folder.createFile(Utilities.newBlob(Utilities.base64Decode(b64), "image/jpeg", id + "-" + (k + 1) + ".jpg")).getId();
  });
  const meta = folder.createFile(id + ".json", JSON.stringify({ subj: p.subj, items: p.items }), MimeType.PLAIN_TEXT);
  const sec = Math.max(0, Math.min(6 * 3600, Math.round(Number(p.seconds) || 0)));
  return withLock_(function () {
    cleanup_();
    putJob_({ id: id, subj: p.subj, at: Date.now(), status: "pending", photos: photos, meta: meta.getId(), sec: sec, mail: !!p.mail });
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
    return { id: j.id, subj: meta.subj, pages: photosOf_(j).length, items: meta.items };
  });
  return { ok: true, jobs: jobs };
}

function graderPhoto_(p) {
  const b = checkBatch_(p);
  const j = getJob_(String(p.id));
  if (!j || j.batch !== b.id) throw new Error("bad_job");
  const photos = photosOf_(j), n = Math.max(1, Math.round(Number(p.page) || 1));
  if (n > photos.length) throw new Error("bad_page");
  return { ok: true, mime: "image/jpeg", page: n, pages: photos.length,
    data: Utilities.base64Encode(DriveApp.getFileById(photos[n - 1]).getBlob().getBytes()) };
}

function graderResult_(p) {
  const b = checkBatch_(p);
  const saved = withLock_(function () {
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
    return { job: j, result: clean };
  });
  // メールは鍵をはずしてから送る（失敗しても採点結果は保存ずみ）
  if (saved.job.mail) { try { photoMail_(saved.job, saved.result); } catch (e) { console.warn("photo mail failed: " + e); } }
  return { ok: true };
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

/* ---------- 結果メール ---------- */

const MARK_ = { 2: "◯", 1: "△", 0: "✕" };

function mailTo_() {
  return (typeof MAIL_TO !== "undefined" && MAIL_TO) ? MAIL_TO : Session.getEffectiveUser().getEmail();
}

function underLimit_(name, max) {
  return withLock_(function () {
    const now = Date.now();
    let hits;
    try { hits = JSON.parse(props_().getProperty(name) || "[]"); } catch (e) { hits = []; }
    hits = hits.filter(function (t) { return now - t < 3600000; });
    if (hits.length >= max) return false;
    hits.push(now);
    props_().setProperty(name, JSON.stringify(hits));
    return true;
  });
}
function underMailLimit_() { return underLimit_("mailhits", MAX_MAIL_PER_HOUR); }

// アプリから届いた4択・記述の結果（とテスト送信）
function mail_(p) {
  checkKey_(p);
  if (p.id) {
    const cache = CacheService.getScriptCache(), k = "mail_" + String(p.id).slice(0, 60);
    if (cache.get(k)) return { ok: true, skipped: "duplicate" };
    cache.put(k, "1", 21600);
  }
  if (!underMailLimit_()) return { ok: false, error: "mail_limit" };
  const s = function (v, n) { return String(v == null ? "" : v).replace(/[
	]+/g, " ").slice(0, n || 300); };
  const d = {
    kind: s(p.kind, 10), subj: s(p.subj, 10), unit: s(p.unit, 60), at: s(p.at, 40),
    pts: Math.round(Number(p.pts) || 0), score: Math.round(Number(p.score) || 0), total: Math.round(Number(p.total) || 0),
    seconds: Math.round(Number(p.seconds) || 0),
    wrong: (Array.isArray(p.wrong) ? p.wrong : []).slice(0, 20).map(function (w) { return { q: s(w.q), picked: s(w.picked, 200), answer: s(w.answer, 200) }; }),
    items: (Array.isArray(p.items) ? p.items : []).slice(0, 10).map(function (x) { return { no: Number(x.no) || 0, q: s(x.q), ans: s(x.ans, 500), model: s(x.model), g: Number(x.g) || 0 }; })
  };
  if (d.kind === "test") {
    sendMail_("[中1テスト] テスト送信", '<p style="margin:0;">結果メールの設定ができました。これから、解くたびに結果が届きます。</p>', []);
    return { ok: true };
  }
  let body = head_(d.subj + (d.kind === "quiz" ? "「" + d.unit + "」" : "　記述問題（入力）"), d.pts, d.seconds, d.at,
    d.kind === "quiz" ? d.total + "問中 " + d.score + "問正解" : "");
  if (d.kind === "quiz") {
    body += d.wrong.length ? sec_("まちがえた " + d.wrong.length + "問") + d.wrong.map(function (w) {
      return card_("#C83A3A", esc_(w.q), '<span style="color:#C83A3A;">えらんだ：' + esc_(w.picked) + '</span><br><span style="color:#1C8757;">正解：' + esc_(w.answer) + '</span>');
    }).join("") : '<p style="color:#1C8757;font-weight:bold;">全問正解でした。</p>';
  } else {
    body += sec_("1問ずつ") + d.items.map(function (x) {
      return card_(x.g === 2 ? "#1C8757" : x.g === 1 ? "#E8A317" : "#C83A3A", MARK_[x.g] + "　" + x.no + ". " + esc_(x.q),
        '答え：' + (x.ans ? esc_(x.ans) : "（空らん）") + '<br><span style="color:#5A6676;">模範解答：' + esc_(x.model) + '</span>');
    }).join("");
  }
  const title = d.kind === "quiz" ? d.subj + "「" + d.unit + "」" : d.subj + " 記述問題";
  sendMail_("[中1テスト] " + title + "　" + d.pts + "点" + (d.seconds ? "・" + fmtSec_(d.seconds) : ""), body, []);
  return { ok: true };
}

// 写真の採点が終わったとき（受付係から直接送る。答案の写真をつける）
function photoMail_(j, r) {
  if (!underMailLimit_()) return;
  const meta = JSON.parse(DriveApp.getFileById(j.meta).getBlob().getDataAsString("UTF-8"));
  const items = meta.items || [], n = items.length || 1;
  let sum = 0;
  const byNo = {};
  r.items.forEach(function (x) { byNo[x.no] = x; });
  items.forEach(function (it) { sum += (byNo[it.no] ? byNo[it.no].g : 0); });
  const pts = Math.round(sum / (2 * n) * 100);
  const subj = SUBJECTS[j.subj] || j.subj;
  const at = Utilities.formatDate(new Date(j.at), "Asia/Tokyo", "M/d H:mm");
  let body = head_(subj + "　記述問題（写真）", pts, j.sec, at + " に提出", "");
  if (r.note) body += '<p style="margin:0 0 12px;color:#5A6676;">' + esc_(r.note) + '</p>';
  body += sec_("1問ずつ（AI の採点。アプリで直した場合はそちらが正しい点数です）") + items.map(function (it) {
    const x = byNo[it.no] || { read: "", g: 0, comment: "" };
    return card_(x.g === 2 ? "#1C8757" : x.g === 1 ? "#E8A317" : "#C83A3A", MARK_[x.g] + "　" + it.no + ". " + esc_(it.q),
      '読み取り：' + (x.read ? esc_(x.read) : "（読み取れず）") + (x.comment ? '<br>' + esc_(x.comment) : '') +
      '<br><span style="color:#5A6676;">模範解答：' + esc_(it.model) + '</span>');
  }).join("");
  const files = photosOf_(j).map(function (fid, k) {
    try { return DriveApp.getFileById(fid).getBlob().setName("答案" + (k + 1) + ".jpg"); } catch (e) { return null; }
  }).filter(function (b) { return b; });
  body += '<p style="color:#5A6676;font-size:12px;">答案の写真 ' + files.length + '枚を添付しています。</p>';
  sendMail_("[中1テスト] " + subj + " 記述問題（写真）　" + pts + "点" + (j.sec ? "・" + fmtSec_(j.sec) : ""), body, files);
}

function sendMail_(subject, bodyHtml, attachments) {
  MailApp.sendEmail({
    to: mailTo_(),
    subject: subject,
    htmlBody: '<div style="font-family:-apple-system,\'Hiragino Sans\',\'Yu Gothic\',sans-serif;font-size:15px;line-height:1.8;color:#1E2935;max-width:560px;">' + bodyHtml + '</div>',
    attachments: attachments,
    name: "中1 中間テスト"
  });
}

function head_(title, pts, seconds, at, sub) {
  return '<p style="margin:0;color:#5A6676;font-size:13px;">中1 中間テスト</p>' +
    '<h2 style="margin:0 0 12px;font-size:19px;">' + esc_(title) + '</h2>' +
    '<div style="background:#F2F5F9;border-radius:14px;padding:14px 18px;margin-bottom:16px;">' +
    '<span style="font-size:34px;font-weight:bold;color:#E0352B;">' + pts + '</span><span style="color:#E0352B;"> 点</span>' +
    (sub ? '<span style="margin-left:12px;color:#5A6676;">' + esc_(sub) + '</span>' : '') +
    '<div style="font-size:13px;color:#5A6676;">' + (seconds ? "かかった時間 " + fmtSec_(seconds) + "　・　" : "") + esc_(at) + '</div></div>';
}
function sec_(t) { return '<p style="margin:0 0 8px;font-size:13px;color:#5A6676;font-weight:bold;">' + esc_(t) + '</p>'; }
function card_(color, title, body) {
  return '<div style="border-left:4px solid ' + color + ';background:#FFF;padding:10px 14px;margin-bottom:8px;border-radius:0 10px 10px 0;box-shadow:0 1px 3px rgba(0,0,0,.08);">' +
    '<div style="font-size:14px;font-weight:bold;margin-bottom:4px;">' + title + '</div><div style="font-size:13px;">' + body + '</div></div>';
}
function fmtSec_(s) { s = Math.round(Number(s) || 0); const m = Math.floor(s / 60); return m ? m + "分" + (s % 60) + "秒" : s + "秒"; }
function esc_(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

/** エディタから実行する用：メールの許可をとって、テストメールを1通送る */
function testMail() {
  sendMail_("[中1テスト] テスト送信（エディタから）", '<p style="margin:0;">結果メールの設定ができました。</p>', []);
  Logger.log("送信しました: " + mailTo_());
}
