require('dotenv').config();
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8080;

const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || "";

let qrCodeData = '';
let isConnected = false;
let currentSock = null;

const chatHistories = {};

const SYSTEM_PROMPT = `You are a human customer support representative working for Sovet Link Technologies in Zambia (based in Lusaka Woodlands and Ndola). You talk to clients over WhatsApp 24/7.

CRITICAL FORMATTING RULES:
- Write ONLY in natural, conversational human paragraphs. 
- NEVER use bullet points, lists, asterisks, or rigid templates. Talk just like a real person texting on WhatsApp.
- Keep your replies concise, friendly, and engaging.

CONVERSATION STAGES & AWARENESS:
1. Greeting & New Chat: If the conversation is brand new, warmly greet the client, introduce yourself casually, and ask how you can help them today.
2. Discovery & Needs Identification: Understand if they need Starlink internet, CCTV security, networking, or general IT support. Never guess blindly; ask clarifying questions.
3. Solution & Pricing Knowledge: Match their needs with accurate company info:
   - Starlink Internet: Gen 3 from K9,000, Mini from K6,800, monthly unlimited internet from K800.
   - CCTV Systems: Supply, installation, and remote phone viewing setup for homes and offices.
   - Networking & IT Support: LAN setups, structured cabling, Wi-Fi planning, and ongoing troubleshooting.
4. Call to Action / Closing: Guide them toward booking a site consultation or calling our team at +260 968 252 812.

BOUNDARIES:
- If a client asks you to write code or do software programming, politely decline as a human employee, explaining that Sovet Link focuses entirely on physical IT infrastructure, Starlink, CCTV, and networking.
`;

const NVIDIA_MODELS = [
    "meta/llama-3.1-70b-instruct",
    "google/gemma-2-27b-it"
];

async function callNvidiaWithFallback(messages) {
    for (const model of NVIDIA_MODELS) {
        try {
            console.log(`Attempting AI call with model: ${model}`);
            const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${NVIDIA_API_KEY.trim()}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: model,
                    messages: messages,
                    max_tokens: 500,
                    temperature: 0.6
                })
            });

            const data = await res.json();
            if (res.ok && data.choices && data.choices.length > 0) {
                console.log(`Successfully received response from ${model}`);
                return data.choices[0].message.content;
            } else {
                console.log(`Model ${model} returned non-OK status or empty choices:`, JSON.stringify(data));
            }
        } catch (err) {
            console.log(`Model ${model} fetch exception error:`, err.message);
        }
    }
    return null;
}

async function getNvidiaResponse(sender, userMessage) {
    if (!chatHistories[sender]) {
        chatHistories[sender] = [
            { role: "system", content: SYSTEM_PROMPT }
        ];
    }

    chatHistories[sender].push({ role: "user", content: userMessage });

    if (chatHistories[sender].length > 16) {
        chatHistories[sender] = [
            chatHistories[sender][0],
            ...chatHistories[sender].slice(-15)
        ];
    }

    const aiReply = await callNvidiaWithFallback(chatHistories[sender]);

    if (aiReply) {
        chatHistories[sender].push({ role: "assistant", content: aiReply });
        return aiReply;
    } else {
        return "Hey there! I am having a tiny connection hiccup reaching our server right now. Feel free to call us directly at +260 968 252 812 so we can assist you right away.";
    }
}

async function startBot() {
    if (currentSock) {
        try { currentSock.end(undefined); } catch (e) {}
    }

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        auth: state,
        version,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false
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
            console.log('Connection closed. Status:', statusCode);
            
            if (statusCode === DisconnectReason.loggedOut || statusCode === 405 || statusCode === 401 || statusCode === 440) {
                console.log('Session invalidated. Clearing auth state...');
                try {
                    fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                } catch (e) {}
            }
            
            setTimeout(startBot, 4000);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

        if (!text) return;

        console.log(`Received message from ${sender}: "${text}"`);
        
        await sock.sendPresenceUpdate('composing', sender);

        const aiReply = await getNvidiaResponse(sender, text);
        
        const typingDelay = Math.min(Math.max(aiReply.length * 20, 2000), 5000);
        await new Promise(resolve => setTimeout(resolve, typingDelay));
        
        await sock.sendPresenceUpdate('paused', sender);
        await sock.sendMessage(sender, { text: aiReply });
    });
}

app.get('/', async (req, res) => {
    if (isConnected) {
        return res.send('<h1 style="color:green; text-align:center; margin-top:20vh; font-family:sans-serif;">Bot is successfully connected to WhatsApp!</h1>');
    }
    res.send('<h1 style="text-align:center; margin-top:20vh; font-family:sans-serif;">Bot is running and attempting connection...</h1>');
});

app.listen(PORT, () => {
    console.log('Server running on port ' + PORT);
    startBot();
});

