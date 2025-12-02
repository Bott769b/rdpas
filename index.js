const express = require("express");
const mongoose = require("mongoose");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const { URLSearchParams } = require("url");
const path = require('path');
const http = require('http'); 
const { Server } = require("socket.io"); 
require("dotenv").config();

// ========== KONFIGURASI ==========
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const PORT = process.env.PORT || 3000; // Port server
const CHANNEL_ID = process.env.CHANNEL_ID; 
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())) : [];

// Config JagoPay (Wajib ada di .env)
const JAGOPAY_API_KEY = process.env.JAGOPAY_API_KEY;
const JAGOPAY_MERCHANT_ID = process.env.JAGOPAY_MERCHANT_ID;

// Config Logs Heroku (Opsional)
const HEROKU_API_TOKEN = process.env.HEROKU_API_TOKEN;
const HEROKU_APP_NAME = process.env.HEROKU_APP_NAME;

// Validasi ENV Penting
if (!BOT_TOKEN || !MONGO_URI) {
    console.error("❌ ERROR: Pastikan BOT_TOKEN dan MONGO_URI diisi di file .env");
    process.exit(1);
}

// ========== SETUP SERVER ==========
const app = express();
const server = http.createServer(app); 
const io = new Server(server); 

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'))); // Menyajikan folder dashboard

// ========== DATABASE ==========
// Import Models (Pastikan folder models sudah ada)
const User = require('./models/User');
const Product = require('./models/Product');
const Transaction = require('./models/Transaction');
const Setting = require('./models/Setting'); 

// Koneksi MongoDB
mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ [SERVER] Database Terhubung"))
    .catch(err => console.error("❌ Database Error:", err));

// ========== FUNGSI BANTUAN (HELPER) ==========

// Format Uptime Server
function formatUptime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h}h ${m}m ${s}s`;
}

// Kirim Pesan ke User Telegram (via HTTP API agar ringan)
async function sendTelegramMessage(userId, msg) {
    if (!BOT_TOKEN) return;
    try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: "POST",
            body: new URLSearchParams({ chat_id: userId, text: msg, parse_mode: "Markdown" })
        });
    } catch (e) { console.log("[TG Error]:", e.message); }
}

// Kirim Stiker ke User
async function sendTelegramSticker(userId, stickerId) {
    if (!BOT_TOKEN || !stickerId) return;
    try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendSticker`, {
            method: "POST",
            body: new URLSearchParams({ chat_id: userId, sticker: stickerId })
        });
    } catch (e) {}
}

// Kirim Notifikasi ke Channel/Grup
async function sendChannelNotification(message) {
    if (!CHANNEL_ID) return;
    try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: "POST",
            body: new URLSearchParams({ chat_id: CHANNEL_ID, text: message, parse_mode: "Markdown" })
        });
    } catch (e) { console.log("Channel Error:", e.message); }
}

