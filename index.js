require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;

// --- RAILWAY PERSISTENT STORAGE ---
// This ensures you don't have to scan the QR code every time Railway restarts
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || './data';
const AUTH_DIR = path.join(DATA_DIR, 'auth_info_baileys');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

// --- WEB SERVER FOR QR CODE ---
const app = express();
const PORT = process.env.PORT || 8080;
let qrCodeDataUrl = '';
let isConnected = false;

app.get('/', (req, res) => {
    if (isConnected) {
        res.send('<h2 style="font-family: sans-serif; text-align: center; margin-top: 50px; color: green;">Bot is successfully connected to WhatsApp.</h2><p style="text-align: center;">The AI is currently active and monitoring messages.</p>');
    } else if (qrCodeDataUrl) {
        res.send(`
            <html>
            <head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
            <body style="font-family: Arial, sans-serif; text-align: center; margin-top: 50px;">
                <h2>Scan this QR Code with WhatsApp</h2>
                <p>Open WhatsApp > Linked Devices > Link a Device</p>
                <img src="${qrCodeDataUrl}" alt="WhatsApp QR Code" style="max-width: 300px; height: auto;" />
                <p style="color: gray; font-size: 12px;">This page refreshes automatically...</p>
                <script>setTimeout(() => location.reload(), 5000);</script>
            </body>
            </html>
        `);
    } else {
        res.send('<h2 style="font-family: sans-serif; text-align: center; margin-top: 50px;">Starting bot...</h2><p style="text-align: center;">Please refresh this page in a few seconds to see the QR code.</p>');
    }
});

app.listen(PORT, () => {
    console.log(`Web server running on port ${PORT}. Check your Railway URL to scan the QR code.`);
});

// --- BOT STATE & MEMORY ---
const manualMutes = new Map(); 
const MUTE_DURATION = 45 * 60 * 1000; 
const chatHistories = new Map(); 
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- AI GENERATION WITH MULTI-TIER FALLBACK ---
async function generateAIResponse(senderNumber, userMessage) {
    if (!chatHistories.has(senderNumber)) chatHistories.set(senderNumber, []);
    const history = chatHistories.get(senderNumber);
    
    history.push({ role: 'user', content: userMessage });
    if (history.length > 6) history.shift();

    const systemPrompt = `You are a friendly, concise human representative for Trustwave Technologies Ltd on WhatsApp. 
Keep your responses short, natural, direct, and conversational (1-2 sentences max). 
Never use robotic corporate intros like "Hello, I am the assistant for...". Talk like a real person typing quickly on a phone.
If you don't know an exact price for a custom installation, say: "I can have our team calculate a quote for your setup and get back to you shortly."
Services provided: CCTV cameras, access control systems, IT security services, and Starlink setups.`;

    // 1. PRIMARY: GEMINI API
    if (GEMINI_API_KEY) {
        try {
            const geminiMessages = [
                { role: 'user', parts: [{ text: systemPrompt }] },
                ...history.map(h => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] }))
            ];

            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: geminiMessages })
            });

            const data = await response.json();
            const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (reply) {
                history.push({ role: 'assistant', content: reply });
                return reply.trim();
            }
        } catch (err) {
            console.log('Gemini API failed, falling back to Nvidia...');
        }
    }

    // 2. SECONDARY BACKUP: NVIDIA API
    if (NVIDIA_API_KEY) {
        try {
            const nvidiaMessages = [
                { role: 'system', content: systemPrompt },
                ...history
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
            const reply = data?.choices?.[0]?.message?.content;
            if (reply) {
                history.push({ role: 'assistant', content: reply });
                return reply.trim();
            }
        } catch (err) {
            console.log('Nvidia API failed, falling back to keywords...');
        }
    }

    // 3. ULTIMATE BACKUP: LOCAL KEYWORDS (Strictly No Exclamation Marks)
    const lower = userMessage.toLowerCase();
    if (lower.includes('cctv') || lower.includes('camera')) {
        return "We install HD CCTV cameras with remote phone viewing. Want a quick quote?";
    } else if (lower.includes('starlink') || lower.includes('internet')) {
        return "We do full Starlink installations and network extensions. Are you looking to set up a new dish?";
    } else if (lower.includes('price') || lower.includes('cost')) {
        return "Our pricing depends on your exact setup. Would you like a technician to assess your site?";
    } else if (lower.includes('hello') || lower.includes('hi') || lower.includes('hey')) {
        return "Hello there. How can we help you with your security or IT systems today?";
    }

    return "Thanks for reaching out. Let me connect you with the owner to assist you further.";
}

// --- WHATSAPP BOT CORE ---
async function startBot() {
    // Uses the persistent AUTH_DIR so Railway remembers the session on restart
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, 
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrcode.toDataURL(qr, (err, url) => {
                if (!err) {
                    qrCodeDataUrl = url;
                    console.log('New QR code generated. Check your web URL to scan.');
                }
            });
        }

        if (connection === 'open') {
            console.log('Bot connected successfully.');
            isConnected = true;
            qrCodeDataUrl = ''; // Clear the QR code once connected
        } else if (connection === 'close') {
            isConnected = false;
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting...', shouldReconnect);
            if (shouldReconnect) {
                setTimeout(startBot, 3000); // Wait 3 seconds before reconnecting
            } else {
                console.log('Logged out. Please delete the auth folder and rescan.');
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;

        const sender = msg.key.remoteJid;

        // Handle messages sent by you (the owner) to mute the bot
        if (msg.key.fromMe) {
            if (sender) manualMutes.set(sender, Date.now());
            return;
        }

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!text) return;

        // Check if the conversation is manually muted
        const lastMuted = manualMutes.get(sender) || 0;
        if (Date.now() - lastMuted < MUTE_DURATION) return;

        // Check for human handover trigger
        if (text.toLowerCase().includes('owner') || text.toLowerCase().includes('human') || text.toLowerCase().includes('talk to someone')) {
            manualMutes.set(sender, Date.now() + (2 * 60 * 60 * 1000)); // Mute for 2 hours
            await sock.sendMessage(sender, { text: "I have connected you with the owner. Someone from our team will be with you shortly." });
            return;
        }

        // Simulate typing delay for realism
        await sock.sendPresenceUpdate('composing', sender);
        await delay(2500);

        // Generate and send AI response
        const replyText = await generateAIResponse(sender, text);
        await sock.sendMessage(sender, { text: replyText });
    });
}

startBot();

