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

// Helper function untuk generate signature pricelist
function generatePriceListSignature() {
  return CryptoJS.MD5(username + apiKey + "pricelist").toString();
}

// ============ FUNGSI POLLING TRANSACTION ============

// Fungsi untuk memeriksa status transaksi
async function checkTransactionStatus(postData) {
  const url = "https://api.digiflazz.com/v1/transaction";

  // Hitung signature berdasarkan kombinasi username, apiKey, dan ref_id
  const sign = generateSignature(postData.ref_id);
  postData.sign = sign;

  console.log(`📊 [checkStatus] Checking transaction for ref_id: ${postData.ref_id}`);
  console.log(`   Sign: ${sign}`);

  try {
    const response = await axios.post(url, postData, {
      headers: { "Content-Type": "application/json" },
      timeout: 30000
    });
    console.log(`   Response status: ${response.data.data?.status || 'Unknown'}`);
    return response.data;
  } catch (error) {
    if (error.response) {
      console.error("   API error response:", error.response.data);
      console.error("   API error status:", error.response.status);
    }
    console.error("   Error checking transaction status:", error.message);
    throw new Error("Failed to check transaction status");
  }
}

// Fungsi untuk melakukan polling status transaksi
async function pollTransactionStatus(postData, maxAttempts = 10, interval = 5000) {
  console.log(`🔄 [pollTransaction] Starting polling for ref_id: ${postData.ref_id}`);
  console.log(`   Max attempts: ${maxAttempts}, Interval: ${interval}ms`);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    console.log(`   Polling attempt ${attempt + 1}/${maxAttempts}`);

    try {
      const responseData = await checkTransactionStatus(postData);

      // Tambahkan product_name ke responseData jika tidak ada
      if (!responseData.product_name && postData.product_name) {
        responseData.product_name = postData.product_name;
      }

      const status = responseData.data?.status;

      if (status === "Sukses") {
        console.log(`✅ [pollTransaction] Transaction successful for ref_id: ${postData.ref_id}`);

        // Simpan ke database
        await saveTransactionToDatabase(postData, responseData);

        // Update balance jika ada
        if (responseData.data?.selling_price) {
          await updateUserBalance(postData.customer_name, -responseData.data.selling_price);
        }

        return responseData;
      }

      if (status === "Gagal") {
        console.log(`❌ [pollTransaction] Transaction failed for ref_id: ${postData.ref_id}`);

        // Simpan ke database
        await saveTransactionToDatabase(postData, responseData);

        return responseData;
      }

      console.log(`   Transaction still pending (${status || 'Unknown'})... waiting ${interval}ms`);
      await new Promise((resolve) => setTimeout(resolve, interval));
    } catch (error) {
      console.error(`   Polling error at attempt ${attempt + 1}:`, error.message);
    }
  }

  console.log(`⏰ [pollTransaction] Timeout for ref_id: ${postData.ref_id}`);
  throw new Error("Transaction status check timed out");
}

// ============ FUNGSI SIMPAN KE DATABASE ============

