const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const app = express();
const cors = require("cors");
const CryptoJS = require("crypto-js");
const shortid = require("shortid");
const FormData = require("form-data");
const crypto = require('crypto');
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

// Firebase Config
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

// Konfigurasi Digiflazz
const username = "wifisagdYxlo";
const apiKey = "a6e502cc-5d45-5daa-a375-c4e68be9ff98";

// Helper function untuk generate signature
function generateSignature(ref_id) {
  return CryptoJS.MD5(username + apiKey + ref_id).toString();
}

// Helper function untuk generate signature pricelist (md5(username + apiKey + "pricelist"))
function generatePriceListSignature() {
  return CryptoJS.MD5(username + apiKey + "pricelist").toString();
}

// ============ ENDPOINT UNTUK FRONTEND ============


// Endpoint untuk cek saldo (standalone)
app.post("/balance", async (req, res) => {
  console.log(`📥 [balance] Request received`);

  const url = "https://api.digiflazz.com/v1/cek-saldo";
  const signature = crypto.createHash('md5').update(username + apiKey + "depo").digest('hex');

  const data = {
    cmd: "deposit",
    username: username,
    sign: signature
  };

  try {
    const response = await axios.post(url, data, {
      headers: { "Content-Type": "application/json" },
      timeout: 30000
    });
    console.log(`✅ [balance] Success`);
    res.json(response.data);
  } catch (error) {
    console.error("❌ [balance] Error:", error.message);
    res.status(500).json({ error: "Gagal memproses data" });
  }
});

// Endpoint POST request untuk prepaid
app.post("/post-request", async (req, res) => {
  console.log(`📥 [post-request] Request received`);

  const url = "https://api.digiflazz.com/v1/price-list";
  const data = {
    cmd: "prepaid",
    username: username,
    sign: "44c6cdbc374ec87f02093c4a68f0cc63"
  };

  try {
    const response = await axios.post(url, data, {
      headers: { "Content-Type": "application/json" },
      timeout: 30000
    });
    console.log(`✅ [post-request] Success`);
    res.json(response.data);
  } catch (error) {
    console.error("❌ [post-request] Error:", error.message);
    res.status(500).json({ error: "Tidak ada koneksi Internet" });
  }
});

// Endpoint POST request untuk pasca
app.post("/post-pasca", async (req, res) => {
  console.log(`📥 [post-pasca] Request received`);

  const url = "https://api.digiflazz.com/v1/price-list";
  const data = {
    cmd: "pasca",
    username: username,
    sign: "44c6cdbc374ec87f02093c4a68f0cc63"
  };

  try {
    const response = await axios.post(url, data, {
      headers: { "Content-Type": "application/json" },
      timeout: 30000
    });
    console.log(`✅ [post-pasca] Success`);
    res.json(response.data);
  } catch (error) {
    console.error("❌ [post-pasca] Error:", error.message);
    res.status(500).json({ error: "Tidak ada koneksi Internet" });
  }
});

