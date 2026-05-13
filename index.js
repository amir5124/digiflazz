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

// Endpoint untuk mendapatkan price list (berdasarkan dokumentasi resmi)
app.post("/api/get_pricelist", async (req, res) => {
  const { brand, category, menu_type, is_agen } = req.body;

  // Log request yang masuk
  console.log("📥 [get_pricelist] Request received:", { brand, category, menu_type, is_agen });

  try {
    const url = "https://api.digiflazz.com/v1/price-list";
    const sign = generatePriceListSignature();

    const payload = {
      cmd: "prepaid",
      username: username,
      sign: sign
    };

    // Tambahkan filter opsional jika diperlukan
    if (brand && brand !== "") payload.brand = brand;
    if (category && category !== "") payload.category = category;

    console.log("📤 [get_pricelist] Sending to Digiflazz:", JSON.stringify(payload, null, 2));

    const response = await axios.post(url, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 30000 // 30 detik timeout
    });

    // Debug logging
    console.log("✅ [get_pricelist] Response status:", response.status);
    console.log("📊 [get_pricelist] Response data type:", typeof response.data);
    console.log("📊 [get_pricelist] Response keys:", Object.keys(response.data || {}));
    console.log("📊 [get_pricelist] Is response.data an array?", Array.isArray(response.data));
    console.log("📊 [get_pricelist] Is response.data.data an array?", Array.isArray(response.data?.data));

    let products = [];

    // ✅ Pastikan response.data.data adalah array (sesuai dokumentasi)
    if (response.data && Array.isArray(response.data.data)) {
      console.log(`📊 [get_pricelist] Total products from API: ${response.data.data.length}`);

      let filtered = [...response.data.data];

      // Filter berdasarkan brand (jika ada dan tidak kosong)
      if (brand && brand !== "") {
        const beforeCount = filtered.length;
        filtered = filtered.filter(p => p.brand === brand);
        console.log(`🔍 [get_pricelist] Filter by brand '${brand}': ${beforeCount} -> ${filtered.length} products`);
      }

      // Filter berdasarkan kategori (jika diperlukan)
      if (category === "Pulsa") {
        const beforeCount = filtered.length;
        filtered = filtered.filter(p => p.category === "Pulsa");
        console.log(`🔍 [get_pricelist] Filter by category 'Pulsa': ${beforeCount} -> ${filtered.length} products`);
      } else if (category === "Data") {
        const beforeCount = filtered.length;
        filtered = filtered.filter(p => p.category === "Data");
        console.log(`🔍 [get_pricelist] Filter by category 'Data': ${beforeCount} -> ${filtered.length} products`);
      } else if (category === "Games") {
        const beforeCount = filtered.length;
        filtered = filtered.filter(p => p.category === "Games");
        console.log(`🔍 [get_pricelist] Filter by category 'Games': ${beforeCount} -> ${filtered.length} products`);
      } else if (category === "TV") {
        const beforeCount = filtered.length;
        filtered = filtered.filter(p => p.category === "TV");
        console.log(`🔍 [get_pricelist] Filter by category 'TV': ${beforeCount} -> ${filtered.length} products`);
      }

      // Batasi 20 produk dan mapping ke format frontend
      products = filtered.slice(0, 20).map(p => ({
        sku: p.buyer_sku_code,
        name: p.product_name,
        brand: p.brand,
        price_normal: p.price,
        price_sell: is_agen === '1' ? Math.floor(p.price * 0.95) : p.price,
        price_modal: p.price,
        desc: p.desc || "",
        is_fs: false,
        category: p.category,
        stock: p.stock,
        unlimited_stock: p.unlimited_stock
      }));

      console.log(`✅ [get_pricelist] Success: returning ${products.length} products`);
    } else {
      // Jika format respons tidak sesuai ekspektasi
      console.error("❌ [get_pricelist] Unexpected API response format:", JSON.stringify(response.data, null, 2));
      return res.json({
        status: "error",
        msg: "Produk tidak ditemukan"
      });
    }

    res.json({ status: "success", data: products });

  } catch (error) {
    console.error("❌ [get_pricelist] Error:", error.message);
    if (error.response) {
      console.error("📊 Response data:", error.response.data);
      console.error("📊 Response status:", error.response.status);
    }
    res.json({
      status: "error",
      msg: "Gagal mengambil data produk: " + error.message
    });
  }
});

