require('dotenv').config();
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : "";
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY ? process.env.NVIDIA_API_KEY.trim() : "";

// --- RAILWAY PERSISTENT STORAGE ---
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '.';
const AUTH_DIR = path.join(DATA_DIR, 'auth_info_baileys');

// --- WEB SERVER FOR QR CODE ---
const app = express();
const PORT = process.env.PORT || 8080;
let qrCodeDataUrl = '';
let isConnected = false;
let currentSock = null;

app.get('/', (req, res) => {
    if (isConnected) {
        return res.send('<h2 style="font-family: sans-serif; text-align: center; margin-top: 20vh; color: green;">Bot is successfully connected to WhatsApp!</h2>');
    } else if (qrCodeDataUrl) {
        return res.send(`
            <html>
            <head><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="refresh" content="10"></head>
            <body style="font-family: Arial, sans-serif; text-align: center; margin-top: 10vh;">
                <h2>Scan this QR Code with WhatsApp</h2>
                <p>Open WhatsApp > Linked Devices > Link a Device</p>
                <img src="${qrCodeDataUrl}" alt="WhatsApp QR Code" style="max-width: 300px; height: auto; border: 3px solid #25D366; border-radius: 12px; padding: 10px;" />
                <p style="color: gray; font-size: 14px;">This page refreshes automatically...</p>
            </body>
            </html>
        `);
    } else {
        return res.send('<h2 style="font-family: sans-serif; text-align: center; margin-top: 20vh;">Starting bot and generating QR code... Please wait.</h2><script>setTimeout(() => location.reload(), 3000);</script>');
    }
});

app.listen(PORT, () => {
    console.log(`Web server running on port ${PORT}.`);
});

// --- BOT STATE & MEMORY ---
const manualMutes = new Map();
const MUTE_DURATION = 45 * 60 * 1000;
const chatHistories = new Map();

// --- AI GENERATION ENGINE ---
async function generateAIResponse(senderNumber, userMessage) {
    if (!chatHistories.has(senderNumber)) chatHistories.set(senderNumber, []);
    const history = chatHistories.get(senderNumber);
    
    history.push({ role: 'user', content: userMessage });
    
    // Ensure strict alternation of roles for LLM compatibility
    const sanitizedHistory = [];
    for (const msg of history) {
        const last = sanitizedHistory[sanitizedHistory.length - 1];
        if (!last || last.role !== msg.role) {
            sanitizedHistory.push(msg);
        }
    }
    if (sanitizedHistory.length > 8) sanitizedHistory.shift();

    const systemPrompt = `You are a friendly, concise human representative for Trustwave Technologies Ltd on WhatsApp. 
Keep your responses short, natural, direct, and conversational (1-2 sentences max). 
Never use robotic corporate intros like "Hello, I am the assistant for...". Talk like a real person typing quickly on a phone.
If you don't know an exact price for a custom installation, say: "I can have our team calculate a quote for your setup and get back to you shortly."
Services provided: CCTV cameras, access control systems, IT security services, and Starlink setups.
STRICT RULE: Never use exclamation marks or emojis.`;

    // 1. PRIMARY: GEMINI API
    if (GEMINI_API_KEY) {
        try {
            const geminiPayload = {
                system_instruction: {
                    parts: [{ text: systemPrompt }]
                },
                contents: sanitizedHistory.map(h => ({
                    role: h.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: h.content }]
                }))
            };

            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(geminiPayload)
            });

            const data = await response.json();
            
            if (response.ok && data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                const reply = data.candidates[0].content.parts[0].text.trim();
                history.push({ role: 'assistant', content: reply });
                return reply;
            } else {
                console.log(`[GEMINI API ERROR] Status ${response.status}:`, JSON.stringify(data));
            }
        } catch (err) {
            console.log('[GEMINI EXCEPTION]:', err.message);
        }
    }

    // 2. SECONDARY: NVIDIA API
    if (NVIDIA_API_KEY) {
        try {
            const nvidiaMessages = [
                { role: 'system', content: systemPrompt },
                ...sanitizedHistory
            ];

            const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${NVIDIA_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'nvidia/nemotron-4-34b-instruct',
                    messages: nvidiaMessages,
                    max_tokens: 150,
                    temperature: 0.7
                })
            });

            const data = await response.json();

            if (response.ok && data?.choices?.[0]?.message?.content) {
                const reply = data.choices[0].message.content.trim();
                history.push({ role: 'assistant', content: reply });
                return reply;
            } else {
                console.log(`[NVIDIA API ERROR] Status ${response.status}:`, JSON.stringify(data));
            }
        } catch (err) {
            console.log('[NVIDIA EXCEPTION]:', err.message);
        }
    }

    console.log('[FALLBACK] Both AI APIs failed or keys are missing. Using local keyword engine.');

    // 3. ULTIMATE BACKUP: LOCAL KEYWORDS
    const lower = userMessage.toLowerCase();
    if (lower.includes('cctv') || lower.includes('camera') || lower.includes('security')) {
        return "We install HD CCTV cameras with remote phone viewing. Want a quick quote.";
    } else if (lower.includes('starlink') || lower.includes('internet') || lower.includes('wifi')) {
        return "We do full Starlink installations and network extensions. Are you looking to set up a new dish.";
    } else if (lower.includes('price') || lower.includes('cost') || lower.includes('how much')) {
        return "Our pricing depends on your exact setup. Would you like a technician to assess your site.";
    } else if (lower.includes('hello') || lower.includes('hi') || lower.includes('morning') || lower.includes('afternoon')) {
        return "Hello there. How can we help you with your security or IT systems today.";
    }

    return "Thanks for reaching out. Let me connect you with our team to assist you further.";
}