// Endpoint transaksi reguler
app.post("/transaction", async (req, res) => {
  console.log(`📥 [transaction] Request received`);

  const ref_id = shortid.generate();
  const sign = generateSignature(ref_id);

  const postData = {
    username: username,
    buyer_sku_code: req.body.buyer_sku_code,
    customer_no: req.body.customer_no,
    ref_id: ref_id,
    sign: sign,
    customer_name: req.body.customer_name,
    product_name: req.body.product_name
  };

  try {
    const url = "https://api.digiflazz.com/v1/transaction";
    const response = await axios.post(url, postData, {
      headers: { "Content-Type": "application/json" },
      timeout: 30000
    });

    const result = response.data;

    if (result.data && result.data.status === "Pending") {
      const finalResult = await pollTransactionStatus(postData);
      res.json(finalResult);
    } else {
      res.json(result);
    }
  } catch (error) {
    console.error("❌ [transaction] Error:", error.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Endpoint inquiry pasca (support E-Money)
let temporaryData = {}; // Simpan data per ref_id

app.post("/inqpasca", async (req, res) => {
  console.log(`📥 [inqpasca] Request received`);
  console.log(`   Body:`, req.body);

  const ref_id = shortid.generate();
  const sign = generateSignature(ref_id);

  // Data dasar untuk request ke Digiflazz
  let postData = {
    commands: "inq-pasca",
    username: username,
    buyer_sku_code: req.body.buyer_sku_code,
    customer_no: req.body.customer_no,
    ref_id: ref_id,
    sign: sign
  };

  console.log(`📦 [inqpasca] Response data:`, JSON.stringify(postData, null, 2));
  // ============ TAMBAHAN UNTUK E-MONEY ============
  // Jika ada parameter amount (untuk topup E-Money)
  if (req.body.amount && parseInt(req.body.amount) > 0) {
    postData.amount = parseInt(req.body.amount);
    console.log(`   💰 Amount detected: ${postData.amount}`);
  }

  // Untuk produk Cek Nama Pengguna (danacek, cekovo, dll)
  // Tidak perlu amount, cukup seperti biasa

  try {
    const response = await axios.post("https://api.digiflazz.com/v1/transaction", postData, {
      headers: { "Content-Type": "application/json" },
      timeout: 30000
    });

    console.log(`📦 [inqpasca] Response:`, JSON.stringify(response.data, null, 2));

    // Simpan data untuk digunakan di transactionpasca
    temporaryData[ref_id] = {
      buyer_sku_code: req.body.buyer_sku_code,
      customer_no: req.body.customer_no,
      customer_name: req.body.customer_name,
      amount: req.body.amount || null
    };

    console.log(`✅ [inqpasca] Success, ref_id: ${ref_id}`);
    res.status(200).json(response.data);
  } catch (error) {
    console.error("❌ [inqpasca] Error:", error.message);

    // Tampilkan detail error dari Digiflazz jika ada
    if (error.response) {
      console.error("   Response status:", error.response.status);
      console.error("   Response data:", JSON.stringify(error.response.data, null, 2));
      res.status(error.response.status).json(error.response.data);
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// Endpoint transaksi pasca (support E-Money)
app.post("/transactionpasca", async (req, res) => {
  console.log(`📥 [transactionpasca] Request received`);
  console.log(`   Body:`, req.body);

  // Cari ref_id dari temporary storage
  // Untuk E-Money, kita perlu generate ref_id baru karena amount bisa berbeda
  let ref_id = req.body.ref_id || temporaryRefId;

  // Jika tidak ada ref_id yang tersimpan, generate baru
  if (!ref_id) {
    ref_id = shortid.generate();
    console.log(`   ⚠️ No ref_id found, generating new: ${ref_id}`);
  }

  const sign = generateSignature(ref_id);

  // Data dasar untuk request ke Digiflazz
  let postData = {
    commands: "pay-pasca",
    username: username,
    buyer_sku_code: req.body.buyer_sku_code,
    customer_no: req.body.customer_no,
    ref_id: ref_id,
    sign: sign,
    customer_name: req.body.customer_name
  };

  // ============ TAMBAHAN UNTUK E-MONEY ============
  // Cek apakah ada amount dari temporaryData
  if (temporaryData[ref_id] && temporaryData[ref_id].amount) {
    postData.amount = temporaryData[ref_id].amount;
    console.log(`   💰 Using amount from temporaryData: ${postData.amount}`);
  }

  // Atau jika amount dikirim langsung dalam request body
  if (req.body.amount && parseInt(req.body.amount) > 0) {
    postData.amount = parseInt(req.body.amount);
    console.log(`   💰 Amount from request body: ${postData.amount}`);
  }

  try {
    const response = await axios.post("https://api.digiflazz.com/v1/transaction", postData, {
      headers: { "Content-Type": "application/json" },
      timeout: 30000
    });

    console.log(`📦 [transactionpasca] Response:`, JSON.stringify(response.data, null, 2));

    let result = response.data;

    if (result.data && result.data.status === "Pending") {
      result = await pollTransactionStatus(postData);
    }

    // Simpan ke Firebase jika sukses
    if (result.data && result.data.status === "Sukses") {
      const transactionRef = ref(database, `trxpascaita/${req.body.customer_name}/${ref_id}`);
      const transactionData = {
        data: {
          ...result.data,
          product_name: req.body.buyer_sku_code
        },
        timestamp: Date.now()
      };
      await set(transactionRef, transactionData);
      console.log(`✅ [transactionpasca] Saved to Firebase`);

      // Update saldo
      if (result.data.selling_price) {
        await updateUserBalance(req.body.customer_name, -result.data.selling_price);
      }
    }

    // Cleanup temporary data
    delete temporaryData[ref_id];
    if (ref_id === temporaryRefId) temporaryRefId = null;

    res.json(result);
  } catch (error) {
    console.error("❌ [transactionpasca] Error:", error.message);

    // Tampilkan detail error dari Digiflazz jika ada
    if (error.response) {
      console.error("   Response status:", error.response.status);
      console.error("   Response data:", JSON.stringify(error.response.data, null, 2));
      res.status(error.response.status).json(error.response.data);
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});


// Endpoint untuk mengambil markup dari Firebase
app.post("/get-markup", async (req, res) => {
  try {
    const { username } = req.body;
    const markupRef = ref(database, `users/${username}/markup`);
    const snapshot = await get(markupRef);

    let markupData = { admin_fee: 500, markup: 0 };
    if (snapshot.exists()) {
      markupData = snapshot.val();
    }

    res.json({ success: true, ...markupData });
  } catch (error) {
    res.json({ success: false, admin_fee: 500, markup: 0 });
  }
});

// Jalankan server
app.listen(port, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║     🚀 DIGIFLAZZ BACKEND SERVER STARTED 🚀          ║
╠══════════════════════════════════════════════════════╣
║  Local:    http://localhost:${port}                   ║
║  Network:  http://192.168.x.x:${port}                ║
║  Production: https://digi.mudico.co.id              ║
╠══════════════════════════════════════════════════════╣
║  Endpoints:                                          ║
║  POST /api/get_pricelist     - Get product list     ║
║  POST /api/purchase          - Process transaction  ║
║  POST /api/cek_tagihan       - Check bill           ║
║  GET  /api/debug/raw-pricelist - Debug API          ║
╚══════════════════════════════════════════════════════╝
  `);
});