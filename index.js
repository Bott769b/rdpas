const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const { URLSearchParams } = require("url");

require("dotenv").config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const VIOLET_API_KEY = process.env.VIOLET_API_KEY;
const VIOLET_SECRET_KEY = process.env.VIOLET_SECRET_KEY;
const MONGO_URI = process.env.MONGO_URI;
const PORT = process.env.PORT || 37761;

const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())) : [];
const CHANNEL_ID = process.env.CHANNEL_ID;

mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ Callback Server Connected"))
    .catch(err => console.error("❌ Mongo Error:", err));

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const User = require('./models/User');
const Product = require('./models/Product');
const Transaction = require('./models/Transaction');
const Setting = require('./models/Setting');

const VMP_ALLOWED_IP = new Set([
    "202.155.132.37",
    "2001:df7:5300:9::122"
]);

function getClientIp(req) {
    return (
        req.headers["x-forwarded-for"]?.split(",")[0] ||
        req.connection.remoteAddress ||
        req.socket.remoteAddress ||
        "UNKNOWN"
    );
}

async function sendTelegramMessage(token, userId, msg, parseMode = "Markdown") {
    if (!token) return;
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            body: new URLSearchParams({
                chat_id: userId,
                text: msg,
                parse_mode: parseMode
            })
        });
    } catch (e) {
        console.log("TG SEND ERROR:", e.message);
    }
}