// Endpoint untuk mendapatkan rekomendasi
app.post("/api/get_recommendations", async (req, res) => {
  console.log("📥 [get_recommendations] Request received");

  try {
    const url = "https://api.digiflazz.com/v1/price-list";
    const sign = generatePriceListSignature();

    const payload = {
      cmd: "prepaid",
      username: username,
      sign: sign
    };

    const response = await axios.post(url, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 30000
    });

    console.log(`📊 [get_recommendations] Response status: ${response.status}`);

    let recommendations = [];
    if (response.data && Array.isArray(response.data.data)) {
      recommendations = response.data.data.slice(0, 6).map(p => ({
        sku: p.buyer_sku_code,
        name: p.product_name,
        brand: p.brand,
        price_modal: p.price,
        price_sell: p.price,
        is_fs: false
      }));
      console.log(`✅ [get_recommendations] Returning ${recommendations.length} recommendations`);
    } else {
      console.warn("⚠️ [get_recommendations] Unexpected response format");
    }

    res.json({ status: "success", data: recommendations });
  } catch (error) {
    console.error("❌ [get_recommendations] Error:", error.message);
    res.json({ status: "error", data: [] });
  }
});

// Endpoint untuk mendapatkan opsi pasca bayar
app.post("/api/get_pasca_options", async (req, res) => {
  const { brand } = req.body;
  console.log(`📥 [get_pasca_options] Request for brand: ${brand}`);

  try {
    const url = "https://api.digiflazz.com/v1/price-list";
    const sign = generatePriceListSignature();

    const payload = {
      cmd: "pasca",
      username: username,
      sign: sign
    };

    const response = await axios.post(url, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 30000
    });

    console.log(`📊 [get_pasca_options] Response status: ${response.status}`);

    let options = [];
    if (response.data && Array.isArray(response.data.data)) {
      let filtered = response.data.data;

      if (brand === "PLNPOST") {
        filtered = filtered.filter(p => p.brand === "PLN");
      } else if (brand === "BPJS") {
        filtered = filtered.filter(p => p.brand === "BPJS Kesehatan" || p.brand === "BPJS Ketenagakerjaan");
      } else if (brand === "PDAM") {
        filtered = filtered.filter(p => p.brand === "PDAM");
      }

      options = filtered.map(p => ({
        sku: p.buyer_sku_code,
        name: p.product_name
      }));

      console.log(`✅ [get_pasca_options] Returning ${options.length} options`);
    }

    res.json({ status: "success", data: options });
  } catch (error) {
    console.error("❌ [get_pasca_options] Error:", error.message);
    res.json({ status: "error", data: [] });
  }
});

// Endpoint untuk cek tagihan pasca bayar
app.post("/api/cek_tagihan", async (req, res) => {
  const { sku, target_no, is_agen } = req.body;
  console.log(`📥 [cek_tagihan] SKU: ${sku}, Target: ${target_no}`);

  const ref_id = shortid.generate();
  const sign = generateSignature(ref_id);

  const postData = {
    commands: "inq-pasca",
    username: username,
    buyer_sku_code: sku,
    customer_no: target_no,
    ref_id: ref_id,
    sign: sign
  };

  try {
    const response = await axios.post("https://api.digiflazz.com/v1/transaction", postData, {
      headers: { "Content-Type": "application/json" },
      timeout: 30000
    });

    const result = response.data;
    console.log(`📊 [cek_tagihan] Response:`, JSON.stringify(result, null, 2));

    if (result.data && result.data.status === "Sukses") {
      res.json({
        status: "success",
        data: {
          customer_name: result.data.customer_name || "Pelanggan",
          total: result.data.tagihan || result.data.price || 0,
          modal: result.data.admin_cost || 0,
          ref_id: ref_id,
          secure_token: result.data.secure_token || ""
        }
      });
    } else {
      res.json({ status: "error", msg: result.message || "Gagal cek tagihan" });
    }
  } catch (error) {
    console.error("❌ [cek_tagihan] Error:", error.message);
    res.json({ status: "error", msg: "Gagal terhubung ke server" });
  }
});

// Endpoint untuk cek PLN
app.post("/api/cek_pln", async (req, res) => {
  const { target_no } = req.body;
  console.log(`📥 [cek_pln] Target: ${target_no}`);

  // Simulasi cek PLN
  res.json({
    status: "success",
    name: "Pelanggan PLN - " + target_no
  });
});

