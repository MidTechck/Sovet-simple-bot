const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8080;

// NVIDIA API Key from environment variable
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || "YOUR_NVIDIA_API_KEY_HERE";

let qrCodeData = '';
let isConnected = false;
let currentSock = null;

// In-memory conversation history per sender JID for natural context memory
const chatHistories = {};

const SYSTEM_PROMPT = `You are a friendly, professional human customer support representative working for Sovet Link Technologies (Sovet Link Zambia), a leading IT infrastructure and connectivity company based in Lusaka (Woodlands) and Ndola, providing services across Zambia.

Your job is to assist clients over WhatsApp 24/7, answering inquiries naturally, warmly, and like a real human employee—never sound like a rigid robot.

COMPANY SERVICES & PRICING KNOWLEDGE:
- Starlink Internet Installation: Professional dish mounting, cable routing, full network & WiFi setup for homes, schools, businesses, and offices. 
  * Starlink Gen 3: from K9,000
  * Starlink Mini: from K6,800
  * Monthly unlimited internet subscriptions: from K800
- CCTV Security Camera Supply & Installation: Single-camera households to multi-camera shops and offices, remote phone viewing setup, post-installation support.
- Networking Solutions: LAN setup, structured cabling, Wi-Fi coverage planning for offices/schools, network upgrades.
- IT Support Services: Ongoing troubleshooting, network maintenance, tech support.
- Site surveys and consultations.

COVERAGE & HOURS:
- Based in Lusaka (Woodlands) and Ndola, serving clients across Zambia.
- Contact: +260 968 252 812 | info@sovetlink.com
- Office working hours: Monday to Sunday, 08:00 - 18:00.

BOUNDARIES & BEHAVIOR:
- If a user asks you to write code or help with software development/programming, do NOT say yes or act as a coding bot. Politely clarify that as a Sovet Link representative, you specialize in physical IT infrastructure, Starlink, CCTV, networking, and technical support rather than software coding.
- Keep responses concise, helpful, and conversational, matching natural WhatsApp messaging style. Avoid overly long blocks of text unless detailing a quotation or service specs.
`;

async function getNvidiaResponse(sender, userMessage) {
    if (!chatHistories[sender]) {
        chatHistories[sender] = [
            { role: "system", content: SYSTEM_PROMPT }
        ];
    }

    // Add user message to history
    chatHistories[sender].push({ role: "user", content: userMessage });

    // Keep history length manageable (last 15 messages + system prompt)
    if (chatHistories[sender].length > 16) {
        chatHistories[sender] = [
            chatHistories[sender][0],
            ...chatHistories[sender].slice(-15)
        ];
    }

    try {
        const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${NVIDIA_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "nvidia/llama-3.1-nemotron-70b-instruct",
                messages: chatHistories[sender],
                max_tokens: 512,
                temperature: 0.6
            })
        });

        const data = await response.json();
        if (data.choices && data.choices.length > 0) {
            const aiReply = data.choices[0].message.content;
            // Save assistant reply to history
            chatHistories[sender].push({ role: "assistant", content: aiReply });
            return aiReply;
        } else {
            return "Hello! I'm having a brief moment connecting to our network. How can I help you with Starlink, CCTV, or networking today?";
        }
    } catch (err) {
        console.error("NVIDIA API Error:", err);
        return "Sorry about that! Our system encountered a minor glitch. Feel free to call us directly at +260 968 252 812.";
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
        
        // Show human-like typing presence indicator
        await sock.sendPresenceUpdate('composing', sender);

        // Smart delay based on response length or natural typing pause (2 to 4 seconds)
        const aiReply = await getNvidiaResponse(sender, text);
        const typingDelay = Math.min(Math.max(aiReply.length * 20, 2000), 5000);
        
        await new Promise(resolve => setTimeout(resolve, typingDelay));
        await sock.sendPresenceUpdate('paused', sender);
        
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