// Fungsi untuk menyimpan hasil transaksi prepaid ke database
async function saveTransactionToDatabase(postData, result) {
  try {
    const customerName = postData.customer_name || postData.customerName || 'unknown';
    const refId = postData.ref_id;
    const transactionType = postData.commands === "pay-pasca" ? "trxpascagaskuy" : "trxppobgaskuy";

    // Tentukan path berdasarkan tipe transaksi
    let path;
    if (postData.commands === "pay-pasca" || postData.commands === "inq-pasca") {
      path = `${transactionType}/${customerName}/${refId}`;
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
        ref_id: refId
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

// Fungsi untuk menyimpan hasil transaksi pasca ke database
async function savePascaTransactionToDatabase(customerName, refId, result, productName) {
  try {
    const transactionRef = ref(database, `trxpascagaskuy/${customerName}/${refId}`);
    const transactionData = {
      data: {
        ...result.data,
        product_name: productName
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

// Fungsi update balance
async function updateUserBalance(username, amount) {
  try {
    const formdata = new FormData();
    formdata.append("amount", amount);
    formdata.append("username", username);

    const config = {
      method: "post",
      url: "https://gaskuy.my.id/pulsa.php",
      headers: {
        ...formdata.getHeaders(),
      },
      data: formdata,
    };

    const response = await axios(config);
    console.log(`💰 [updateBalance] Updated balance for ${username}: ${amount}`);
    console.log(`   Response:`, response.data);
    return response.data;
  } catch (error) {
    console.error(`❌ [updateBalance] Error:`, error.message);
    throw error;
  }
}

// ============ ENDPOINTS ============

// Endpoint untuk cek saldo
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

// Endpoint untuk product list prepaid
app.post("/post-request", async (req, res) => {
  console.log(`📥 [post-request] Request received`);

  const url = "https://api.digiflazz.com/v1/price-list";
  const data = {
    cmd: "prepaid",
    username: username,
    sign: generatePriceListSignature()
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

// Endpoint untuk product list pasca
app.post("/post-pasca", async (req, res) => {
  console.log(`📥 [post-pasca] Request received`);

  const url = "https://api.digiflazz.com/v1/price-list";
  const data = {
    cmd: "pasca",
    username: username,
    sign: generatePriceListSignature()
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

// Endpoint transaksi prepaid
app.post("/transaction", async (req, res) => {
  console.log(`📥 [transaction] Request received`);
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

    if (responseData.data && responseData.data.status === "Pending") {
      try {
        const finalResponseData = await pollTransactionStatus(postData);
        res.json(finalResponseData);
      } catch (pollingError) {
        console.error("   Polling error:", pollingError);
        res.status(500).json({ error: "Failed to retrieve final transaction status" });
      }
    } else if (responseData.data && responseData.data.status === "Sukses") {
      // Simpan ke database untuk transaksi sukses langsung
      await saveTransactionToDatabase(postData, responseData);

      // Update balance
      if (responseData.data.selling_price) {
        await updateUserBalance(req.body.customer_name, -responseData.data.selling_price);
      }

      res.json(responseData);
    } else {
      res.json(responseData);
    }
  } catch (error) {
    console.error("❌ [transaction] Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Temporary storage untuk ref_id
let temporaryRefId = null;
let temporaryData = {};

// Endpoint inquiry pasca
app.post("/inqpasca", async (req, res) => {
  console.log(`📥 [inqpasca] Request received`);
  console.log(`   Body:`, req.body);

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

  // Tambahkan amount untuk E-Money
  if (req.body.amount && parseInt(req.body.amount) > 0) {
    postData.amount = parseInt(req.body.amount);
    console.log(`   💰 Amount detected: ${postData.amount}`);
  }

  try {
    const response = await axios.post("https://api.digiflazz.com/v1/transaction", postData, {
      headers: { "Content-Type": "application/json" },
      timeout: 30000
    });

    console.log(`   Response status: ${response.data.data?.status}`);

    // Simpan data untuk digunakan di transactionpasca
    temporaryRefId = ref_id;
    temporaryData[ref_id] = {
      buyer_sku_code: req.body.buyer_sku_code,
      customer_no: req.body.customer_no,
      customer_name: req.body.customer_name,
      amount: req.body.amount || null
    };

    res.status(200).json(response.data);
  } catch (error) {
    console.error("❌ [inqpasca] Error:", error.message);
    if (error.response) {
      res.status(error.response.status).json(error.response.data);
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// Endpoint transaksi pasca
app.post("/transactionpasca", async (req, res) => {
  console.log(`📥 [transactionpasca] Request received`);
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

  // Tambahkan amount jika ada
  if (temporaryData[ref_id] && temporaryData[ref_id].amount) {
    postData.amount = temporaryData[ref_id].amount;
    console.log(`   💰 Using amount from temporaryData: ${postData.amount}`);
  }

  if (req.body.amount && parseInt(req.body.amount) > 0) {
    postData.amount = parseInt(req.body.amount);
    console.log(`   💰 Amount from request body: ${postData.amount}`);
  }

  console.log(`   Customer: ${postData.customer_name}`);
  console.log(`   Ref ID: ${ref_id}`);

  try {
    const responseData = await checkTransactionStatus(postData);
    console.log(`   Initial status: ${responseData.data?.status}`);

    if (responseData.data && responseData.data.status === "Pending") {
      try {
        const finalResponseData = await pollTransactionStatus(postData);
        res.json(finalResponseData);
      } catch (pollingError) {
        console.error("   Polling error:", pollingError);
        res.status(500).json({ error: "Failed to retrieve final transaction status" });
      }
    } else if (responseData.data && responseData.data.status === "Sukses") {
      // Simpan ke database
      await savePascaTransactionToDatabase(
        req.body.customer_name,
        ref_id,
        responseData,
        req.body.buyer_sku_code
      );

      // Update balance
      if (responseData.data.selling_price) {
        await updateUserBalance(req.body.customer_name, -responseData.data.selling_price);
      }

      res.json(responseData);
    } else {
      res.json(responseData);
    }
  } catch (error) {
    console.error("❌ [transactionpasca] Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  } finally {
    // Cleanup temporary data
    if (ref_id) {
      delete temporaryData[ref_id];
    }
    temporaryRefId = null;
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
    console.error("❌ [get-markup] Error:", error);
    res.json({ success: false, admin_fee: 500, markup: 0 });
  }
});

// Endpoint untuk Inquiry PLN (cek validasi ID pelanggan)
app.post("/inquiry-pln", async (req, res) => {
  console.log(`📥 [inquiry-pln] Request received`);
  console.log(`   Body:`, req.body);

  const { customer_no } = req.body;

  if (!customer_no) {
    return res.status(400).json({ error: "customer_no wajib diisi" });
  }

  // Generate signature: md5(username + apiKey + customer_no)
  const sign = CryptoJS.MD5(username + apiKey + customer_no).toString();

  const postData = {
    username: username,
    customer_no: customer_no,
    sign: sign
  };

  try {
    const response = await axios.post("https://api.digiflazz.com/v1/inquiry-pln", postData, {
      headers: { "Content-Type": "application/json" },
      timeout: 30000
    });

    console.log(`   Response:`, response.data);

    if (response.data && response.data.data) {
      // Format response agar lebih mudah digunakan frontend
      const result = {
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
      };
      res.json(result);
    } else {
      res.json({ success: false, message: "Gagal mendapatkan informasi pelanggan" });
    }
  } catch (error) {
    console.error("❌ [inquiry-pln] Error:", error.message);
    if (error.response) {
      res.status(error.response.status).json({
        success: false,
        error: error.response.data,
        message: error.response.data?.data?.message || "ID Pelanggan tidak valid"
      });
    } else {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

// Jalankan server
app.listen(port, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║     🚀 DIGIFLAZZ BACKEND SERVER STARTED 🚀                    ║
╠════════════════════════════════════════════════════════════════╣
║  Local:    http://localhost:${port}                            ║
║  Network:  http://192.168.x.x:${port}                         ║
╠════════════════════════════════════════════════════════════════╣
║  Endpoints:                                                   ║
║  POST /balance          - Check balance                       ║
║  POST /post-request     - Get prepaid product list           ║
║  POST /post-pasca       - Get postpaid product list          ║
║  POST /transaction      - Process prepaid transaction        ║
║  POST /inqpasca         - Inquiry postpaid                   ║
║  POST /transactionpasca - Process postpaid transaction       ║
║  POST /get-markup       - Get user markup                    ║
╠════════════════════════════════════════════════════════════════╣
║  Features:                                                    ║
║  ✅ Auto polling for pending transactions                     ║
║  ✅ Automatic balance update                                  ║
║  ✅ Firebase database storage                                 ║
║  ✅ Support E-Money topup                                     ║
╚════════════════════════════════════════════════════════════════╝
  `);
});