// Fungsi untuk menambah/mengurangi saldo
async function updateUserBalance(username, amount) {
  console.log(`💰 [updateBalance] User: ${username}, Amount: ${amount}`);

  try {
    const formdata = new FormData();
    formdata.append("amount", amount);
    formdata.append("username", username);

    const config = {
      method: "post",
      url: "https://linku.co.id/pulsa.php",
      headers: { ...formdata.getHeaders() },
      data: formdata,
      timeout: 30000
    };

    const response = await axios(config);
    console.log(`✅ [updateBalance] Success:`, response.data);
    return response.data;
  } catch (error) {
    console.error("❌ [updateBalance] Error:", error.message);
    throw error;
  }
}

// Fungsi untuk menyimpan transaksi ke Firebase
async function saveTransaction(username, transactionId, transactionData) {
  console.log(`💾 [saveTransaction] User: ${username}, ID: ${transactionId}`);

  try {
    const transactionRef = ref(database, `trxppobita/${username}/${transactionId}`);
    const dataToSave = {
      data: transactionData,
      timestamp: Date.now()
    };
    await set(transactionRef, dataToSave);
    console.log(`✅ [saveTransaction] Saved to Firebase`);
  } catch (error) {
    console.error("❌ [saveTransaction] Error:", error.message);
  }
}

// Fungsi polling status transaksi
async function pollTransactionStatus(postData, maxAttempts = 10, interval = 5000) {
  console.log(`🔄 [pollTransactionStatus] Starting polling for ref_id: ${postData.ref_id}`);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    console.log(`📊 Polling attempt ${attempt + 1} of ${maxAttempts}`);

    try {
      const url = "https://api.digiflazz.com/v1/transaction";
      const sign = generateSignature(postData.ref_id);
      postData.sign = sign;

      const response = await axios.post(url, postData, {
        headers: { "Content-Type": "application/json" },
        timeout: 30000
      });

      const result = response.data;

      if (result.data && result.data.status !== "Pending") {
        console.log(`✅ Polling completed with status: ${result.data.status}`);
        return result;
      }

      await new Promise(resolve => setTimeout(resolve, interval));
    } catch (error) {
      console.error(`❌ Polling error at attempt ${attempt + 1}:`, error.message);
    }
  }

  console.log(`⏰ Polling timeout for ref_id: ${postData.ref_id}`);
  return { data: { status: "Gagal", message: "Timeout" } };
}

// Endpoint untuk pembelian
app.post("/api/purchase", async (req, res) => {
  const {
    username: userName,
    sku,
    target_no,
    price_sell,
    price_modal,
    product_name,
    is_pasca,
    ref_id: existing_ref_id,
    secure_token,
    is_agen,
    current_local_saldo
  } = req.body;

  console.log(`📥 [purchase] User: ${userName}, SKU: ${sku}, Target: ${target_no}, Price: ${price_sell}`);

  const ref_id = existing_ref_id || shortid.generate();
  const sign = generateSignature(ref_id);

  let postData = {
    username: username,
    buyer_sku_code: sku,
    customer_no: target_no,
    ref_id: ref_id,
    sign: sign,
    customer_name: userName || "Customer"
  };

  if (is_pasca === "1") {
    postData.commands = "pay-pasca";
    if (secure_token) postData.secure_token = secure_token;
  }

  try {
    // Kirim transaksi ke Digiflazz
    const response = await axios.post("https://api.digiflazz.com/v1/transaction", postData, {
      headers: { "Content-Type": "application/json" },
      timeout: 30000
    });

    let result = response.data;
    console.log(`📊 [purchase] Initial response:`, result);

    // Jika pending, lakukan polling
    if (result.data && result.data.status === "Pending") {
      console.log(`⏳ Transaction pending, starting polling...`);
      result = await pollTransactionStatus(postData);
    }

    // Proses hasil transaksi
    const transactionStatus = result.data ? result.data.status : "Gagal";
    const isSuccess = transactionStatus === "Sukses";

    console.log(`📊 [purchase] Final status: ${transactionStatus}, Success: ${isSuccess}`);

    // Simpan ke Firebase
    const transactionData = {
      status: transactionStatus,
      product_name: product_name,
      target: target_no,
      price: price_sell,
      sn: result.data ? (result.data.sn || result.data.message || "-") : "-",
      ref_id: ref_id,
      message: result.message || result.data?.message || ""
    };

    await saveTransaction(userName, ref_id, transactionData);

    // Update saldo jika sukses
    if (isSuccess) {
      try {
        await updateUserBalance(userName, -price_sell);
      } catch (balanceError) {
        console.error("❌ Error updating balance:", balanceError);
      }
    }

    // Kirim response ke frontend
    res.json({
      status: isSuccess ? "success" : "error",
      trx_status: transactionStatus,
      msg: result.message || (isSuccess ? "Transaksi berhasil" : "Transaksi gagal"),
      data: transactionData
    });

  } catch (error) {
    console.error("❌ [purchase] Error:", error.message);

    // Simpan transaksi gagal
    const transactionData = {
      status: "Gagal",
      product_name: product_name,
      target: target_no,
      price: price_sell,
      sn: "-",
      ref_id: ref_id,
      message: error.message
    };

    await saveTransaction(userName, ref_id, transactionData);

    res.json({
      status: "error",
      trx_status: "Gagal",
      msg: "Terjadi kesalahan pada server: " + error.message
    });
  }
});

