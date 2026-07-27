const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 5000;
const PHONE_NUMBER = process.env.PHONE_NUMBER;

let activeSock = null;

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['Chrome (Linux)', '', '']
    });

    activeSock = sock;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'open') {
            console.log('✅ Connected to WhatsApp successfully!');
        }
        
        if (connection === 'close') {
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

// Web endpoints to generate codes on demand
app.get('/', (req, res) => {
    res.send('Sovet Bot is active! Go to your-railway-url.railway.app/get-code to generate a fresh pairing code.');
});

app.get('/get-code', async (req, res) => {
    if (!PHONE_NUMBER) {
        return res.status(400).send("❌ PHONE_NUMBER variable is missing in Railway!");
    }
    if (!activeSock) {
        return res.status(400).send("❌ Bot is still starting up. Please wait 5 seconds and refresh.");
    }
    try {
        console.log("Generating fresh pairing code on demand...");
        const code = await activeSock.requestPairingCode(PHONE_NUMBER);
        console.log(`\n========================================`);
        console.log(`🔑 NEW PAIRING CODE: ${code}`);
        console.log(`========================================\n`);
        res.send(`<h1>Your New Pairing Code: <span style="color:red; font-size:40px;">${code}</span></h1><p>Copy this code immediately. It is also printed in your Railway logs.</p>`);
    } catch (err) {
        console.error("Pairing error:", err.message);
        res.status(500).send(`Error: ${err.message}`);
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    startBot();
});

