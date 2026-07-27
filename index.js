const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');
const qrcode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 5000;

let qrCodeData = '';
let isConnected = false;

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['Chrome (Linux)', '', '']
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrCodeData = qr;
            console.log('New QR code generated for web view.');
        }

        if (connection === 'open') {
            isConnected = true;
            qrCodeData = '';
            console.log('✅ Connected to WhatsApp successfully!');
        }
        
        if (connection === 'close') {
            isConnected = false;
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log(`Connection closed. Reconnecting...`);
            if (statusCode !== DisconnectReason.loggedOut) {
                setTimeout(startBot, 3000);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').toLowerCase();

        if (text.includes('hello') || text.includes('hi')) {
            await sock.sendMessage(sender, { text: 'Hello! Thanks for reaching out. How can we help you today?' });
        } else {
            await sock.sendMessage(sender, { text: 'Got your message! We will get back to you shortly.' });
        }
    });
}

// Web page route for your client in Lusaka
app.get('/', async (req, res) => {
    if (isConnected) {
        return res.send('<h1 style="color:green; text-align:center; margin-top:20vh; font-family:sans-serif;">✅ Bot is already connected to WhatsApp!</h1>');
    }
    if (!qrCodeData) {
        return res.send('<h1 style="text-align:center; margin-top:20vh; font-family:sans-serif;">⏳ Generating QR code, please refresh the page in 5 seconds...</h1>');
    }
    try {
        const url = await qrcode.toDataURL(qrCodeData);
        res.send(`
            <div style="text-align:center; margin-top:8vh; font-family:sans-serif;">
                <h2>Scan this QR Code to Link WhatsApp Bot</h2>
                <p>Tell your client to open WhatsApp -> Linked Devices -> Link a Device</p>
                <img src="${url}" alt="WhatsApp QR Code" style="width:320px; height:320px; border:3px solid #25D366; border-radius:12px; padding:10px; background:white;" />
                <p style="color:gray; font-size:14px; margin-top:20px;">Refresh this page if the code needs to be renewed.</p>
            </div>
        `);
    } catch (err) {
        res.status(500).send('Error generating QR code image');
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    startBot();
});

