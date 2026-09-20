const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const app = express();
const cors = require("cors");
const CryptoJS = require("crypto-js");
const shortid = require("shortid");
const FormData = require("form-data");
const crypto = require('crypto');
const cron = require("node-cron");
const port = 3000;
const { initializeApp } = require("firebase/app");
const {
  getDatabase,
  ref,
  set,
  get,
  push,
  query,
  orderByChild,
  equalTo
} = require("firebase/database");

// ============ FIREBASE CONFIG ============
const firebaseConfig = {
  apiKey: "AIzaSyD8P9au26mC8xx8UcjNsm-NMW5JUgTHUBU",
  authDomain: "linku-3ca65.firebaseapp.com",
  databaseURL: "https://linku-3ca65-default-rtdb.firebaseio.com",
  projectId: "linku-3ca65",
  storageBucket: "linku-3ca65.appspot.com",
  messagingSenderId: "759194220603",
  appId: "1:759194220603:web:33e2327dfa94af2552841e"
};

const FIREBASE = initializeApp(firebaseConfig);
const database = getDatabase(FIREBASE);

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cors());

// ============ KONFIGURASI DIGIFLAZZ ============
const username = "mezubogklPao";
const apiKey = "2eacb14c-4dcb-5a8b-b74f-1ee76df56aab";
const REFRESH_SECRET = "87linku5590";
const WEBHOOK_SECRET = "87linku5590";
const WEBHOOK_ID = "D7nzVo";

// Helper: generate signature transaksi
function generateSignature(ref_id) {
  return CryptoJS.MD5(username + apiKey + ref_id).toString();
}

// Helper: generate signature pricelist
function generatePriceListSignature() {
  return CryptoJS.MD5(username + apiKey + "pricelist").toString();
}

// ============ CACHE PRICELIST ============
let prepaidCache = null;
let pascaCache = null;
let prepaidCacheTime = 0;
let pascaCacheTime = 0;
const CACHE_TTL = 30 * 60 * 1000;

async function getCachedPrepaid() {
  if (prepaidCache && (Date.now() - prepaidCacheTime) < CACHE_TTL) {
    console.log("📦 [Cache] Returning cached prepaid pricelist");
    return prepaidCache;
  }
  console.log("🌐 [Cache] Fetching fresh prepaid pricelist from Digiflazz");
  const url = "https://api.digiflazz.com/v1/price-list";
  const data = {
    cmd: "prepaid",
    username: username,
    sign: generatePriceListSignature()
  };
  const response = await axios.post(url, data, {
    headers: { "Content-Type": "application/json" },
    timeout: 30000
  });
  prepaidCache = response.data;
  prepaidCacheTime = Date.now();
  return prepaidCache;
}

async function getCachedPasca() {
  if (pascaCache && (Date.now() - pascaCacheTime) < CACHE_TTL) {
    console.log("📦 [Cache] Returning cached pasca pricelist");
    return pascaCache;
  }
  console.log("🌐 [Cache] Fetching fresh pasca pricelist from Digiflazz");
  const url = "https://api.digiflazz.com/v1/price-list";
  const data = {
    cmd: "pasca",
    username: username,
    sign: generatePriceListSignature()
  };
  const response = await axios.post(url, data, {
    headers: { "Content-Type": "application/json" },
    timeout: 30000
  });
  pascaCache = response.data;
  pascaCacheTime = Date.now();
  return pascaCache;
}

// ============ CRON JOB - REFRESH PRICELIST OTOMATIS ============

async function refreshAllCache() {
  console.log("🔄 [Cron] Starting cache refresh...");

  try {
    prepaidCache = null;
    prepaidCacheTime = 0;
    pascaCache = null;
    pascaCacheTime = 0;

    const [prepaid, pasca] = await Promise.all([
      getCachedPrepaid(),
      getCachedPasca()
    ]);

    const prepaidCount = prepaid?.data?.length || 0;
    const pascaCount = pasca?.data?.length || 0;

    console.log(`✅ [Cron] Cache refreshed: ${prepaidCount} prepaid, ${pascaCount} pasca products`);
    console.log(`   Updated at: ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB`);

    await saveCacheToFirebase("prepaid", prepaid);
    await saveCacheToFirebase("pasca", pasca);

    return { prepaidCount, pascaCount, success: true };
  } catch (error) {
    console.error("❌ [Cron] Cache refresh failed:", error.message);
    return { success: false, error: error.message };
  }
}