// Proses Pengiriman Produk saat Pembayaran Sukses
async function deliverProductAndNotify(userId, productId, transaction, product) {
    try {
        const productData = await Product.findById(productId);
        
        // 1. Cek Stok
        if (!productData || productData.kontenProduk.length === 0) {
            if (ADMIN_IDS.length > 0) {
                sendTelegramMessage(ADMIN_IDS[0], `⚠️ [ADMIN] Stok Habis! User ${userId} beli ${productData?.namaProduk}. Ref: ${transaction.refId}`);
            }
            return sendTelegramMessage(userId, `⚠️ Pembayaran Berhasil (Ref: \`${transaction.refId}\`), namun stok konten habis. Harap hubungi Admin.`);
        }

        // 2. Ambil Konten (FIFO - First In First Out)
        const deliveredContent = productData.kontenProduk.shift();
        
        // 3. Update Database Produk
        await Product.updateOne({ _id: productId }, {
            $set: { kontenProduk: productData.kontenProduk },
            $inc: { stok: -1, totalTerjual: 1 }
        });
        
        const stokAkhir = productData.kontenProduk.length;

        // 4. Notifikasi ke Channel
        const notifMessage = `🎉 **PENJUALAN BARU (JAGOPAY)** 🎉\n\n` +
                           `👤 **Pembeli:** [${transaction.userId}](tg://user?id=${transaction.userId})\n` +
                           `🛍️ **Produk:** \`${product.namaProduk}\`\n` +
                           `💰 **Total:** \`Rp ${product.harga.toLocaleString('id-ID')}\`\n` +
                           `📦 **Sisa Stok:** \`${stokAkhir}\` pcs\n` +
                           `🆔 **Ref ID:** \`${transaction.refId}\``;
        await sendChannelNotification(notifMessage);

        // 5. Kirim Stiker Sukses
        const stickerSetting = await Setting.findOne({ key: 'success_sticker_id' });
        if (stickerSetting && stickerSetting.value) {
            await sendTelegramSticker(userId, stickerSetting.value);
        }

        // 6. Kirim Produk ke User
        const date = new Date();
        const dateCreated = `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()} ${date.getHours()}:${date.getMinutes()}`;
        
        let successMessage = `✅ *PEMBAYARAN DITERIMA*\n\n`;
        successMessage += `📦 Produk: ${product.namaProduk}\n`;
        successMessage += `💰 Total: Rp ${transaction.totalBayar.toLocaleString('id-ID')}\n`;
        successMessage += `📅 Tanggal: ${dateCreated}\n`;
        successMessage += `🆔 Ref: \`${transaction.refId}\`\n\n`;
        successMessage += `*Data Produk:*\n\`\`\`\n${deliveredContent}\n\`\`\``;
        
        sendTelegramMessage(userId, successMessage);

    } catch (err) {
        console.log("[Delivery Error]:", err);
        sendTelegramMessage(userId, `❌ Terjadi kesalahan pengiriman produk (Ref: \`${transaction.refId}\`). Hubungi Admin.`);
    }
}

// ========== ROUTE: CALLBACK JAGOPAY ==========
// URL ini yang dimasukkan ke dashboard JagoPay atau parameter request bot
app.post('/jagopay-callback', async (req, res) => {
    try {
        const data = req.body;
        console.log("📥 [JAGOPAY CALLBACK]", JSON.stringify(data));

        // Parameter JagoPay (Sesuaikan jika dokumentasi berbeda)
        // Biasanya: reference, merchant_ref, status, amount
        const refId = data.reference || data.merchant_ref; 
        const status = data.status; 

        if (!refId) return res.status(400).json({ success: false, message: "No Ref ID" });

        const trx = await Transaction.findOne({ refId });
        if (!trx) return res.status(404).json({ success: false, message: 'Transaksi Tidak Ditemukan' });
        
        // Cek Idempotency (Jangan proses double)
        if (trx.status === 'SUCCESS') return res.json({ success: true, message: 'Already Paid' });

        // LOGIKA STATUS SUKSES (Paid / Success / 1)
        if (status === 'Paid' || status === 'Success' || status === 1 || status === true) {
            trx.status = 'SUCCESS';
            await trx.save();

            const user = await User.findOne({ userId: trx.userId });
            if (!user) return res.status(404).json({ success: false, message: 'User Hilang' });

            // A. JIKA TIPE TOPUP
            if (trx.produkInfo.type === 'TOPUP') {
                user.saldo += trx.totalBayar;
                user.totalTransaksi += 1;
                await user.save();

                // Notif User
                sendTelegramMessage(trx.userId, `✅ *Deposit Berhasil*\n💰 Nominal: Rp ${trx.totalBayar.toLocaleString('id-ID')}\n💳 Saldo Akhir: Rp ${user.saldo.toLocaleString('id-ID')}`);
                
                // Notif Channel
                const notifMessage = `💰 **DEPOSIT SUKSES (JAGOPAY)** 💰\n👤 **User:** [${user.username}](tg://user?id=${trx.userId})\n💰 **Total:** \`Rp ${trx.totalBayar.toLocaleString('id-ID')}\``;
                await sendChannelNotification(notifMessage);
            
            // B. JIKA BELI PRODUK LANGSUNG
            } else {
                let prodId = trx.produkInfo.productId;
                
                // Fallback untuk data lama yang tidak punya productId
                if (!prodId) {
                    const p = await Product.findOne({ namaProduk: trx.produkInfo.namaProduk });
                    if(p) prodId = p._id;
                }

                if(prodId) {
                    const product = await Product.findById(prodId);
                    if (product) {
                        await deliverProductAndNotify(trx.userId, prodId, trx, product);
                    } else {
                        sendTelegramMessage(trx.userId, `⚠️ Produk tidak ditemukan di database (Ref: ${refId}).`);
                    }
                } else {
                    sendTelegramMessage(trx.userId, `⚠️ Data produk tidak valid (Ref: ${refId}).`);
                }
            }
            return res.json({ success: true });

        } 
        // LOGIKA STATUS GAGAL
        else if (status === 'Expired' || status === 'Failed') {
            trx.status = status.toUpperCase();
            await trx.save();
            return res.json({ success: true });
        }

        // Default return
        res.json({ success: true });

    } catch (err) {
        console.error(`[Callback Error] ${err.message}`);
        res.status(500).json({ success: false });
    }
});