// --- WHATSAPP BOT CORE ---
async function startBot() {
    if (currentSock) {
        try { currentSock.end(undefined); } catch (e) {}
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        auth: state,
        version,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false
    });

    currentSock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrcode.toDataURL(qr, (err, url) => {
                if (!err) {
                    qrCodeDataUrl = url;
                    console.log('New QR code generated successfully.');
                }
            });
        }

        if (connection === 'open') {
            console.log('Bot connected to WhatsApp successfully.');
            isConnected = true;
            qrCodeDataUrl = '';
        } else if (connection === 'close') {
            isConnected = false;
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log('Connection closed. Status code:', statusCode);

            if (statusCode === DisconnectReason.loggedOut || statusCode === 405 || statusCode === 401 || statusCode === 440) {
                try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {}
            }
            setTimeout(startBot, 4000);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;

        const sender = msg.key.remoteJid;

        if (msg.key.fromMe) {
            if (sender) {
                manualMutes.set(sender, Date.now());
                console.log(`Human agent replied to ${sender}. Bot muted for this client for 45 minutes.`);
            }
            return;
        }

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!text) return;

        const lastMuted = manualMutes.get(sender) || 0;
        if (Date.now() - lastMuted < MUTE_DURATION) {
            return;
        }

        const lowerText = text.toLowerCase();
        if (lowerText.includes('owner') || lowerText.includes('human') || lowerText.includes('talk to someone')) {
            manualMutes.set(sender, Date.now()); 
            await sock.sendMessage(sender, { text: "I have connected you with the owner. Someone from our team will be with you shortly." });
            return;
        }

        console.log(`Received message from ${sender}: "${text}"`);

        await sock.sendPresenceUpdate('composing', sender);
        
        const replyText = await generateAIResponse(sender, text);
        
        const typingDelay = Math.min(Math.max(replyText.length * 20, 1500), 4000);
        await new Promise(resolve => setTimeout(resolve, typingDelay));
        
        await sock.sendPresenceUpdate('paused', sender);
        await sock.sendMessage(sender, { text: replyText });
    });
}

startBot();