async function saveCacheToFirebase(type, data) {
  try {
    const cacheRef = ref(database, `cache/pricelist/${type}`);
    await set(cacheRef, {
      data: data,
      savedAt: Date.now(),
      savedAtISO: new Date().toISOString()
    });
    console.log(`💾 [Cache] Saved ${type} pricelist to Firebase`);
  } catch (err) {
    console.error(`❌ [Cache] Failed to save ${type} to Firebase:`, err.message);
  }
}

async function loadCacheFromFirebase() {
  try {
    console.log("📂 [Startup] Loading cache from Firebase...");
    const [prepaidSnap, pascaSnap] = await Promise.all([
      get(ref(database, "cache/pricelist/prepaid")),
      get(ref(database, "cache/pricelist/pasca"))
    ]);

    if (prepaidSnap.exists()) {
      const saved = prepaidSnap.val();
      prepaidCache = saved.data;
      prepaidCacheTime = saved.savedAt;
      console.log(`📦 [Startup] Loaded prepaid from Firebase (${saved.data?.data?.length || 0} products, saved: ${saved.savedAtISO})`);
    }

    if (pascaSnap.exists()) {
      const saved = pascaSnap.val();
      pascaCache = saved.data;
      pascaCacheTime = saved.savedAt;
      console.log(`📦 [Startup] Loaded pasca from Firebase (${saved.data?.data?.length || 0} products, saved: ${saved.savedAtISO})`);
    }

    return true;
  } catch (err) {
    console.error("❌ [Startup] Failed to load cache from Firebase:", err.message);
    return false;
  }
}

cron.schedule("0 */2 * * *", async () => {
  console.log("⏰ [Cron] Triggered: Every 2 hours refresh");
  await refreshAllCache();
}, {
  timezone: "Asia/Jakarta"
});

cron.schedule("5 0 * * *", async () => {
  console.log("🌙 [Cron] Triggered: Daily midnight refresh");
  await refreshAllCache();
}, {
  timezone: "Asia/Jakarta"
});

// ============ STARTUP: Load cache dari Firebase ============
(async () => {
  await loadCacheFromFirebase();

  const prepaidExpired = !prepaidCache || (Date.now() - prepaidCacheTime) > CACHE_TTL;
  const pascaExpired = !pascaCache || (Date.now() - pascaCacheTime) > CACHE_TTL;

  if (prepaidExpired || pascaExpired) {
    console.log("🚀 [Startup] Cache expired or empty, fetching fresh data...");
    await refreshAllCache();
  } else {
    console.log("✅ [Startup] Cache still valid, skipping fresh fetch.");
  }
})();

// ============ FUNGSI CEK STATUS TRANSAKSI ============

async function checkTransactionStatus(postData) {
  const url = "https://api.digiflazz.com/v1/transaction";
  postData.sign = generateSignature(postData.ref_id);

  try {
    const response = await axios.post(url, postData, {
      headers: { "Content-Type": "application/json" },
      timeout: 30000
    });
    return response.data;
  } catch (error) {
    // Digiflazz membalas 400 tapi body-nya tetap berisi status transaksi
    if (error.response && error.response.data && error.response.data.data) {
      return error.response.data;
    }
    throw new Error("Failed to check transaction status");
  }
}

// ============ FUNGSI SIMPAN KE DATABASE (PATH GASKUY) ============

async function saveTransactionToDatabase(postData, result) {
  try {
    const customerName = postData.customer_name || postData.customerName || 'unknown';
    const refId = postData.ref_id;

    let path;
    if (postData.commands === "pay-pasca" || postData.commands === "inq-pasca") {
      path = `trxpascagaskuy/${customerName}/${refId}`;
    } else {
      path = `trxppobgaskuy/${customerName}/${refId}`;
    }

    const transactionRef = ref(database, path);
    const transactionData = {
      data: {
        ...result.data,
        product_name: postData.product_name || postData.buyer_sku_code,
        buyer_sku_code: postData.buyer_sku_code,
        customer_no: postData.customer_no,
        ref_id: refId,
        webhook_updated: false,
        application: "mudico"
      },
      timestamp: Date.now(),
      date: new Date().toISOString()
    };

    await set(transactionRef, transactionData);
    console.log(`💾 [saveTransaction] Saved to Firebase: ${path}`);
    return true;
  } catch (error) {
    console.error(`❌ [saveTransaction] Error saving to database:`, error.message);
    return false;
  }
}