async function sendTelegramSticker(token, userId, fileId) {
    if (!token) return;
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendSticker`, {
            method: "POST",
            body: new URLSearchParams({
                chat_id: userId,
                sticker: fileId
            })
        });
    } catch (e) {
        console.log("TG STICKER ERROR:", e.message);
    }
}

async function sendChannelNotification(message) {
    if (!CHANNEL_ID || !BOT_TOKEN) return;
    try {
        await sendTelegramMessage(BOT_TOKEN, CHANNEL_ID, message, 'Markdown');
    } catch (error) {
        console.error(`❌ Gagal mengirim notifikasi ke channel ${CHANNEL_ID}: ${error.message}`);
        if (ADMIN_IDS.length > 0) {
            try {
                await sendTelegramMessage(BOT_TOKEN, ADMIN_IDS[0],
                    `⚠️ Gagal mengirim notifikasi ke channel. Pastikan bot adalah admin di channel ${CHANNEL_ID} dan ID-nya benar.\n\nError: ${error.message}`
                );
            } catch (adminError) {
                console.error("Gagal mengirim notifikasi error ke admin:", adminError.message);
            }
        }
    }
}

async function getProductContent(productId) {
    try {
        const product = await Product.findById(productId);

        if (product && product.kontenProduk.length > 0) {
            const deliveredContent = product.kontenProduk.shift();

            await Product.updateOne({ _id: productId }, {
                $set: { kontenProduk: product.kontenProduk },
                $inc: { stok: -1, totalTerjual: 1 }
            });

            return { status: true, content: deliveredContent, product: product };
        } else {
            return { status: false, content: null, product: product };
        }
    } catch (error) {
        console.error("Error di getProductContent:", error);
        return { status: false, content: null, product: null };
    }
}

app.post("/violet-callback", async (req, res) => {
    const data = req.body;
    const clientIp = getClientIp(req);

    const refid = data.ref || data.ref_id || data.ref_kode;
    const status = (data.status || "").toLowerCase();
    const incomingSignature = data.signature || data.sign || data.sig || req.headers["x-callback-signature"] || null;

    console.log("\n====== CALLBACK MASUK ======");
    console.log("IP:", clientIp);
    console.log("REF:", refid);
    console.log("STATUS:", status);

    if (!refid || !status) {
        console.log("🚫 Data refid atau status tidak lengkap. Skip.");
        return res.status(200).send({ status: true });
    }

    if (!refid.startsWith("PROD-") && !refid.startsWith("TOPUP-")) {
        console.log(`⚠ Format refId ${refid} tidak dikenal. Skip.`);
        return res.status(200).send({ status: true });
    }

    try {
        if (!VMP_ALLOWED_IP.has(clientIp)) {
            console.log(`🚫🚫 REJECT: IP ${clientIp} tidak ada di Whitelist.`);
            return res.status(200).send({ status: true });
        }

        console.log(`✔ IP ${clientIp} DIIZINKAN. Signature di-bypass. Melanjutkan proses...`);

        const trx = await Transaction.findOne({ refId: refid });

        if (!trx) {
            console.log("❌ Transaksi tidak ada di database.");
            return res.status(200).send({ status: true });
        }

        if (trx.status === "SUCCESS") {
            console.log("✔ Sudah sukses, skip");
            return res.status(200).send({ status: true });
        }

        const stickerSetting = await Setting.findOne({ key: 'success_sticker_id' });

        if (status === "success") {
            await Transaction.updateOne(
                { refId: refid },
                { status: "SUCCESS", vmpSignature: `BYPASSED_IP_${clientIp}` }
            );

            if (trx.produkInfo.type === "TOPUP") {
                const updatedUser = await User.findOneAndUpdate(
                    { userId: trx.userId },
                    { $inc: { saldo: trx.totalBayar, totalTransaksi: 1 } },
                    { new: true }
                );

                const notifMessage = `💰 **TOP-UP SUKSES (QRIS)** 💰\n\n` +
                    `👤 **User:** [${updatedUser.username}](tg://user?id=${updatedUser.userId})\n` +
                    `💰 **Total:** \`Rp ${trx.totalBayar.toLocaleString('id-ID')}\`\n` +
                    `🆔 **Ref ID:** \`${refid}\``;
                await sendChannelNotification(notifMessage);

                if (stickerSetting && stickerSetting.value) {
                    await sendTelegramSticker(BOT_TOKEN, trx.userId, stickerSetting.value);
                }
                await sendTelegramMessage(BOT_TOKEN, trx.userId,
                    `╭─────────────────────────\n│ 🎉 Top Up Saldo Berhasil!\n│ Saldo kini: Rp ${updatedUser.saldo.toLocaleString('id-ID')}.\n╰─────────────────────────`
                );
            }

            else {
                const productFromDb = await Product.findOne({
                    namaProduk: trx.produkInfo.namaProduk,
                    kategori: trx.produkInfo.kategori
                });

                if (!productFromDb) {
                    console.error(`FATAL: Produk ${trx.produkInfo.namaProduk} tidak ditemukan saat callback!`);
                    await sendTelegramMessage(BOT_TOKEN, trx.userId, `⚠️ Pembayaran Anda (\`${refid}\`) sukses, namun produk \`${trx.produkInfo.namaProduk}\` tidak ditemukan. Hubungi Admin!`);
                    return res.status(200).send({ status: true });
                }

                const { status: deliverStatus, content: deliveredContent, product } = await getProductContent(productFromDb._id);

                const stokAkhir = product.stok;
                const stokAwal = stokAkhir + 1;

                const notifMessage = `🎉 **PENJUALAN BARU (QRIS)** 🎉\n\n` +
                    `👤 **Pembeli:** [User](tg://user?id=${trx.userId})\n` +
                    `🛍️ **Produk:** \`${product.namaProduk}\`\n` +
                    `💰 **Total:** \`Rp ${trx.totalBayar.toLocaleString('id-ID')}\`\n\n` +
                    `--- *Info Tambahan* ---\n` +
                    `📦 **Sisa Stok:** \`${stokAkhir}\` pcs (dari ${stokAwal})\n` +
                    `🏦 **Metode:** QRIS VMP\n` +
                    `🆔 **Ref ID:** \`${refid}\``;
                await sendChannelNotification(notifMessage);

                if (stickerSetting && stickerSetting.value) {
                    await sendTelegramSticker(BOT_TOKEN, trx.userId, stickerSetting.value);
                }

                if (deliverStatus && deliveredContent) {
                    const date = new Date();
                    const dateCreated = `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}, ${date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).replace(/:/g, '.')}`;

                    let successMessage = `📜 *Pembelian Berhasil*\n`;
                    successMessage += `Terimakasih telah Melakukan pembelian di store kami\n\n`;
                    successMessage += `*Informasi Pembelian:*\n`;
                    successMessage += `— *Total Dibayar:* Rp ${trx.totalBayar.toLocaleString('id-ID')}\n`;
                    successMessage += `— *Date Created:* ${dateCreated}\n`;
                    successMessage += `— *Metode Pembayaran:* QRIS\n`;
                    successMessage += `— *Jumlah Item:* 1x\n`;
                    successMessage += `— *ID transaksi:* ${refid}\n\n`;
                    successMessage += `*${product.namaProduk}*\n`;
                    successMessage += "```txt\n";
                    successMessage += `1. ${deliveredContent}\n`;
                    successMessage += "```";

                    await sendTelegramMessage(BOT_TOKEN, trx.userId, successMessage);
                } else {
                    await sendTelegramMessage(BOT_TOKEN, trx.userId, `⚠️ Pembayaran Anda sukses (\`${refid}\`), namun stok produk habis. Harap hubungi Admin!`);
                }
            }
        }

        else if (status === "failed" || status === "expired") {
            await Transaction.updateOne(
                { refId: refid },
                { status: status.toUpperCase() }
            );

            await sendTelegramMessage(
                BOT_TOKEN,
                trx.userId,
                `❌ *Transaksi Gagal/Kedaluwarsa!*\n\nTransaksi Anda untuk \`${trx.produkInfo.namaProduk}\` (\`${refid}\`) telah dibatalkan.`
            );
        }

        return res.status(200).send({ status: true });

    } catch (err) {
        console.error("Callback Error:", err);
        return res.status(200).send({ status: true });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Callback server (IP-ONLY) berjalan di port ${PORT}`);
});