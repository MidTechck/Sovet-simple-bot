const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8080;

let qrCodeData = '';
let isConnected = false;

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();
    console.log(`Using Baileys version v${version.join('.')}`);

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['Ubuntu', 'Chrome', '20.0.0']
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrCodeData = qr;
            console.log('📱 New QR code generated successfully.');
        }

        if (connection === 'open') {
            isConnected = true;
            qrCodeData = '';
            console.log('✅ Connected to WhatsApp successfully!');
        }
        
        if (connection === 'close') {
            isConnected = false;
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log(`Connection closed. Reason:`, lastDisconnect?.error?.message || lastDisconnect?.error, 'Status:', statusCode);
            
            // Clear corrupted session if logged out or conflict occurs
            if (statusCode === DisconnectReason.loggedOut || statusCode === 440) {
                console.log('Clearing corrupted auth state...');
                try {
                    fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                } catch (e) {}
            }
            
            setTimeout(startBot, 3000);
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

app.get('/', async (req, res) => {
    if (isConnected) {
        return res.send('<h1 style="color:green; text-align:center; margin-top:20vh; font-family:sans-serif;">✅ Bot is already connected to WhatsApp!</h1>');
    }
    if (!qrCodeData) {
        return res.send(`
            <html>
            <head><meta http-equiv="refresh" content="4"></head>
            <body style="text-align:center; margin-top:20vh; font-family:sans-serif;">
                <h2>⏳ Generating fresh QR code, please wait...</h2>
                <p>This page will auto-refresh until the code appears.</p>
            </body>
            </html>
        `);
    }
    try {
        const url = await qrcode.toDataURL(qrCodeData);
        res.send(`
            <html>
            <head><meta http-equiv="refresh" content="15"></head>
            <body style="text-align:center; margin-top:8vh; font-family:sans-serif;">
                <h2>Scan this QR Code to Link WhatsApp Bot</h2>
                <p>Open WhatsApp -> Linked Devices -> Link a Device</p>
                <img src="${url}" alt="WhatsApp QR Code" style="width:320px; height:320px; border:3px solid #25D366; border-radius:12px; padding:10px; background:white;" />
                <p style="color:gray; font-size:14px; margin-top:20px;">Page auto-refreshes to keep your QR code active.</p>
            </body>
            </html>
        `);
    } catch (err) {
        res.status(500).send('Error generating QR code image');
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    startBot();
});