async function savePascaTransactionToDatabase(customerName, refId, result, productName) {
  try {
    const transactionRef = ref(database, `trxpascagaskuy/${customerName}/${refId}`);
    const transactionData = {
      data: {
        ...result.data,
        product_name: productName,
        webhook_updated: false,
        application: "mudico"
      },
      timestamp: Date.now(),
      date: new Date().toISOString()
    };
    await set(transactionRef, transactionData);
    console.log(`💾 [savePascaTransaction] Saved to Firebase: trxpascagaskuy/${customerName}/${refId}`);
    return true;
  } catch (error) {
    console.error(`❌ [savePascaTransaction] Error:`, error.message);
    return false;
  }
}

// Fungsi untuk menyimpan log webhook ke Firebase
async function saveWebhookLogToFirebase(webhookData, headers, status, message) {
  try {
    const logRef = ref(database, `webhook_logs/${Date.now()}`);
    const logEntry = {
      timestamp: Date.now(),
      date: new Date().toISOString(),
      webhook_id: WEBHOOK_ID,
      headers: {
        'user-agent': headers['user-agent'],
        'x-digiflazz-event': headers['x-digiflazz-event'],
        'x-hub-signature': headers['x-hub-signature'] ? 'present' : 'missing'
      },
      payload: webhookData,
      processing_status: status,
      processing_message: message,
      ip: headers['x-forwarded-for'] || headers['host'],
      application: "mudico"
    };
    await set(logRef, logEntry);
    console.log(`💾 [Webhook] Log saved to Firebase with key: ${logRef.key}`);
    return true;
  } catch (error) {
    console.error(`❌ [Webhook] Failed to save log to Firebase:`, error.message);
    return false;
  }
}

async function updateTransactionViaWebhook(refId, webhookData, isPrepaid = true) {
  try {
    console.log(`🔄 [Webhook] Updating transaction ${refId} from webhook`);
    console.log(`   Webhook ID: ${WEBHOOK_ID}`);
    console.log(`   Application: MUDICO`);

    const prepaidRef = ref(database, `trxppobgaskuy`);
    const pascaRef = ref(database, `trxpascagaskuy`);

    let transactionPath = null;
    let customerName = null;

    // Cari di prepaid transactions
    const prepaidSnapshot = await get(prepaidRef);
    if (prepaidSnapshot.exists()) {
      const prepaidData = prepaidSnapshot.val();
      for (const [user, transactions] of Object.entries(prepaidData)) {
        if (transactions[refId]) {
          transactionPath = `trxppobgaskuy/${user}/${refId}`;
          customerName = user;
          break;
        }
      }
    }

    // Jika tidak ditemukan, cari di pasca transactions
    if (!transactionPath) {
      const pascaSnapshot = await get(pascaRef);
      if (pascaSnapshot.exists()) {
        const pascaData = pascaSnapshot.val();
        for (const [user, transactions] of Object.entries(pascaData)) {
          if (transactions[refId]) {
            transactionPath = `trxpascagaskuy/${user}/${refId}`;
            customerName = user;
            break;
          }
        }
      }
    }

    if (transactionPath && customerName) {
      const transactionRef = ref(database, transactionPath);
      const snapshot = await get(transactionRef);

      if (snapshot.exists()) {
        const existingData = snapshot.val();
        const updatedData = {
          ...existingData,
          data: {
            ...existingData.data,
            ...webhookData.data,
            status: webhookData.data?.status || existingData.data?.status,
            sn: webhookData.data?.sn || existingData.data?.sn,
            message: webhookData.data?.message || existingData.data?.message,
            rc: webhookData.data?.rc || existingData.data?.rc,
            webhook_updated: true,
            webhook_updated_at: Date.now(),
            webhook_id: WEBHOOK_ID,
            application: "mudico"
          },
          webhook_last_update: new Date().toISOString(),
          webhook_source: "digiflazz"
        };

        await set(transactionRef, updatedData);
        console.log(`✅ [Webhook] Updated transaction ${refId} for user ${customerName}`);
        console.log(`   New status: ${webhookData.data?.status}`);

        // Update saldo user jika status Sukses dan sebelumnya belum diupdate
        if (webhookData.data?.status === "Sukses" && existingData.data?.status !== "Sukses") {
          const sellingPrice = webhookData.data?.selling_price || webhookData.data?.price;
          if (sellingPrice && customerName) {
            await updateUserBalance(customerName, -sellingPrice);
            console.log(`💰 [Webhook] Updated balance for ${customerName}: -${sellingPrice}`);
          }
        }

        return { success: true, customerName, oldStatus: existingData.data?.status, newStatus: webhookData.data?.status };
      }
    }

    console.log(`⚠️ [Webhook] Transaction ${refId} not found in database`);
    return { success: false, error: "Transaction not found" };
  } catch (error) {
    console.error(`❌ [Webhook] Error updating transaction:`, error.message);
    return { success: false, error: error.message };
  }
}

