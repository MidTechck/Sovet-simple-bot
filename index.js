const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8080;

// Put your NVIDIA API key here or use process.env.NVIDIA_API_KEY
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || "YOUR_NVIDIA_API_KEY_HERE";

let qrCodeData = '';
let isConnected = false;
let currentSock = null;

async function getNvidiaResponse(userMessage) {
    try {
        const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${NVIDIA_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "nvidia/llama-3.1-nemotron-70b-instruct",
                messages: [{ role: "user", content: userMessage }],
                max_tokens: 512,
                temperature: 0.5
            })
        });

        const data = await response.json();
        if (data.choices && data.choices.length > 0) {
            return data.choices[0].message.content;
        } else {
            return "Sorry, I couldn't generate a response from NVIDIA AI.";
        }
    } catch (err) {
        console.error("NVIDIA API Error:", err);
        return "Error connecting to NVIDIA AI service.";
    }
}

async function startBot() {
    if (currentSock) {
        try { currentSock.end(undefined); } catch (e) {}
    }

    if (!fs.existsSync('auth_info_baileys')) {
        fs.mkdirSync('auth_info_baileys', { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        auth: state,
        version,
        logger: pino({ level: 'silent' }),
        browser: ['Mac OS', 'Safari', '17.0']
    });

    currentSock = sock;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrCodeData = qr;
            console.log('New QR code generated successfully.');
        }

        if (connection === 'open') {
            isConnected = true;
            qrCodeData = '';
            console.log('Connected to WhatsApp successfully!');
        }
        
        if (connection === 'close') {
            isConnected = false;
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log('Connection closed. Reason:', lastDisconnect?.error?.message || lastDisconnect?.error, 'Status:', statusCode);
            
            if (statusCode === DisconnectReason.loggedOut || statusCode === 405 || statusCode === 440) {
                console.log('Clearing auth state due to error...');
                try {
                    fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                } catch (e) {}
            }
            
            setTimeout(startBot, 5000);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

        if (!text) return;

        console.log(`Received message: "${text}" from ${sender}`);
        
        // Show typing indicator on WhatsApp
        await sock.sendPresenceUpdate('composing', sender);

        // Get AI answer from NVIDIA NIM API
        const aiReply = await getNvidiaResponse(text);
        
        await sock.sendMessage(sender, { text: aiReply });
    });
}

app.get('/', async (req, res) => {
    if (isConnected) {
        return res.send('<h1 style="color:green; text-align:center; margin-top:20vh; font-family:sans-serif;">Bot is already connected to WhatsApp!</h1>');
    }
    if (!qrCodeData) {
        return res.send(`
            <html>
            <head><meta http-equiv="refresh" content="4"></head>
            <body style="text-align:center; margin-top:20vh; font-family:sans-serif;">
                <h2>Generating fresh QR code, please wait...</h2>
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
                <p>Open WhatsApp - Linked Devices - Link a Device</p>
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
    console.log('Server running on port ' + PORT);
    startBot();
});

