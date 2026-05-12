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
const apiKey = "dev-30da5240-2f12-11f1-b2cf-e36c2cd00ff2";

// Helper function untuk generate signature
function generateSignature(ref_id) {
  return CryptoJS.MD5(username + apiKey + ref_id).toString();
}

// ============ ENDPOINT UNTUK FRONTEND ============

// Endpoint untuk mendapatkan price list
app.post("/api/get_pricelist", async (req, res) => {
  const { brand, category, menu_type, is_agen } = req.body;

  try {
    const url = "https://api.digiflazz.com/v1/price-list";
    const data = {
      cmd: "prepaid",
      username: username,
      sign: generateSignature("price")
    };

    const response = await axios.post(url, data, {
      headers: { "Content-Type": "application/json" }
    });

    let products = [];

    if (response.data && response.data.data) {
      let filtered = response.data.data;

      // Filter berdasarkan brand
      if (brand && brand !== '') {
        filtered = filtered.filter(p => p.brand === brand);
      }

      // Filter berdasarkan kategori
      if (category === "Pulsa") {
        filtered = filtered.filter(p => p.category === "Pulsa");
      } else if (category === "Data") {
        filtered = filtered.filter(p => p.category === "Data");
      } else if (category === "Games") {
        filtered = filtered.filter(p => p.category === "Games");
      } else if (category === "TV") {
        filtered = filtered.filter(p => p.category === "TV");
      }

      // Proses data untuk frontend
      products = filtered.map(p => ({
        sku: p.buyer_sku_code,
        name: p.product_name,
        brand: p.brand,
        price_normal: p.price,
        price_sell: is_agen === '1' ? Math.floor(p.price * 0.95) : p.price,
        price_modal: p.price,
        desc: p.desc || "",
        is_fs: false
      }));

      // Batasi 20 produk
      products = products.slice(0, 20);
    }

    res.json({ status: "success", data: products });
  } catch (error) {
    console.error("Error get pricelist:", error);
    res.json({ status: "error", msg: "Gagal mengambil data produk" });
  }
});

// Endpoint untuk mendapatkan rekomendasi
app.post("/api/get_recommendations", async (req, res) => {
  try {
    const url = "https://api.digiflazz.com/v1/price-list";
    const data = {
      cmd: "prepaid",
      username: username,
      sign: generateSignature("rec")
    };

    const response = await axios.post(url, data, {
      headers: { "Content-Type": "application/json" }
    });

    let recommendations = [];
    if (response.data && response.data.data) {
      recommendations = response.data.data.slice(0, 6).map(p => ({
        sku: p.buyer_sku_code,
        name: p.product_name,
        brand: p.brand,
        price_modal: p.price,
        price_sell: p.price,
        is_fs: false
      }));
    }

    res.json({ status: "success", data: recommendations });
  } catch (error) {
    console.error("Error get recommendations:", error);
    res.json({ status: "error", data: [] });
  }
});

// Endpoint untuk mendapatkan opsi pasca bayar
app.post("/api/get_pasca_options", async (req, res) => {
  const { brand } = req.body;

  try {
    const url = "https://api.digiflazz.com/v1/price-list";
    const data = {
      cmd: "pasca",
      username: username,
      sign: generateSignature("pasca")
    };

    const response = await axios.post(url, data, {
      headers: { "Content-Type": "application/json" }
    });

    let options = [];
    if (response.data && response.data.data) {
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
    }

    res.json({ status: "success", data: options });
  } catch (error) {
    console.error("Error get pasca options:", error);
    res.json({ status: "error", data: [] });
  }
});

// Endpoint untuk cek tagihan pasca bayar
app.post("/api/cek_tagihan", async (req, res) => {
  const { sku, target_no, is_agen } = req.body;
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
      headers: { "Content-Type": "application/json" }
    });

    const result = response.data;

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
    console.error("Error cek tagihan:", error);
    res.json({ status: "error", msg: "Gagal terhubung ke server" });
  }
});

// Endpoint untuk cek PLN
app.post("/api/cek_pln", async (req, res) => {
  const { target_no } = req.body;

  // Simulasi cek PLN
  res.json({
    status: "success",
    name: "Pelanggan PLN - " + target_no
  });
});

// Fungsi untuk menambah/mengurangi saldo
async function updateUserBalance(username, amount) {
  try {
    const formdata = new FormData();
    formdata.append("amount", amount);
    formdata.append("username", username);

    const config = {
      method: "post",
      url: "https://linku.co.id/pulsa.php",
      headers: { ...formdata.getHeaders() },
      data: formdata
    };

    const response = await axios(config);
    return response.data;
  } catch (error) {
    console.error("Error update balance:", error);
    throw error;
  }
}