async function updateUserBalance(username, amount) {
  try {
    const formdata = new FormData();
    formdata.append("amount", amount);
    formdata.append("username", username);
    formdata.append("app", "mudico");

    const config = {
      method: "post",
      url: "https://gaskuy.my.id/pulsa.php",
      headers: { ...formdata.getHeaders() },
      data: formdata,
    };

    const response = await axios(config);
    console.log(`💰 [updateBalance] Updated balance for ${username}: ${amount}`);
    console.log(`   Response:`, response.data);
    return response.data;
  } catch (error) {
    console.error(`❌ [updateBalance] Error:`, error.message);
    return { error: error.message };
  }
}

// ============ WEBHOOK ENDPOINT ============

app.post("/webhook/digiflazz", async (req, res) => {
  const startTime = Date.now();
  console.log(`📨 [Webhook] Received webhook from Digiflazz`);
  console.log(`   Webhook ID: ${WEBHOOK_ID}`);
  console.log(`   Application: MUDICO`);
  console.log(`   Time: ${new Date().toISOString()}`);
  console.log(`   Headers:`, req.headers);
  console.log(`   Body:`, JSON.stringify(req.body, null, 2));

  const webhookData = req.body;
  const headers = req.headers;
  const userAgent = headers['user-agent'];
  const digiflazzEvent = headers['x-digiflazz-event'];
  const hubSignature = headers['x-hub-signature'];

  let responseStatus = 200;
  let responseMessage = "Webhook processed successfully";
  let verificationStatus = "unknown";

  // Verifikasi signature
  if (WEBHOOK_SECRET && hubSignature) {
    const rawBody = JSON.stringify(req.body);
    const expectedSignature = 'sha1=' + crypto.createHmac('sha1', WEBHOOK_SECRET).update(rawBody).digest('hex');

    if (hubSignature !== expectedSignature) {
      console.error(`❌ [Webhook] Invalid signature!`);
      verificationStatus = "failed";
      responseStatus = 401;
      responseMessage = "Invalid signature";

      await saveWebhookLogToFirebase(webhookData, headers, "failed", "Invalid signature");
      return res.status(401).json({ error: "Invalid signature", webhook_id: WEBHOOK_ID });
    }
    verificationStatus = "success";
    console.log(`✅ [Webhook] Signature verified`);
  }

  let transactionType = "unknown";
  if (userAgent === "Digiflazz-Hookshot") {
    transactionType = "prepaid";
    console.log(`📱 [Webhook] Prepaid transaction detected`);
  } else if (userAgent === "Digiflazz-Pasca-Hookshot") {
    transactionType = "postpaid";
    console.log(`📄 [Webhook] Postpaid transaction detected`);
  }

  console.log(`🎯 [Webhook] Event: ${digiflazzEvent}`);

  let updateResult = { success: false };

  if (webhookData.data && webhookData.data.ref_id) {
    const refId = webhookData.data.ref_id;
    const status = webhookData.data.status;
    console.log(`🆔 [Webhook] Ref ID: ${refId}, Status: ${status}`);

    try {
      updateResult = await updateTransactionViaWebhook(refId, webhookData, transactionType === "prepaid");
      responseMessage = updateResult.success
        ? `Transaction ${refId} updated from ${updateResult.oldStatus || 'unknown'} to ${updateResult.newStatus || status}`
        : `Webhook received but transaction ${refId} not found`;
    } catch (error) {
      console.error(`❌ [Webhook] Error processing:`, error);
      responseStatus = 500;
      responseMessage = "Internal server error";
    }
  } else {
    responseMessage = "Received but no ref_id";
    if (webhookData.sed && webhookData.hook_id) {
      console.log(`🏓 [Webhook] Ping event received!`);
      responseMessage = "Ping event received";
    }
  }

  await saveWebhookLogToFirebase(webhookData, headers, updateResult.success ? "success" : "warning", responseMessage);

  const processingTime = Date.now() - startTime;
  console.log(`⏱️ [Webhook] Processing time: ${processingTime}ms`);

  res.status(responseStatus).json({
    success: updateResult.success,
    message: responseMessage,
    webhook_id: WEBHOOK_ID,
    application: "mudico",
    ref_id: webhookData.data?.ref_id || null,
    status: webhookData.data?.status || null,
    processing_time_ms: processingTime,
    verification: verificationStatus
  });
});