// ========== ROUTE: DASHBOARD ADMIN API ==========

// 1. Serve Halaman Dashboard
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 2. API Data Statistik
app.get('/api/stats', async (req, res) => {
    try {
        const [users, products, allTrx, successTrx, pendingTrx] = await Promise.all([
            User.countDocuments(),
            Product.countDocuments(),
            Transaction.countDocuments(),
            Transaction.countDocuments({ status: 'SUCCESS' }),
            Transaction.countDocuments({ status: 'PENDING' })
        ]);
        res.json({
            dbStatus: mongoose.connection.readyState === 1 ? 'CONNECTED' : 'DISCONNECTED',
            serverUptime: formatUptime(process.uptime()),
            totalUsers: users,
            totalProducts: products,
            totalTransactions: allTrx,
            successTransactions: successTrx,
            pendingTransactions: pendingTrx
        });
    } catch (e) { 
        res.status(500).json({ error: "Gagal memuat statistik" }); 
    }
});

// 3. API Produk (CRUD)
// Get All
app.get('/api/products', async (req, res) => {
    const products = await Product.find({}).sort({ kategori: 1 });
    res.json(products);
});

// Add New
app.post('/api/products', async (req, res) => {
    try {
        const data = req.body;
        if(!data.stok) data.stok = 0;
        if(typeof data.kontenProduk === 'string') data.kontenProduk = [];
        
        await new Product(data).save();
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Update
app.put('/api/products/:id', async (req, res) => {
    try {
        await Product.findByIdAndUpdate(req.params.id, req.body);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Delete
app.delete('/api/products/:id', async (req, res) => {
    try {
        await Product.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Add Stock
app.post('/api/products/:id/stock', async (req, res) => {
    try {
        const { newStock } = req.body;
        const stockArray = Array.isArray(newStock) ? newStock : newStock.split('\n').filter(s => s.trim());
        
        const product = await Product.findById(req.params.id);
        if(!product) return res.status(404).json({error: "Produk tidak ditemukan"});

        product.kontenProduk.push(...stockArray);
        product.stok = product.kontenProduk.length;
        await product.save();
        
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ========== REAL-TIME LOGS (SOCKET.IO) ==========
io.on('connection', async (socket) => {
    socket.emit('log', { line: '=== Dashboard Terhubung ke Server ===\n', source: 'server' });
    
    // Integrasi Log Heroku (Jika diaktifkan di ENV)
    if (HEROKU_API_TOKEN && HEROKU_APP_NAME) {
        try {
            const sessionRes = await fetch(`https://api.heroku.com/apps/${HEROKU_APP_NAME}/log-sessions`, {
                method: 'POST',
                headers: { 
                    'Authorization': `Bearer ${HEROKU_API_TOKEN}`, 
                    'Accept': 'application/vnd.heroku+json; version=3', 
                    'Content-Type': 'application/json' 
                },
                body: JSON.stringify({ lines: 100, tail: true })
            });

            if(sessionRes.ok) {
                const data = await sessionRes.json();
                const streamRes = await fetch(data.logplex_url);
                
                // Pipe stream ke socket
                streamRes.body.on('data', (chunk) => {
                    const lines = chunk.toString().split('\n');
                    lines.forEach(line => {
                        if(line.trim()) {
                            let src = line.includes('heroku[router]') ? 'router' : 'app';
                            socket.emit('log', { line: line + '\n', source: src });
                        }
                    });
                });
            }
        } catch (e) { console.error("Log Stream Error:", e.message); }
    }
});

// ========== START SERVER ==========
server.listen(PORT, () => {
    console.log(`🚀 Web Server Berjalan di Port ${PORT}`);
    console.log(`🔗 Callback URL: ${process.env.SERVER_BASE_URL}/jagopay-callback`);
});
