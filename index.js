/**
 * LinkU PPOB Backend (Digiflazz)
 * ------------------------------------------------------------
 * Dependensi : npm i express axios cors shortid node-cron firebase dotenv
 * Konfigurasi: lewat environment variable (lihat bagian CONFIG di bawah)
 * Log        : console + file harian (./logs/YYYY-MM-DD.log) + endpoint /admin/logs
 */
try { require("dotenv").config(); } catch (_) { /* dotenv opsional */ }

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const shortid = require("shortid");
const crypto = require("crypto");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const { AsyncLocalStorage } = require("async_hooks");
const { initializeApp } = require("firebase/app");
const {
  getDatabase, ref, set, get, push, update, query, orderByKey, limitToLast
} = require("firebase/database");

const ENV = process.env;

/* ============================================================
 *  LOGGER
 * ============================================================ */
const als = new AsyncLocalStorage();
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LOG_LEVEL = LEVELS[(ENV.LOG_LEVEL || "debug").toLowerCase()] || LEVELS.debug;
const LOG_DIR = ENV.LOG_DIR || path.join(__dirname, "logs");
const LOG_RETENTION_DAYS = parseInt(ENV.LOG_RETENTION_DAYS || "14", 10);
const MASK_PII = ENV.MASK_PII === "true";
let LOG_TO_FILE = ENV.LOG_TO_FILE !== "false";
const RING_MAX = 1000;
const ringBuffer = [];

if (LOG_TO_FILE) {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); }
  catch (e) { LOG_TO_FILE = false; console.error("Tidak bisa membuat folder log, log file dimatikan:", e.message); }
}

const SENSITIVE_KEY = /^(sign|apikey|api_key|secret|password|authorization|x-hub-signature|x-admin-secret|cookie)$/i;

function maskTail(s) {
  s = String(s);
  return s.length <= 4 ? "****" : "*".repeat(s.length - 4) + s.slice(-4);
}