app.post("/webhook/ping", async (req, res) => {
  console.log(`🏓 [Webhook-Ping] Received ping from Digiflazz`);
  await saveWebhookLogToFirebase(req.body, req.headers, "ping", "Ping event received");
  res.status(200).json({ success: true, message: "Pong! Webhook is active", webhook_id: WEBHOOK_ID, application: "mudico" });
});

app.get("/webhook/test-ping", async (req, res) => {
  console.log(`🔧 [Webhook] Testing ping to Digiflazz webhook ${WEBHOOK_ID}`);
  try {
    const response = await axios.post(`https://api.digiflazz.com/v1/report/hooks/${WEBHOOK_ID}/pings`, {});
    res.json({ success: true, message: "Ping sent successfully", webhook_id: WEBHOOK_ID, application: "mudico", response: response.data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message, webhook_id: WEBHOOK_ID });
  }
});

app.get("/webhook/logs", async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const logsRef = ref(database, `webhook_logs`);
    const snapshot = await get(logsRef);
    let logs = [];
    if (snapshot.exists()) {
      const data = snapshot.val();
      logs = Object.entries(data).map(([key, value]) => ({ id: key, ...value }))
        .sort((a, b) => b.timestamp - a.timestamp).slice(0, parseInt(limit));
    }
    res.json({ success: true, webhook_id: WEBHOOK_ID, application: "mudico", total_logs: logs.length, logs: logs });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/webhook/stats", async (req, res) => {
  try {
    const logsRef = ref(database, `webhook_logs`);
    const snapshot = await get(logsRef);
    let stats = { total: 0, success: 0, warning: 0, failed: 0, ping: 0, last_24h: 0 };
    const last24h = Date.now() - (24 * 60 * 60 * 1000);
    if (snapshot.exists()) {
      const data = snapshot.val();
      stats.total = Object.keys(data).length;
      Object.values(data).forEach(log => {
        if (log.processing_status === "success") stats.success++;
        if (log.processing_status === "warning") stats.warning++;
        if (log.processing_status === "failed") stats.failed++;
        if (log.processing_status === "ping") stats.ping++;
        if (log.timestamp > last24h) stats.last_24h++;
      });
    }
    res.json({ success: true, webhook_id: WEBHOOK_ID, application: "mudico", stats: stats, server_time: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/webhook/info", (req, res) => {
  res.json({
    webhook_id: WEBHOOK_ID,
    application: "mudico",
    firebase_paths: "gaskuy (trxppobgaskuy, trxpascagaskuy, cache/pricelist, webhook_logs)",
    endpoints: {
      main: "/webhook/digiflazz",
      ping: "/webhook/ping",
      logs: "/webhook/logs",
      stats: "/webhook/stats",
      test_ping: "/webhook/test-ping"
    },
    status: "active",
    mode: "WEBHOOK ONLY (No Polling)",
    config: {
      has_secret: !!WEBHOOK_SECRET,
      secret_type: "letters_numbers_spaces",
      supported_events: ["create", "update"],
      supported_transactions: ["prepaid", "postpaid"]
    }
  });
});

// ============ ENDPOINTS ============

app.post("/balance", async (req, res) => {
  console.log(`📥 [balance] Request received - MUDICO`);
  const url = "https://api.digiflazz.com/v1/cek-saldo";
  const signature = crypto.createHash('md5').update(username + apiKey + "depo").digest('hex');
  const data = { cmd: "deposit", username: username, sign: signature };
  try {
    const response = await axios.post(url, data, { headers: { "Content-Type": "application/json" }, timeout: 30000 });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: "Gagal memproses data" });
  }
});

app.post("/post-request", async (req, res) => {
  console.log(`📥 [post-request] Request received - MUDICO`);
  try {
    const cachedData = await getCachedPrepaid();
    res.json(cachedData);
  } catch (error) {
    res.status(500).json({ error: "Tidak ada koneksi Internet" });
  }
});

app.post("/post-pasca", async (req, res) => {
  console.log(`📥 [post-pasca] Request received - MUDICO`);
  try {
    const cachedData = await getCachedPasca();
    res.json(cachedData);
  } catch (error) {
    res.status(500).json({ error: "Tidak ada koneksi Internet" });
  }
});