// Fungsi untuk menyimpan transaksi ke Firebase
async function saveTransaction(username, transactionId, transactionData) {
  try {
    const transactionRef = ref(database, `trxppobita/${username}/${transactionId}`);
    const dataToSave = {
      data: transactionData,
      timestamp: Date.now()
    };
    await set(transactionRef, dataToSave);
    console.log("Transaction saved to Firebase");
  } catch (error) {
    console.error("Error saving transaction:", error);
  }
}

// Fungsi polling status transaksi
async function pollTransactionStatus(postData, maxAttempts = 10, interval = 5000) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    console.log(`Polling attempt ${attempt + 1} for ref_id: ${postData.ref_id}`);

    try {
      const url = "https://api.digiflazz.com/v1/transaction";
      const sign = generateSignature(postData.ref_id);
      postData.sign = sign;

      const response = await axios.post(url, postData, {
        headers: { "Content-Type": "application/json" }
      });

      const result = response.data;

      if (result.data && result.data.status !== "Pending") {
        return result;
      }

      await new Promise(resolve => setTimeout(resolve, interval));
    } catch (error) {
      console.error(`Polling error at attempt ${attempt + 1}:`, error);
    }
  }

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
      headers: { "Content-Type": "application/json" }
    });

    let result = response.data;

    // Jika pending, lakukan polling
    if (result.data && result.data.status === "Pending") {
      result = await pollTransactionStatus(postData);
    }

    // Proses hasil transaksi
    const transactionStatus = result.data ? result.data.status : "Gagal";
    const isSuccess = transactionStatus === "Sukses";

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
        console.error("Error updating balance:", balanceError);
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
    console.error("Purchase error:", error);

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
      msg: "Terjadi kesalahan pada server"
    });
  }
});

// Endpoint untuk verifikasi agen
app.post("/api/verify_agen", async (req, res) => {
  const { pin } = req.body;

  // PIN agen default: 2244
  if (pin === "2244") {
    res.json({ status: "success", msg: "Mode agen diaktifkan" });
  } else {
    res.json({ status: "error", msg: "PIN salah" });
  }
});

// Endpoint untuk cek saldo (standalone)
app.post("/balance", async (req, res) => {
  const url = "https://api.digiflazz.com/v1/cek-saldo";
  const signature = crypto.createHash('md5').update(username + apiKey + "depo").digest('hex');

  const data = {
    cmd: "deposit",
    username: username,
    sign: signature
  };

  try {
    const response = await axios.post(url, data, {
      headers: { "Content-Type": "application/json" }
    });
    res.json(response.data);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Gagal memproses data" });
  }
});

// Endpoint POST request untuk prepaid
app.post("/post-request", async (req, res) => {
  const url = "https://api.digiflazz.com/v1/price-list";
  const data = {
    cmd: "prepaid",
    username: username,
    sign: "44c6cdbc374ec87f02093c4a68f0cc63"
  };

  try {
    const response = await axios.post(url, data, {
      headers: { "Content-Type": "application/json" }
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: "Tidak ada koneksi Internet" });
  }
});

// Endpoint POST request untuk pasca
app.post("/post-pasca", async (req, res) => {
  const url = "https://api.digiflazz.com/v1/price-list";
  const data = {
    cmd: "pasca",
    username: username,
    sign: "44c6cdbc374ec87f02093c4a68f0cc63"
  };

  try {
    const response = await axios.post(url, data, {
      headers: { "Content-Type": "application/json" }
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: "Tidak ada koneksi Internet" });
  }
});

// Endpoint transaksi reguler
app.post("/transaction", async (req, res) => {
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
      headers: { "Content-Type": "application/json" }
    });

    const result = response.data;

    if (result.data && result.data.status === "Pending") {
      const finalResult = await pollTransactionStatus(postData);
      res.json(finalResult);
    } else {
      res.json(result);
    }
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Endpoint inquiry pasca
let temporaryRefId = null;

app.post("/inqpasca", async (req, res) => {
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
      headers: { "Content-Type": "application/json" }
    });

    temporaryRefId = ref_id;
    res.status(200).json(response.data);
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Endpoint transaksi pasca
app.post("/transactionpasca", async (req, res) => {
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
      headers: { "Content-Type": "application/json" }
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

      // Update saldo
      if (result.data.selling_price) {
        await updateUserBalance(req.body.customer_name, -result.data.selling_price);
      }
    }

    res.json(result);
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Jalankan server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log(`Server juga tersedia di https://digi.mudico.co.id (melalui reverse proxy)`);
});