function redact(value, depth = 0, key = "") {
  if (value === null || value === undefined) return value;
  if (SENSITIVE_KEY.test(key)) return "***";
  if (MASK_PII && key === "customer_no" && typeof value === "string") return maskTail(value);
  if (typeof value === "string") return value.length > 300 ? value.slice(0, 300) + `…(+${value.length - 300})` : value;
  if (typeof value !== "object") return value;
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length}B]`;
  if (depth >= 4) return "[depth]";
  if (Array.isArray(value)) return value.length > 5 ? `[Array(${value.length})]` : value.map(v => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = redact(v, depth + 1, k);
  return out;
}

// Waktu WIB (UTC+7): "YYYY-MM-DD HH:mm:ss.SSS"
function ts() {
  const p = new Date(Date.now() + 7 * 3600 * 1000).toISOString();
  return p.slice(0, 10) + " " + p.slice(11, 23);
}

function write(level, scope, msg, meta) {
  if (LEVELS[level] < LOG_LEVEL) return;
  const store = als.getStore();
  const rid = store && store.reqId ? ` [${store.reqId}]` : "";
  let line = `${ts()} ${level.toUpperCase().padEnd(5)}${rid} [${scope}] ${msg}`;
  if (meta !== undefined) {
    try { line += " " + JSON.stringify(redact(meta)); } catch (_) { line += " [meta tidak bisa diserialisasi]"; }
  }
  (level === "error" ? console.error : console.log)(line);
  ringBuffer.push(line);
  if (ringBuffer.length > RING_MAX) ringBuffer.shift();
  if (LOG_TO_FILE) fs.appendFile(path.join(LOG_DIR, ts().slice(0, 10) + ".log"), line + "\n", () => { });
}

const Logger = (scope) => ({
  debug: (m, x) => write("debug", scope, m, x),
  info: (m, x) => write("info", scope, m, x),
  warn: (m, x) => write("warn", scope, m, x),
  error: (m, x) => write("error", scope, m, x)
});

const log = Logger("app");
const httpLog = Logger("http");
const digiLog = Logger("digiflazz");
const fbLog = Logger("firebase");
const cacheLog = Logger("cache");
const trxLog = Logger("trx");
const hookLog = Logger("webhook");
const saldoLog = Logger("saldo");
const cronLog = Logger("cron");

function errMeta(e) {
  return {
    name: e && e.name, message: e && e.message, code: e && e.code,
    status: e && e.response && e.response.status,
    response: e && e.response && e.response.data,
    stack: e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : undefined
  };
}

function summarizeBody(b) {
  if (!b || typeof b !== "object") return b;
  const out = {};
  for (const k of ["success", "message", "error", "ref_id", "status"]) if (b[k] !== undefined) out[k] = b[k];
  if (Array.isArray(b.data)) out.dataCount = b.data.length;
  else if (b.data && typeof b.data === "object") out.data = { status: b.data.status, rc: b.data.rc, message: b.data.message };
  return out;
}

function pruneLogs() {
  if (!LOG_TO_FILE) return;
  fs.readdir(LOG_DIR, (err, files) => {
    if (err) return;
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 86400000;
    files.filter(f => f.endsWith(".log")).forEach(f => {
      const p = path.join(LOG_DIR, f);
      fs.stat(p, (e, st) => { if (!e && st.mtimeMs < cutoff) fs.unlink(p, () => { }); });
    });
  });
}

process.on("unhandledRejection", (reason) => log.error("UnhandledRejection", errMeta(reason instanceof Error ? reason : new Error(String(reason)))));
process.on("uncaughtException", (err) => log.error("UncaughtException", errMeta(err)));

/* ============================================================
 *  CONFIG
 * ============================================================ */
const CONFIG = {
  appName: ENV.APP_NAME || "linku",
  port: parseInt(ENV.PORT || "3000", 10),
  digiUser: ENV.DIGIFLAZZ_USERNAME,
  digiKey: ENV.DIGIFLAZZ_API_KEY,
  adminSecret: ENV.ADMIN_SECRET,          // pengganti REFRESH_SECRET
  webhookSecret: ENV.WEBHOOK_SECRET,
  webhookId: ENV.WEBHOOK_ID || "",
  requireWebhookSig: ENV.REQUIRE_WEBHOOK_SIGNATURE !== "false",
  saldoApiUrl: ENV.SALDO_API_URL || "https://saldo.siappgo.id/adjust.php",
  // Potong saldo Jagel dari backend HANYA untuk transaksi yang awalnya Pending lalu Sukses via webhook
  lateDeduct: ENV.LATE_DEDUCT !== "false",
  cacheTtlMs: parseInt(ENV.CACHE_TTL_MINUTES || "30", 10) * 60000,
  pricelistCron: ENV.PRICELIST_CRON || "*/30 * * * *",
  defaultAdminFee: parseInt(ENV.DEFAULT_ADMIN_FEE || "650", 10)
};

const missing = ["DIGIFLAZZ_USERNAME", "DIGIFLAZZ_API_KEY", "ADMIN_SECRET", "WEBHOOK_SECRET"].filter(k => !ENV[k]);
if (missing.length) {
  log.error(`Environment variable belum di-set: ${missing.join(", ")}. Server dihentikan.`);
  setTimeout(() => process.exit(1), 300);
}

/* ============================================================
 *  FIREBASE
 * ============================================================ */
const firebaseConfig = {
  apiKey: "AIzaSyD8P9au26mC8xx8UcjNsm-NMW5JUgTHUBU",
  authDomain: "linku-3ca65.firebaseapp.com",
  databaseURL: "https://linku-3ca65-default-rtdb.firebaseio.com",
  projectId: "linku-3ca65",
  storageBucket: "linku-3ca65.appspot.com",
  messagingSenderId: "759194220603",
  appId: "1:759194220603:web:33e2327dfa94af2552841e"
};
const database = getDatabase(initializeApp(firebaseConfig));

// Path khusus LinkU (bisa dioverride lewat env)
const DB = {
  cache: ENV.DB_CACHE_PATH || "linku/cache/pricelist",
  trxPrepaid: ENV.DB_TRX_PREPAID || "linku/trx/prepaid",
  trxPasca: ENV.DB_TRX_PASCA || "linku/trx/pasca",
  trxIndex: ENV.DB_TRX_INDEX || "linku/trx/index",
  webhookLogs: ENV.DB_WEBHOOK_LOGS || "linku/webhook_logs",
  users: ENV.DB_USERS || "linku/users"
};

const clean = (o) => JSON.parse(JSON.stringify(o)); // buang undefined (Firebase menolaknya)
const safeKey = (s) => String(s || "unknown").replace(/[.#$\[\]\/]/g, "_");

async function fbSet(p, v) {
  const t = Date.now();
  try { await set(ref(database, p), v); fbLog.debug(`SET ${p}`, { ms: Date.now() - t }); }
  catch (e) { fbLog.error(`SET gagal ${p}`, errMeta(e)); throw e; }
}
async function fbGet(p) {
  const t = Date.now();
  try { const s = await get(ref(database, p)); fbLog.debug(`GET ${p}`, { exists: s.exists(), ms: Date.now() - t }); return s; }
  catch (e) { fbLog.error(`GET gagal ${p}`, errMeta(e)); throw e; }
}
async function fbUpdate(p, v) {
  const t = Date.now();
  try { await update(ref(database, p), v); fbLog.debug(`UPDATE ${p}`, { ms: Date.now() - t }); }
  catch (e) { fbLog.error(`UPDATE gagal ${p}`, errMeta(e)); throw e; }
}

/* ============================================================
 *  DIGIFLAZZ CLIENT
 * ============================================================ */
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
const sigTrx = (refId) => md5(CONFIG.digiUser + CONFIG.digiKey + refId);
const sigPricelist = () => md5(CONFIG.digiUser + CONFIG.digiKey + "pricelist");
const sigDeposit = () => md5(CONFIG.digiUser + CONFIG.digiKey + "depo");

const digi = axios.create({
  baseURL: "https://api.digiflazz.com/v1",
  timeout: 30000,
  headers: { "Content-Type": "application/json" }
});
digi.interceptors.request.use((cfg) => {
  cfg.metadata = { start: Date.now() };
  digiLog.debug(`→ POST ${cfg.url}`, { body: cfg.data });
  return cfg;
});
digi.interceptors.response.use(
  (res) => {
    digiLog.debug(`← ${res.status} ${res.config.url} ${Date.now() - res.config.metadata.start}ms`, { body: res.data });
    return res;
  },
  (err) => {
    const cfg = err.config || {};
    digiLog.warn(`← ERROR ${cfg.url} ${cfg.metadata ? Date.now() - cfg.metadata.start : "?"}ms`, {
      code: err.code, status: err.response && err.response.status,
      body: err.response && err.response.data, message: err.message
    });
    return Promise.reject(err);
  }
);

/* ============================================================
 *  PRICELIST CACHE
 * ============================================================ */
const pl = {
  prepaid: { list: null, ts: 0, inflight: null },
  pasca: { list: null, ts: 0, inflight: null }
};

async function fetchPricelist(type) {
  const res = await digi.post("/price-list", { cmd: type, username: CONFIG.digiUser, sign: sigPricelist() });
  const list = res.data && res.data.data;
  if (!Array.isArray(list)) {
    // Digiflazz membalas error (mis. rate limit / IP ditolak) dalam objek, bukan array produk
    const info = (list && typeof list === "object") ? list : res.data;
    const e = new Error(`Pricelist ${type} bukan array. rc=${info && info.rc} message=${info && info.message}`);
    e.digiflazz = info;
    throw e;
  }
  return list;
}

function diffPricelist(oldList, newList) {
  if (!Array.isArray(oldList)) return { firstLoad: true };
  const om = new Map(oldList.map(p => [p.buyer_sku_code, p]));
  const nm = new Map(newList.map(p => [p.buyer_sku_code, p]));
  const added = [], removed = [], priceSamples = [];
  let priceChanged = 0, statusChanged = 0;
  for (const [sku, p] of nm) {
    const o = om.get(sku);
    if (!o) { added.push(sku); continue; }
    if (Number(o.price) !== Number(p.price)) { priceChanged++; if (priceSamples.length < 10) priceSamples.push(`${sku}:${o.price}->${p.price}`); }
    if (o.seller_product_status !== p.seller_product_status || o.buyer_product_status !== p.buyer_product_status) statusChanged++;
  }
  for (const sku of om.keys()) if (!nm.has(sku)) removed.push(sku);
  return {
    added: added.length, addedSample: added.slice(0, 20),
    removed: removed.length, removedSample: removed.slice(0, 20),
    priceChanged, priceSamples, statusChanged
  };
}

async function saveCacheToFirebase(type, list) {
  try {
    await fbSet(`${DB.cache}/${type}`, { data: list, count: list.length, savedAt: Date.now(), savedAtISO: new Date().toISOString() });
    cacheLog.info(`Pricelist ${type} disimpan ke Firebase`, { count: list.length });
  } catch (e) { cacheLog.error(`Gagal simpan pricelist ${type} ke Firebase`, errMeta(e)); }
}

async function loadCacheFromFirebase() {
  cacheLog.info("Memuat cache pricelist dari Firebase...");
  for (const t of ["prepaid", "pasca"]) {
    try {
      const snap = await fbGet(`${DB.cache}/${t}`);
      if (!snap.exists()) { cacheLog.info(`Cache ${t} di Firebase kosong`); continue; }
      const v = snap.val();
      let list = v.data;
      if (list && !Array.isArray(list) && typeof list === "object") list = Object.values(list);
      if (Array.isArray(list) && list.length) {
        pl[t].list = list; pl[t].ts = v.savedAt || 0;
        cacheLog.info(`Cache ${t} dimuat dari Firebase`, { count: list.length, savedAt: v.savedAtISO });
      }
    } catch (e) { cacheLog.error(`Gagal memuat cache ${t}`, errMeta(e)); }
  }
}

function refreshPricelist(type, reason) {
  const s = pl[type];
  if (s.inflight) { cacheLog.debug(`Refresh ${type} sudah berjalan, menunggu hasilnya`); return s.inflight; }
  s.inflight = (async () => {
    const t = Date.now();
    cacheLog.info(`Mengambil pricelist ${type} dari Digiflazz (${reason})`);
    try {
      const list = await fetchPricelist(type);
      const diff = diffPricelist(s.list, list);
      s.list = list; s.ts = Date.now();
      cacheLog.info(`Pricelist ${type} diperbarui`, { count: list.length, ms: Date.now() - t, ...diff });
      await saveCacheToFirebase(type, list);
      return list;
    } catch (e) {
      cacheLog.error(`Refresh pricelist ${type} GAGAL (cache lama tetap dipakai)`, { ...errMeta(e), digiflazz: e.digiflazz });
      throw e;
    } finally { s.inflight = null; }
  })();
  return s.inflight;
}

async function getPricelist(type) {
  const s = pl[type];
  if (s.list && Date.now() - s.ts < CONFIG.cacheTtlMs) {
    cacheLog.debug(`Cache hit ${type}`, { ageMin: Math.floor((Date.now() - s.ts) / 60000), count: s.list.length });
    return s.list;
  }
  try { return await refreshPricelist(type, "cache-kedaluwarsa"); }
  catch (e) {
    if (s.list) { cacheLog.warn(`Menyajikan cache ${type} yang sudah basi`, { ageMin: Math.floor((Date.now() - s.ts) / 60000) }); return s.list; }
    throw e;
  }
}

async function refreshAll(reason) {
  const [a, b] = await Promise.allSettled([refreshPricelist("prepaid", reason), refreshPricelist("pasca", reason)]);
  const errors = [];
  if (a.status === "rejected") errors.push(`prepaid: ${a.reason.message}`);
  if (b.status === "rejected") errors.push(`pasca: ${b.reason.message}`);
  return {
    success: errors.length === 0,
    prepaidCount: a.status === "fulfilled" ? a.value.length : (pl.prepaid.list || []).length,
    pascaCount: b.status === "fulfilled" ? b.value.length : (pl.pasca.list || []).length,
    errors
  };
}

/* ============================================================
 *  MARKUP, SALDO JAGEL, TRANSAKSI
 * ============================================================ */
async function getUserMarkup(user) {
  const def = { admin_fee: CONFIG.defaultAdminFee, markup: 0 };
  try {
    const snap = await fbGet(`${DB.users}/${safeKey(user)}/markup`);
    if (!snap.exists()) return def;
    const v = snap.val();
    return { admin_fee: Number(v.admin_fee ?? def.admin_fee), markup: Number(v.markup || 0) };
  } catch (_) { return def; }
}

async function saldoApi(payload) {
  const t = Date.now();
  saldoLog.debug(`→ ${payload.action}`, { user: payload.value, amount: payload.amount });
  try {
    const r = await axios.post(CONFIG.saldoApiUrl, payload, { timeout: 20000, headers: { "Content-Type": "application/json" } });
    saldoLog.info(`← ${payload.action} ${r.status} ${Date.now() - t}ms`, { body: r.data });
    return r.data;
  } catch (e) {
    saldoLog.error(`${payload.action} gagal ${Date.now() - t}ms`, errMeta(e));
    return { success: false, message: e.message };
  }
}
const notifyUser = (user, content) => saldoApi({ action: "send_message", value: user, content });

const trxPath = (kind, user, refId) => `${kind === "pasca" ? DB.trxPasca : DB.trxPrepaid}/${safeKey(user)}/${refId}`;

async function saveTransaction(kind, user, refId, digiData, meta) {
  try {
    const record = {
      data: clean({
        ...(digiData || {}),
        product_name: meta.product_name || meta.buyer_sku_code,
        buyer_sku_code: meta.buyer_sku_code,
        customer_no: meta.customer_no,
        customer_name: user,
        ref_id: refId,
        webhook_updated: false,
        balance_deducted: false,
        application: CONFIG.appName
      }),
      timestamp: Date.now(),
      date: new Date().toISOString()
    };
    await fbSet(trxPath(kind, user, refId), record);
    await fbSet(`${DB.trxIndex}/${refId}`, { user: safeKey(user), kind, ts: Date.now() });
    trxLog.info(`Transaksi ${refId} tersimpan`, { kind, user, status: record.data.status });
    return true;
  } catch (e) {
    trxLog.error(`GAGAL menyimpan transaksi ${refId} (perlu dicek manual)`, { kind, user, ...errMeta(e) });
    return false;
  }
}

async function callTransaction(body) {
  try {
    const r = await digi.post("/transaction", body);
    return r.data;
  } catch (e) {
    if (e.response && e.response.data && e.response.data.data) return e.response.data; // penolakan Digiflazz (mis. RC 69)
    if (!e.response) e.noResponse = true;                                              // timeout / jaringan putus
    throw e;
  }
}

function logTrxResult(kind, refId, user, sku, result) {
  const d = (result && result.data) || {};
  const meta = { kind, user, sku, customer_no: d.customer_no, rc: d.rc, message: d.message, price: d.price, sn: d.sn };
  if (d.status === "Sukses") trxLog.info(`Transaksi ${refId} SUKSES (saldo dipotong oleh frontend)`, meta);
  else if (d.status === "Pending") trxLog.info(`Transaksi ${refId} PENDING, menunggu webhook`, meta);
  else trxLog.warn(`Transaksi ${refId} GAGAL`, meta);
}

/* ============================================================
 *  EXPRESS APP + MIDDLEWARE
 * ============================================================ */
const app = express();
app.set("trust proxy", true);
app.use(cors());
app.use(express.json({ limit: "2mb", verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  const reqId = crypto.randomBytes(3).toString("hex");
  const start = Date.now();
  res.setHeader("X-Request-Id", reqId);
  const url = req.originalUrl.replace(/([?&]secret=)[^&]*/gi, "$1***");
  const hasBody = req.body && Object.keys(req.body).length > 0;

  als.run({ reqId }, () => {
    httpLog.info(`→ ${req.method} ${url}`, { ip: req.ip, ua: (req.headers["user-agent"] || "").slice(0, 80), body: hasBody ? req.body : undefined });
  });

  const origJson = res.json.bind(res);
  res.json = (body) => { res.locals.respBody = body; return origJson(body); };

  res.on("finish", () => {
    als.run({ reqId }, () => {
      const ms = Date.now() - start;
      const lvl = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
      httpLog[lvl](`← ${req.method} ${url} ${res.statusCode} ${ms}ms`, { resp: summarizeBody(res.locals.respBody) });
    });
  });
  als.run({ reqId }, () => next());
});

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

function adminAuth(req, res, next) {
  if (!CONFIG.adminSecret) return res.status(503).json({ success: false, error: "ADMIN_SECRET belum di-set" });
  const provided = req.headers["x-admin-secret"] || (req.body && req.body.secret) || req.query.secret || "";
  if (!safeEqual(provided, CONFIG.adminSecret)) {
    log.warn("Autentikasi admin gagal", { path: req.path, ip: req.ip });
    return res.status(403).json({ success: false, error: "Unauthorized" });
  }
  next();
}

/* ============================================================
 *  ENDPOINT PUBLIK (dipakai frontend)
 * ============================================================ */
app.get("/health", (req, res) => res.json({ ok: true, app: CONFIG.appName, uptimeSec: Math.floor(process.uptime()), time: new Date().toISOString() }));

// Catatan: ini menampilkan saldo deposit akun Digiflazz Anda. Sebaiknya jangan dipanggil dari frontend.
app.post("/balance", async (req, res) => {
  try {
    const r = await digi.post("/cek-saldo", { cmd: "deposit", username: CONFIG.digiUser, sign: sigDeposit() });
    res.json(r.data);
  } catch (e) {
    log.error("Cek saldo Digiflazz gagal", errMeta(e));
    res.status(500).json({ error: "Gagal memproses data" });
  }
});

app.post("/post-request", async (req, res) => {
  try { res.json({ data: await getPricelist("prepaid") }); }
  catch (e) { log.error("Pricelist prepaid tidak tersedia", { ...errMeta(e), digiflazz: e.digiflazz }); res.status(500).json({ error: "Daftar produk tidak tersedia" }); }
});

app.post("/post-pasca", async (req, res) => {
  try { res.json({ data: await getPricelist("pasca") }); }
  catch (e) { log.error("Pricelist pasca tidak tersedia", { ...errMeta(e), digiflazz: e.digiflazz }); res.status(500).json({ error: "Daftar produk tidak tersedia" }); }
});

app.post("/get-markup", async (req, res) => {
  const user = req.body && req.body.username;
  try {
    const m = await getUserMarkup(user);
    res.json({ success: true, ...m });
  } catch (e) {
    res.json({ success: false, admin_fee: CONFIG.defaultAdminFee, markup: 0 });
  }
});

app.post("/inquiry-pln", async (req, res) => {
  const { customer_no } = req.body || {};
  if (!customer_no) return res.status(400).json({ success: false, error: "customer_no wajib diisi" });
  try {
    const r = await digi.post("/inquiry-pln", {
      username: CONFIG.digiUser, customer_no, sign: md5(CONFIG.digiUser + CONFIG.digiKey + customer_no)
    });
    const d = r.data && r.data.data;
    if (!d) { log.warn("Inquiry PLN tanpa data", { body: r.data }); return res.json({ success: false, message: "Gagal mendapatkan informasi pelanggan" }); }
    trxLog.info("Inquiry PLN", { customer_no, status: d.status, rc: d.rc });
    res.json({
      success: true,
      data: {
        message: d.message, status: d.status, rc: d.rc, customer_no: d.customer_no,
        meter_no: d.meter_no, subscriber_id: d.subscriber_id, name: d.name, segment_power: d.segment_power
      }
    });
  } catch (e) {
    log.error("Inquiry PLN gagal", errMeta(e));
    res.status(500).json({ success: false, error: e.message });
  }
});

/* ---------- PREPAID ---------- */
app.post("/transaction", async (req, res) => {
  const b = req.body || {};
  const { buyer_sku_code, customer_no, customer_name } = b;
  if (!buyer_sku_code || !customer_no || !customer_name) {
    trxLog.warn("Parameter transaksi tidak lengkap", { body: b });
    return res.status(400).json({ success: false, error: "Parameter tidak lengkap", data: { status: "Gagal", message: "buyer_sku_code, customer_no, dan customer_name wajib diisi" } });
  }

  const refId = shortid.generate();
  trxLog.info(`Transaksi prepaid dimulai ${refId}`, { user: customer_name, sku: buyer_sku_code, customer_no, product: b.product_name, price_sell: b.price_sell });

  // Bandingkan dengan pricelist (hanya log, tidak memblokir)
  const item = (pl.prepaid.list || []).find(p => p.buyer_sku_code === buyer_sku_code);
  if (!item) trxLog.warn(`SKU ${buyer_sku_code} tidak ada di cache pricelist`);
  else {
    trxLog.debug("Data produk di cache", { price: item.price, buyer_status: item.buyer_product_status, seller_status: item.seller_product_status });
    if (Number(item.price) !== Number(b.price_sell)) trxLog.warn("Harga dari frontend berbeda dengan cache", { sent: b.price_sell, cache: item.price });
    if (item.buyer_product_status === false || item.seller_product_status === false) trxLog.warn(`Produk ${buyer_sku_code} sedang nonaktif di pricelist`);
  }

  const postData = { username: CONFIG.digiUser, buyer_sku_code, customer_no, ref_id: refId, sign: sigTrx(refId) };
  const meta = { buyer_sku_code, customer_no, product_name: b.product_name };

  try {
    const result = await callTransaction(postData);
    await saveTransaction("prepaid", customer_name, refId, result.data, meta);
    logTrxResult("prepaid", refId, customer_name, buyer_sku_code, result);
    return res.json({ ...result, ref_id: refId });
  } catch (e) {
    if (e.noResponse) {
      // Digiflazz mungkin sudah memproses. Jangan dianggap gagal: tandai Pending, biarkan webhook yang menyelesaikan.
      trxLog.error(`Transaksi ${refId} TIMEOUT/tanpa respons, ditandai Pending`, errMeta(e));
      const fake = { status: "Pending", message: "Tidak ada respons dari provider, menunggu konfirmasi", rc: "99", ref_id: refId, customer_no, buyer_sku_code };
      await saveTransaction("prepaid", customer_name, refId, fake, meta);
      return res.json({ data: fake, ref_id: refId });
    }
    trxLog.error(`Transaksi ${refId} ditolak/gagal`, errMeta(e));
    return res.status(500).json({ success: false, error: "Internal Server Error", data: { status: "Gagal", message: "Transaksi tidak dapat diproses saat ini" } });
  }
});

/* ---------- PASCABAYAR / E-MONEY ---------- */
const inquiryStore = new Map();              // ref_id inquiry harus dipakai lagi saat bayar
const INQ_TTL = 30 * 60 * 1000;
const inqKey = (u, sku, no) => `${u || ""}|${sku}|${no}`;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of inquiryStore) if (now - v.ts > INQ_TTL) inquiryStore.delete(k);
}, 5 * 60 * 1000).unref();

app.post("/inqpasca", async (req, res) => {
  const { buyer_sku_code, customer_no, customer_name, amount } = req.body || {};
  if (!buyer_sku_code || !customer_no) return res.status(400).json({ data: { status: "Gagal", message: "buyer_sku_code dan customer_no wajib diisi" } });

  const refId = shortid.generate();
  const postData = { commands: "inq-pasca", username: CONFIG.digiUser, buyer_sku_code, customer_no, ref_id: refId, sign: sigTrx(refId) };
  const amt = parseInt(amount, 10);
  if (amt > 0) postData.amount = amt;

  trxLog.info(`Inquiry pasca ${refId}`, { user: customer_name, sku: buyer_sku_code, customer_no, amount: amt > 0 ? amt : undefined });
  try {
    const r = await digi.post("/transaction", postData);
    inquiryStore.set(inqKey(customer_name, buyer_sku_code, customer_no), { ref_id: refId, amount: amt > 0 ? amt : null, ts: Date.now() });
    const d = r.data && r.data.data;
    trxLog.info(`Inquiry pasca ${refId} selesai`, { status: d && d.status, rc: d && d.rc, message: d && d.message, price: d && d.price });
    return res.status(200).json(r.data);
  } catch (e) {
    if (e.response) return res.status(e.response.status).json(e.response.data);
    return res.status(500).json({ error: e.message, data: { status: "Gagal", message: "Tidak dapat menghubungi provider" } });
  }
});

app.post("/transactionpasca", async (req, res) => {
  const b = req.body || {};
  const { buyer_sku_code, customer_no, customer_name } = b;
  if (!buyer_sku_code || !customer_no || !customer_name) {
    trxLog.warn("Parameter transaksi pasca tidak lengkap", { body: b });
    return res.status(400).json({ success: false, error: "Parameter tidak lengkap", data: { status: "Gagal", message: "buyer_sku_code, customer_no, dan customer_name wajib diisi" } });
  }

  const key = inqKey(customer_name, buyer_sku_code, customer_no);
  const inq = inquiryStore.get(key);
  let refId;
  if (inq) refId = inq.ref_id;
  else { refId = shortid.generate(); trxLog.warn(`Tidak ada inquiry sebelumnya untuk ${key}, membuat ref_id baru ${refId} (kemungkinan ditolak Digiflazz)`); }

  const postData = { commands: "pay-pasca", username: CONFIG.digiUser, buyer_sku_code, customer_no, ref_id: refId, sign: sigTrx(refId) };
  const amt = parseInt(b.amount, 10) > 0 ? parseInt(b.amount, 10) : (inq && inq.amount);
  if (amt) postData.amount = amt;

  trxLog.info(`Transaksi pasca dimulai ${refId}`, { user: customer_name, sku: buyer_sku_code, customer_no, amount: amt || undefined, usedInquiry: !!inq });
  const meta = { buyer_sku_code, customer_no, product_name: b.product_name || buyer_sku_code };

  try {
    const result = await callTransaction(postData);
    await saveTransaction("pasca", customer_name, refId, result.data, meta);
    logTrxResult("pasca", refId, customer_name, buyer_sku_code, result);
    inquiryStore.delete(key);
    return res.json({ ...result, ref_id: refId });
  } catch (e) {
    if (e.noResponse) {
      trxLog.error(`Transaksi pasca ${refId} TIMEOUT/tanpa respons, ditandai Pending`, errMeta(e));
      const fake = { status: "Pending", message: "Tidak ada respons dari provider, menunggu konfirmasi", rc: "99", ref_id: refId, customer_no, buyer_sku_code };
      await saveTransaction("pasca", customer_name, refId, fake, meta);
      return res.json({ data: fake, ref_id: refId });
    }
    trxLog.error(`Transaksi pasca ${refId} ditolak/gagal`, errMeta(e));
    return res.status(500).json({ success: false, error: "Internal Server Error", data: { status: "Gagal", message: "Transaksi tidak dapat diproses saat ini" } });
  }
});

/* ---------- RIWAYAT ---------- */
app.post("/api/history", async (req, res) => {
  const { username, limit = 50 } = req.body || {};
  if (!username) return res.status(400).json({ success: false, error: "Username required" });
  try {
    const [a, b] = await Promise.all([
      fbGet(`${DB.trxPrepaid}/${safeKey(username)}`),
      fbGet(`${DB.trxPasca}/${safeKey(username)}`)
    ]);
    const rows = [];
    for (const snap of [a, b]) {
      if (!snap.exists()) continue;
      for (const [refId, item] of Object.entries(snap.val())) {
        const d = item.data || {};
        rows.push({
          product_name: d.product_name || d.buyer_sku_code || "-",
          customer_no: d.customer_no || "-",
          price_sell: d.price || d.selling_price || 0,
          status: d.status || "Unknown",
          created_at: item.date || new Date(item.timestamp).toISOString(),
          sn: d.sn || null,
          sku_code: d.buyer_sku_code || null,
          ref_id: refId,
          webhook_updated: d.webhook_updated || false,
          application: d.application || CONFIG.appName
        });
      }
    }
    rows.sort((x, y) => new Date(y.created_at) - new Date(x.created_at));
    res.json({ success: true, data: limit > 0 ? rows.slice(0, limit) : rows });
  } catch (e) {
    log.error("Ambil riwayat gagal", errMeta(e));
    res.status(500).json({ success: false, error: e.message });
  }
});

/* ============================================================
 *  WEBHOOK DIGIFLAZZ
 * ============================================================ */
async function findTransaction(refId) {
  const idx = await fbGet(`${DB.trxIndex}/${refId}`);
  if (idx.exists()) {
    const v = idx.val();
    return { kind: v.kind, user: v.user, path: trxPath(v.kind, v.user, refId) };
  }
  hookLog.warn(`Indeks transaksi ${refId} tidak ada, memindai seluruh data (lambat)`);
  for (const kind of ["prepaid", "pasca"]) {
    const snap = await fbGet(kind === "pasca" ? DB.trxPasca : DB.trxPrepaid);
    if (!snap.exists()) continue;
    for (const [user, trxs] of Object.entries(snap.val())) {
      if (trxs && trxs[refId]) return { kind, user, path: trxPath(kind, user, refId) };
    }
  }
  return null;
}

const deductLocks = new Set();

async function lateDeduct(loc, refId, existing, wd) {
  if (!CONFIG.lateDeduct) { hookLog.info(`Potong saldo dilewati (LATE_DEDUCT=false) untuk ${refId}`); return { skipped: "disabled" }; }
  if (existing.data && existing.data.balance_deducted) { hookLog.info(`Saldo ${refId} sudah pernah dipotong`); return { skipped: "already" }; }
  if (deductLocks.has(refId)) { hookLog.warn(`Pemotongan ${refId} sedang berjalan (webhook ganda)`); return { skipped: "locked" }; }

  deductLocks.add(refId);
  try {
    const user = (existing.data && existing.data.customer_name) || loc.user;
    const base = Number(wd.selling_price || wd.price || (existing.data && existing.data.price) || 0);
    if (!base) { hookLog.error(`Harga ${refId} tidak diketahui, saldo TIDAK dipotong (perlu manual)`, { user }); return { skipped: "no-price" }; }

    const { admin_fee, markup } = await getUserMarkup(user);
    const total = Math.round(base + admin_fee + markup);
    hookLog.info(`Memotong saldo ${refId} (Pending → Sukses)`, { user, base, admin_fee, markup, total });

    const r = await saldoApi({
      action: "adjust_balance", value: user, amount: -Math.abs(total),
      note: `Transaksi ${existing.data.product_name || existing.data.buyer_sku_code} | ${existing.data.customer_no} | Rp ${total.toLocaleString("id-ID")}`
    });

    if (r && r.success) {
      await fbUpdate(`${loc.path}/data`, { balance_deducted: true, balance_deducted_amount: total, balance_deducted_at: Date.now() });
      hookLog.info(`Saldo ${refId} berhasil dipotong`, { user, total });
      await notifyUser(user, `✅ *TRANSAKSI BERHASIL!*\n\nProduk: ${existing.data.product_name || existing.data.buyer_sku_code}\nNomor/ID: ${existing.data.customer_no}\nNominal: Rp ${total.toLocaleString("id-ID")}\nWaktu: ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}\n\nTerima kasih telah bertransaksi!`);
      return { deducted: total };
    }
    hookLog.error(`PEMOTONGAN SALDO GAGAL untuk ${refId} — PERLU DIPOTONG MANUAL`, { user, total, response: r });
    await fbUpdate(`${loc.path}/data`, { balance_deduct_failed: true, balance_deduct_error: (r && r.message) || "unknown" }).catch(() => { });
    return { failed: true };
  } finally { deductLocks.delete(refId); }
}

async function applyWebhook(refId, payload) {
  const loc = await findTransaction(refId);
  if (!loc) { hookLog.warn(`Transaksi ${refId} tidak ditemukan di database`); return { found: false }; }

  const snap = await fbGet(loc.path);
  if (!snap.exists()) { hookLog.warn(`Path ${loc.path} kosong`); return { found: false }; }

  const existing = snap.val();
  const wd = payload.data || {};
  const oldStatus = existing.data && existing.data.status;
  const newStatus = wd.status || oldStatus;

  const merged = {
    ...existing,
    data: clean({
      ...existing.data, ...wd,
      status: newStatus,
      sn: wd.sn || (existing.data && existing.data.sn) || "",
      message: wd.message || (existing.data && existing.data.message),
      rc: wd.rc || (existing.data && existing.data.rc),
      webhook_updated: true, webhook_updated_at: Date.now(), webhook_id: CONFIG.webhookId,
      application: CONFIG.appName
    }),
    webhook_last_update: new Date().toISOString(),
    webhook_source: "digiflazz"
  };
  await fbSet(loc.path, merged);
  hookLog.info(`Transaksi ${refId} diperbarui`, { user: loc.user, oldStatus, newStatus, rc: wd.rc, sn: wd.sn });

  let deduct;
  const user = (existing.data && existing.data.customer_name) || loc.user;
  if (newStatus === "Sukses" && oldStatus === "Pending") {
    deduct = await lateDeduct(loc, refId, { ...existing }, wd);
  } else if (newStatus === "Gagal" && oldStatus === "Pending") {
    hookLog.info(`Transaksi ${refId} Pending → Gagal, saldo tidak pernah dipotong`);
    await notifyUser(user, `❌ *TRANSAKSI GAGAL!*\n\nProduk: ${(existing.data && (existing.data.product_name || existing.data.buyer_sku_code)) || "-"}\nNomor/ID: ${(existing.data && existing.data.customer_no) || "-"}\nAlasan: ${wd.message || "-"}\n\nSaldo Anda tidak terpotong.`);
  } else if (newStatus === "Sukses" && oldStatus === "Sukses") {
    hookLog.info(`Webhook ${refId} duplikat (sudah Sukses), diabaikan`);
  }
  return { found: true, user: loc.user, oldStatus, newStatus, deduct };
}

async function saveWebhookLog(body, headers, status, message) {
  try {
    const r = push(ref(database, DB.webhookLogs));
    await set(r, clean({
      timestamp: Date.now(), date: new Date().toISOString(), webhook_id: CONFIG.webhookId,
      headers: { "user-agent": headers["user-agent"], "x-digiflazz-event": headers["x-digiflazz-event"], "x-hub-signature": headers["x-hub-signature"] ? "present" : "missing" },
      payload: body, processing_status: status, processing_message: message,
      ip: headers["x-forwarded-for"] || headers.host, application: CONFIG.appName
    }));
  } catch (e) { hookLog.error("Gagal menyimpan log webhook ke Firebase", errMeta(e)); }
}

app.post("/webhook/digiflazz", async (req, res) => {
  const t0 = Date.now();
  const h = req.headers, body = req.body || {};
  const sig = h["x-hub-signature"];
  hookLog.info("Webhook diterima", { event: h["x-digiflazz-event"], ua: h["user-agent"], ip: req.ip, hasSignature: !!sig, bytes: req.rawBody ? req.rawBody.length : 0 });
  hookLog.debug("Webhook body", { body });

  // Verifikasi signature memakai raw body (bukan hasil JSON.stringify ulang)
  let verification = "skipped";
  if (sig) {
    const expected = "sha1=" + crypto.createHmac("sha1", CONFIG.webhookSecret).update(req.rawBody || "").digest("hex");
    if (!safeEqual(sig, expected)) {
      hookLog.error("Signature webhook TIDAK VALID", { received: String(sig).slice(0, 12) + "…" });
      await saveWebhookLog(body, h, "failed", "Invalid signature");
      return res.status(401).json({ error: "Invalid signature" });
    }
    verification = "success";
  } else if (CONFIG.requireWebhookSig) {
    hookLog.error("Webhook tanpa signature ditolak");
    await saveWebhookLog(body, h, "failed", "Missing signature");
    return res.status(401).json({ error: "Missing signature" });
  } else hookLog.warn("Webhook tanpa signature diterima (REQUIRE_WEBHOOK_SIGNATURE=false)");

  const ua = h["user-agent"];
  const type = ua === "Digiflazz-Hookshot" ? "prepaid" : ua === "Digiflazz-Pasca-Hookshot" ? "postpaid" : "unknown";
  hookLog.info(`Tipe webhook: ${type}`);

  let status = 200, message, result = { found: false };
  const refId = body.data && body.data.ref_id;
  if (refId) {
    hookLog.info(`Memproses ref_id ${refId}`, { status: body.data.status, rc: body.data.rc });
    try {
      result = await applyWebhook(refId, body);
      message = result.found ? `Transaction ${refId} updated ${result.oldStatus || "unknown"} -> ${result.newStatus}` : `Transaction ${refId} not found`;
    } catch (e) {
      hookLog.error(`Gagal memproses webhook ${refId}`, errMeta(e));
      status = 500; message = "Internal server error"; // 500 agar Digiflazz mengirim ulang
    }
  } else if ((body.zen || body.sed) && body.hook_id) {
    message = "Ping event received"; hookLog.info("Ping dari Digiflazz");
  } else {
    message = "Received but no ref_id"; hookLog.warn("Webhook tanpa ref_id", { keys: Object.keys(body) });
  }

  await saveWebhookLog(body, h, status !== 200 ? "error" : result.found ? "success" : "warning", message);
  const ms = Date.now() - t0;
  hookLog.info(`Webhook selesai ${ms}ms`, { status, message });
  res.status(status).json({ success: result.found, message, ref_id: refId || null, status: (body.data && body.data.status) || null, application: CONFIG.appName, processing_time_ms: ms, verification });
});

app.post("/webhook/ping", async (req, res) => {
  hookLog.info("Ping manual diterima");
  await saveWebhookLog(req.body, req.headers, "ping", "Ping event received");
  res.json({ success: true, message: "Pong! Webhook is active", application: CONFIG.appName });
});

app.get("/webhook/info", (req, res) => res.json({
  application: CONFIG.appName, webhook_id: CONFIG.webhookId, status: "active",
  endpoints: { main: "/webhook/digiflazz", ping: "/webhook/ping" },
  late_deduct: CONFIG.lateDeduct, signature_required: CONFIG.requireWebhookSig
}));

/* ============================================================
 *  ENDPOINT ADMIN (butuh ADMIN_SECRET via header x-admin-secret / body.secret)
 * ============================================================ */
app.post("/refresh-products", adminAuth, async (req, res) => {
  log.info("Refresh manual pricelist diminta");
  const r = await refreshAll("manual");
  if (!r.success) return res.status(502).json({ success: false, ...r });
  res.json({ success: true, message: "Cache refreshed", ...r });
});

app.get("/cache-status", (req, res) => {
  const now = Date.now();
  const info = (t) => {
    const s = pl[t];
    return { loaded: !!s.list, productCount: s.list ? s.list.length : 0, lastUpdated: s.ts ? new Date(s.ts).toISOString() : null, ageMinutes: s.ts ? Math.floor((now - s.ts) / 60000) : null, isExpired: !s.list || now - s.ts > CONFIG.cacheTtlMs, refreshing: !!s.inflight };
  };
  res.json({ application: CONFIG.appName, firebase_paths: DB, prepaid: info("prepaid"), pasca: info("pasca"), cacheTTL_minutes: CONFIG.cacheTtlMs / 60000, cron: CONFIG.pricelistCron, serverTime: new Date().toISOString() });
});

// Ambil pricelist langsung dari Digiflazz. Body: { sku?: "S2", full?: true }
app.post("/direct-prepaid", adminAuth, async (req, res) => {
  try {
    const list = await fetchPricelist("prepaid");
    const sku = req.body && req.body.sku;
    const out = { success: true, source: "direct_from_digiflazz", totalProducts: list.length };
    if (sku) out.matches = list.filter(p => p.buyer_sku_code === sku);
    if (req.body && req.body.full) out.products = list;
    res.json(out);
  } catch (e) {
    log.error("direct-prepaid gagal", { ...errMeta(e), digiflazz: e.digiflazz });
    res.status(502).json({ success: false, error: e.message, digiflazz: e.digiflazz || (e.response && e.response.data) || null });
  }
});

// Bandingkan produk di cache vs langsung dari Digiflazz: /admin/product-check?sku=S2&direct=1
app.get("/admin/product-check", adminAuth, async (req, res) => {
  const sku = req.query.sku;
  if (!sku) return res.status(400).json({ success: false, error: "parameter sku wajib" });
  const pick = (l) => (l || []).filter(p => p.buyer_sku_code === sku);
  const out = { sku, cache: { ageMinutes: pl.prepaid.ts ? Math.floor((Date.now() - pl.prepaid.ts) / 60000) : null, items: pick(pl.prepaid.list) } };
  if (req.query.direct) {
    try { out.direct = pick(await fetchPricelist("prepaid")); }
    catch (e) { out.direct = { error: e.message, digiflazz: e.digiflazz || null }; }
  }
  res.json(out);
});

// Lihat log terbaru: /admin/logs?lines=200&level=error&q=ref_id
app.get("/admin/logs", adminAuth, (req, res) => {
  const n = Math.min(parseInt(req.query.lines || "200", 10) || 200, RING_MAX);
  const level = String(req.query.level || "").toUpperCase();
  const q = String(req.query.q || "").toLowerCase();
  let lines = ringBuffer;
  if (level) lines = lines.filter(l => l.slice(24, 29).trim() === level);
  if (q) lines = lines.filter(l => l.toLowerCase().includes(q));
  res.type("text/plain").send(lines.slice(-n).join("\n") || "(log kosong)");
});

app.get("/webhook/logs", adminAuth, async (req, res) => {
  try {
    const n = Math.min(parseInt(req.query.limit || "50", 10) || 50, 200);
    const snap = await get(query(ref(database, DB.webhookLogs), orderByKey(), limitToLast(n)));
    const logs = snap.exists() ? Object.entries(snap.val()).map(([id, v]) => ({ id, ...v })).sort((a, b) => b.timestamp - a.timestamp) : [];
    res.json({ success: true, total_logs: logs.length, logs });
  } catch (e) { log.error("Ambil webhook logs gagal", errMeta(e)); res.status(500).json({ success: false, error: e.message }); }
});

app.get("/webhook/stats", adminAuth, async (req, res) => {
  try {
    const snap = await get(query(ref(database, DB.webhookLogs), orderByKey(), limitToLast(500)));
    const stats = { sampled: 0, success: 0, warning: 0, failed: 0, error: 0, ping: 0, last_24h: 0 };
    const since = Date.now() - 86400000;
    if (snap.exists()) Object.values(snap.val()).forEach(l => { stats.sampled++; if (stats[l.processing_status] !== undefined) stats[l.processing_status]++; if (l.timestamp > since) stats.last_24h++; });
    res.json({ success: true, stats, server_time: new Date().toISOString() });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* ============================================================
 *  404 + ERROR HANDLER
 * ============================================================ */
app.use((req, res) => res.status(404).json({ success: false, error: "Not found" }));
app.use((err, req, res, next) => {
  const badJson = err.type === "entity.parse.failed";
  log.error(badJson ? "JSON request tidak valid" : "Error tak tertangani", errMeta(err));
  if (res.headersSent) return next(err);
  res.status(badJson ? 400 : 500).json({ success: false, error: badJson ? "JSON tidak valid" : "Internal Server Error" });
});

/* ============================================================
 *  CRON + STARTUP
 * ============================================================ */
if (cron.validate(CONFIG.pricelistCron)) {
  cron.schedule(CONFIG.pricelistCron, () => {
    als.run({ reqId: "cron" }, async () => {
      cronLog.info(`Trigger refresh pricelist (${CONFIG.pricelistCron})`);
      const r = await refreshAll("cron");
      if (r.success) cronLog.info("Refresh selesai", { prepaid: r.prepaidCount, pasca: r.pascaCount });
      else cronLog.error("Refresh selesai dengan error", r);
    });
  }, { timezone: "Asia/Jakarta" });
} else log.error(`Ekspresi cron tidak valid: ${CONFIG.pricelistCron}`);

async function bootstrap() {
  await loadCacheFromFirebase();
  const expired = (t) => !pl[t].list || Date.now() - pl[t].ts > CONFIG.cacheTtlMs;
  if (expired("prepaid") || expired("pasca")) {
    log.info("Cache kosong/kedaluwarsa, mengambil data baru dari Digiflazz");
    const r = await refreshAll("startup");
    if (!r.success) log.error("Pengambilan awal pricelist GAGAL", r);
  } else log.info("Cache masih valid, melewati pengambilan awal");
}

if (!missing.length) {
  const server = app.listen(CONFIG.port, "0.0.0.0", () => {
    log.info(`Server ${CONFIG.appName.toUpperCase()} berjalan di port ${CONFIG.port}`, {
      node: process.version, logLevel: Object.keys(LEVELS).find(k => LEVELS[k] === LOG_LEVEL),
      logToFile: LOG_TO_FILE, logDir: LOG_DIR, maskPII: MASK_PII,
      firebasePaths: DB, saldoApi: CONFIG.saldoApiUrl, lateDeduct: CONFIG.lateDeduct,
      cron: CONFIG.pricelistCron, cacheTtlMin: CONFIG.cacheTtlMs / 60000, webhookSignatureRequired: CONFIG.requireWebhookSig
    });
    pruneLogs();
    setInterval(pruneLogs, 24 * 3600 * 1000).unref();
    bootstrap().catch(e => log.error("Bootstrap gagal", errMeta(e)));
  });

  const shutdown = (sig) => {
    log.info(`${sig} diterima, menutup server...`);
    server.close(() => { log.info("Server ditutup"); process.exit(0); });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}