// ============ TRANSACTION PREPAID (WEBHOOK ONLY - NO POLLING) ============
app.post("/transaction", async (req, res) => {
  console.log(`📥 [transaction] Request received - MUDICO (Webhook Only Mode - No Polling)`);
  console.log(`   Body:`, req.body);

  const ref_id = shortid.generate();
  const sign = generateSignature(ref_id);

  const postData = {
    username: username,
    buyer_sku_code: req.body.buyer_sku_code,
    customer_no: req.body.customer_no,
    ref_id: ref_id,
    sign: sign,
    customer_name: req.body.customer_name,
    product_name: req.body.product_name || req.body.buyer_sku_code
  };

  console.log(`   Ref ID: ${ref_id}`);
  console.log(`   Customer: ${postData.customer_name}`);

  try {
    const responseData = await checkTransactionStatus(postData);
    console.log(`   Initial status: ${responseData.data?.status}`);

    // Simpan transaksi ke database terlebih dahulu
    await saveTransactionToDatabase(postData, responseData);

    // Jika langsung Sukses, update saldo
    if (responseData.data && responseData.data.status === "Sukses") {
      console.log(`✅ [transaction] Transaction ${ref_id} langsung sukses`);
      if (responseData.data.selling_price) {
        await updateUserBalance(req.body.customer_name, -responseData.data.selling_price);
      }
      return res.json(responseData);
    }

    // Jika Pending, response cepat - biarkan webhook yang update
    if (responseData.data && responseData.data.status === "Pending") {
      console.log(`⏳ [transaction] Transaction ${ref_id} pending, menunggu webhook dari Digiflazz`);
      return res.json({
        success: true,
        message: "Transaksi sedang diproses, akan diupdate secara real-time via webhook",
        ref_id: ref_id,
        status: "Pending",
        application: "mudico",
        note: "Status akan terupdate otomatis dalam beberapa detik"
      });
    }

    // Jika Gagal
    res.json(responseData);

  } catch (error) {
    console.error("❌ [transaction] Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ============ TRANSACTION POSTPAID (WEBHOOK ONLY - NO POLLING) ============
let temporaryRefId = null;
let temporaryData = {};

app.post("/inqpasca", async (req, res) => {
  console.log(`📥 [inqpasca] Request received - MUDICO`);
  const ref_id = shortid.generate();
  const sign = generateSignature(ref_id);

  let postData = {
    commands: "inq-pasca",
    username: username,
    buyer_sku_code: req.body.buyer_sku_code,
    customer_no: req.body.customer_no,
    ref_id: ref_id,
    sign: sign
  };

  if (req.body.amount && parseInt(req.body.amount) > 0) {
    postData.amount = parseInt(req.body.amount);
  }

  try {
    const response = await axios.post("https://api.digiflazz.com/v1/transaction", postData, {
      headers: { "Content-Type": "application/json" },
      timeout: 30000
    });

    temporaryRefId = ref_id;
    temporaryData[ref_id] = {
      buyer_sku_code: req.body.buyer_sku_code,
      customer_no: req.body.customer_no,
      customer_name: req.body.customer_name,
      amount: req.body.amount || null
    };

    res.status(200).json(response.data);
  } catch (error) {
    if (error.response) {
      res.status(error.response.status).json(error.response.data);
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

app.post("/transactionpasca", async (req, res) => {
  console.log(`📥 [transactionpasca] Request received - MUDICO (Webhook Only Mode - No Polling)`);
  console.log(`   Body:`, req.body);

  let ref_id = temporaryRefId;
  if (!ref_id) {
    ref_id = shortid.generate();
    console.log(`   ⚠️ No ref_id found, generating new: ${ref_id}`);
  }

  const sign = generateSignature(ref_id);

  let postData = {
    commands: "pay-pasca",
    username: username,
    buyer_sku_code: req.body.buyer_sku_code,
    customer_no: req.body.customer_no,
    ref_id: ref_id,
    sign: sign,
    customer_name: req.body.customer_name
  };

  if (temporaryData[ref_id] && temporaryData[ref_id].amount) {
    postData.amount = temporaryData[ref_id].amount;
  }
  if (req.body.amount && parseInt(req.body.amount) > 0) {
    postData.amount = parseInt(req.body.amount);
  }

  console.log(`   Customer: ${postData.customer_name}`);
  console.log(`   Ref ID: ${ref_id}`);

  try {
    const responseData = await checkTransactionStatus(postData);
    console.log(`   Initial status: ${responseData.data?.status}`);

    // Simpan transaksi ke database
    await savePascaTransactionToDatabase(req.body.customer_name, ref_id, responseData, req.body.buyer_sku_code);

    // Jika langsung Sukses
    if (responseData.data && responseData.data.status === "Sukses") {
      console.log(`✅ [transactionpasca] Transaction ${ref_id} langsung sukses`);
      if (responseData.data.selling_price) {
        await updateUserBalance(req.body.customer_name, -responseData.data.selling_price);
      }
      res.json(responseData);
    }
    // Jika Pending - biarkan webhook update
    else if (responseData.data && responseData.data.status === "Pending") {
      console.log(`⏳ [transactionpasca] Transaction ${ref_id} pending, menunggu webhook`);
      res.json({
        success: true,
        message: "Transaksi sedang diproses, akan diupdate secara real-time via webhook",
        ref_id: ref_id,
        status: "Pending",
        application: "mudico",
        note: "Status akan terupdate otomatis dalam beberapa detik"
      });
    } else {
      res.json(responseData);
    }
  } catch (error) {
    console.error("❌ [transactionpasca] Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  } finally {
    if (ref_id) delete temporaryData[ref_id];
    temporaryRefId = null;
  }
});

// ============ ENDPOINTS LAINNYA ============

app.post("/get-markup", async (req, res) => {
  try {
    const { username } = req.body;
    const markupRef = ref(database, `users/${username}/markup`);
    const snapshot = await get(markupRef);
    let markupData = { admin_fee: 650, markup: 0 };
    if (snapshot.exists()) markupData = snapshot.val();
    res.json({ success: true, ...markupData });
  } catch (error) {
    res.json({ success: false, admin_fee: 500, markup: 0 });
  }
});

app.post("/inquiry-pln", async (req, res) => {
  console.log(`📥 [inquiry-pln] Request received - MUDICO`);
  const { customer_no } = req.body;
  if (!customer_no) return res.status(400).json({ error: "customer_no wajib diisi" });

  const sign = CryptoJS.MD5(username + apiKey + customer_no).toString();
  const postData = { username: username, customer_no: customer_no, sign: sign };

  try {
    const response = await axios.post("https://api.digiflazz.com/v1/inquiry-pln", postData, {
      headers: { "Content-Type": "application/json" },
      timeout: 30000
    });

    if (response.data && response.data.data) {
      res.json({
        success: true,
        data: {
          message: response.data.data.message,
          status: response.data.data.status,
          rc: response.data.data.rc,
          customer_no: response.data.data.customer_no,
          meter_no: response.data.data.meter_no,
          subscriber_id: response.data.data.subscriber_id,
          name: response.data.data.name,
          segment_power: response.data.data.segment_power
        }
      });
    } else {
      res.json({ success: false, message: "Gagal mendapatkan informasi pelanggan" });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/history", async (req, res) => {
  try {
    const { username, limit = 50 } = req.body;
    if (!username) return res.status(400).json({ success: false, error: "Username required" });

    const prepaidRef = ref(database, `trxppobgaskuy/${username}`);
    const pascaRef = ref(database, `trxpascagaskuy/${username}`);

    const [prepaidSnap, pascaSnap] = await Promise.all([get(prepaidRef), get(pascaRef)]);
    let transactions = [];

    if (prepaidSnap.exists()) {
      const data = prepaidSnap.val();
      for (const [refId, item] of Object.entries(data)) {
        const trxData = item.data || {};
        transactions.push({
          product_name: trxData.product_name || trxData.buyer_sku_code || "-",
          customer_no: trxData.customer_no || "-",
          price_sell: trxData.price || trxData.selling_price || 0,
          status: trxData.status || "Unknown",
          created_at: item.date || new Date(item.timestamp).toISOString(),
          sn: trxData.sn || null,
          sku_code: trxData.buyer_sku_code || null,
          ref_id: refId,
          webhook_updated: trxData.webhook_updated || false,
          application: trxData.application || "mudico"
        });
      }
    }

    if (pascaSnap.exists()) {
      const data = pascaSnap.val();
      for (const [refId, item] of Object.entries(data)) {
        const trxData = item.data || {};
        transactions.push({
          product_name: trxData.product_name || trxData.buyer_sku_code || "-",
          customer_no: trxData.customer_no || "-",
          price_sell: trxData.price || trxData.selling_price || 0,
          status: trxData.status || "Unknown",
          created_at: item.date || new Date(item.timestamp).toISOString(),
          sn: trxData.sn || null,
          sku_code: trxData.buyer_sku_code || null,
          ref_id: refId,
          webhook_updated: trxData.webhook_updated || false,
          application: trxData.application || "mudico"
        });
      }
    }

    transactions.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    if (limit > 0) transactions = transactions.slice(0, limit);

    res.json({ success: true, data: transactions });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/refresh-products", async (req, res) => {
  const { secret } = req.body;
  if (secret !== REFRESH_SECRET) return res.status(403).json({ success: false, error: "Unauthorized" });
  try {
    const result = await refreshAllCache();
    res.json({ success: true, message: "Cache refreshed", prepaidCount: result.prepaidCount, pascaCount: result.pascaCount });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/cache-status", (req, res) => {
  const now = Date.now();
  res.json({
    application: "mudico",
    firebase_paths: "gaskuy (trxppobgaskuy, trxpascagaskuy, cache/pricelist, webhook_logs)",
    prepaid: {
      loaded: !!prepaidCache,
      productCount: prepaidCache?.data?.length || 0,
      lastUpdated: prepaidCacheTime ? new Date(prepaidCacheTime).toISOString() : null,
      ageMinutes: prepaidCacheTime ? Math.floor((now - prepaidCacheTime) / 60000) : null,
      isExpired: !prepaidCache || (now - prepaidCacheTime) > CACHE_TTL
    },
    pasca: {
      loaded: !!pascaCache,
      productCount: pascaCache?.data?.length || 0,
      lastUpdated: pascaCacheTime ? new Date(pascaCacheTime).toISOString() : null,
      ageMinutes: pascaCacheTime ? Math.floor((now - pascaCacheTime) / 60000) : null,
      isExpired: !pascaCache || (now - pascaCacheTime) > CACHE_TTL
    },
    cacheTTL_minutes: CACHE_TTL / 60000,
    serverTime: new Date().toISOString()
  });
});

app.post("/direct-prepaid", async (req, res) => {
  const url = "https://api.digiflazz.com/v1/price-list";
  const data = { cmd: "prepaid", username: username, sign: generatePriceListSignature() };
  try {
    const response = await axios.post(url, data, { headers: { "Content-Type": "application/json" }, timeout: 30000 });
    res.json({ success: true, source: "direct_from_digiflazz", totalProducts: response.data.data?.length || 0, products: response.data.data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ JALANKAN SERVER ============
app.listen(port, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║     🚀 MUDICO DIGIFLAZZ BACKEND STARTED 🚀                    ║
╠════════════════════════════════════════════════════════════════╣
║  Application: MUDICO                                          ║
║  Webhook ID: ${WEBHOOK_ID}                                      ║
║  Mode: WEBHOOK ONLY (No Polling)                              ║
║  Firebase Paths: GASKUY (trxppobgaskuy, trxpascagaskuy)       ║
║  Local:    http://localhost:${port}                            ║
║  Network:  http://192.168.x.x:${port}                         ║
╠════════════════════════════════════════════════════════════════╣
║  🔗 WEBHOOK ENDPOINTS:                                        ║
║  POST /webhook/digiflazz   - Main webhook dari Digiflazz      ║
║  POST /webhook/ping        - Test webhook ping                ║
║  GET  /webhook/logs        - View webhook logs                ║
║  GET  /webhook/stats       - Webhook statistics               ║
║  GET  /webhook/info        - Webhook information              ║
║  GET  /webhook/test-ping   - Test ping to Digiflazz           ║
╠════════════════════════════════════════════════════════════════╣
║  📦 TRANSACTION ENDPOINTS (Webhook Only - No Polling):        ║
║  POST /transaction         - Process prepaid (NO POLLING)     ║
║  POST /transactionpasca    - Process postpaid (NO POLLING)    ║
║  POST /inqpasca            - Inquiry postpaid                 ║
╠════════════════════════════════════════════════════════════════╣
║  📁 FIREBASE PATHS (Tetap GASKUY):                            ║
║  trxppobgaskuy/     - Prepaid transactions                   ║
║  trxpascagaskuy/    - Postpaid transactions                  ║
║  cache/pricelist/   - Product cache                          ║
║  webhook_logs/      - Webhook logs                           ║
║  users/             - User markup data                       ║
╠════════════════════════════════════════════════════════════════╣
║  ⚡ PERBEDAAN DENGAN SEBELUMNYA:                              ║
║  ❌ TIDAK ADA POLLING (tidak menunggu 100 detik)              ║
║  ✅ Response LANGSUNG ke user (< 5 detik)                     ║
║  ✅ Webhook akan update status REAL-TIME                      ║
║  ✅ Tidak ada risiko timeout                                   ║
║  ✅ Lebih efisien dan cepat                                    ║
║  ✅ Firebase path tetap GASKUY (compatible dengan data lama)  ║
║  ✅ Application label MUDICO untuk identifikasi               ║
╚════════════════════════════════════════════════════════════════╝
  `);
});