// Endpoint untuk verifikasi agen
app.post("/api/verify_agen", async (req, res) => {
  const { pin } = req.body;
  console.log(`📥 [verify_agen] PIN received`);

  // PIN agen default: 2244
  if (pin === "2244") {
    console.log(`✅ [verify_agen] PIN valid`);
    res.json({ status: "success", msg: "Mode agen diaktifkan" });
  } else {
    console.log(`❌ [verify_agen] PIN invalid`);
    res.json({ status: "error", msg: "PIN salah" });
  }
});

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

// Endpoint inquiry pasca
let temporaryRefId = null;

app.post("/inqpasca", async (req, res) => {
  console.log(`📥 [inqpasca] Request received`);

  const ref_id = shortid.generate();
  const sign = generateSignature(ref_id);

  const postData = {
    commands: "inq-pasca",
    username: username,
    buyer_sku_code: req.body.buyer_sku_code,
    customer_no: req.body.customer_no,
    ref_id: ref_id,
    sign: sign
  };

  try {
    const response = await axios.post("https://api.digiflazz.com/v1/transaction", postData, {
      headers: { "Content-Type": "application/json" },
      timeout: 30000
    });

    temporaryRefId = ref_id;
    console.log(`✅ [inqpasca] Success, ref_id: ${ref_id}`);
    res.status(200).json(response.data);
  } catch (error) {
    console.error("❌ [inqpasca] Error:", error.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Endpoint transaksi pasca
app.post("/transactionpasca", async (req, res) => {
  console.log(`📥 [transactionpasca] Request received`);

  const ref_id = temporaryRefId;
  const sign = generateSignature(ref_id);

  const postData = {
    commands: "pay-pasca",
    username: username,
    buyer_sku_code: req.body.buyer_sku_code,
    customer_no: req.body.customer_no,
    ref_id: ref_id,
    sign: sign,
    customer_name: req.body.customer_name
  };

  try {
    const response = await axios.post("https://api.digiflazz.com/v1/transaction", postData, {
      headers: { "Content-Type": "application/json" },
      timeout: 30000
    });

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

    res.json(result);
  } catch (error) {
    console.error("❌ [transactionpasca] Error:", error.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Endpoint debug untuk melihat response mentah dari Digiflazz
app.get("/api/debug/raw-pricelist", async (req, res) => {
  console.log(`📥 [debug] Raw pricelist request`);

  const sign = generatePriceListSignature();

  try {
    const response = await axios.post(
      "https://api.digiflazz.com/v1/price-list",
      {
        cmd: "prepaid",
        username: username,
        sign: sign
      },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 30000
      }
    );

    console.log(`✅ [debug] Raw pricelist success`);

    // Kirim respons mentah untuk dilihat strukturnya
    res.json({
      status: "debug",
      dataType: typeof response.data,
      isArray: Array.isArray(response.data),
      hasDataProperty: response.data && response.data.data !== undefined,
      isDataArray: response.data && Array.isArray(response.data.data),
      dataCount: response.data?.data?.length || 0,
      sampleData: response.data?.data?.slice(0, 3) || response.data,
      fullResponse: response.data // Hati-hati, ini bisa besar
    });
  } catch (error) {
    console.error("❌ [debug] Error:", error.message);
    res.status(500).json({ error: error.message });
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