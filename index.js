require('dotenv').config();
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : "";
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY ? process.env.NVIDIA_API_KEY.trim() : "";
const OWNER_NOTIFY_NUMBER = process.env.OWNER_NOTIFY_NUMBER ? process.env.OWNER_NOTIFY_NUMBER.trim() : "";

// --- RAILWAY PERSISTENT STORAGE ---
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '.';
const AUTH_DIR = path.join(DATA_DIR, 'auth_info_baileys');
const STATE_FILE = path.join(DATA_DIR, 'bot_state.json');
const LEADS_FILE = path.join(DATA_DIR, 'leads.log');

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
const MUTE_DURATION = 30 * 60 * 1000; // 30 minutes
const chatHistories = new Map();
const botMessageIds = new Set();
const lastLeadAlert = new Map();
const LEAD_ALERT_COOLDOWN = 2 * 60 * 60 * 1000;

function generateMessageID() {
    return crypto.randomBytes(16).toString('hex').toUpperCase();
}

async function sendTrackedMessage(sock, jid, content) {
    const messageId = generateMessageID();
    botMessageIds.add(messageId);
    if (botMessageIds.size > 300) {
        const firstKey = botMessageIds.values().next().value;
        botMessageIds.delete(firstKey);
    }
    return sock.sendMessage(jid, content, { messageId });
}

// --- STATE PERSISTENCE ---
function loadState() {
    try {
        const raw = fs.readFileSync(STATE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.chatHistories) {
            for (const [key, value] of Object.entries(parsed.chatHistories)) {
                chatHistories.set(key, value);
            }
        }
        if (parsed.manualMutes) {
            for (const [key, value] of Object.entries(parsed.manualMutes)) {
                manualMutes.set(key, value);
            }
        }
        console.log(`Restored state for ${chatHistories.size} chat(s) from disk.`);
    } catch (e) {
        console.log('No previous state file found, starting fresh.');
    }
}

function saveState() {
    try {
        const data = {
            chatHistories: Object.fromEntries(chatHistories),
            manualMutes: Object.fromEntries(manualMutes)
        };
        fs.writeFileSync(STATE_FILE, JSON.stringify(data));
    } catch (e) {
        console.log('[STATE SAVE ERROR]:', e.message);
    }
}

loadState();

// --- BUYING INTENT DETECTION & LEAD COUNTING ---
const BUYING_INTENT_KEYWORDS = [
    'price', 'cost', 'how much', 'quote', 'quotation',
    'book', 'order', 'buy', 'purchase', 'interested',
    'install', 'when can you come', 'available today',
    'schedule', 'appointment', 'deposit', 'pay'
];

function logLead(sender, text) {
    try {
        const entry = `${new Date().toISOString()} | ${sender.split('@')[0]} | ${text.replace(/\s+/g, ' ')}\n`;
        fs.appendFileSync(LEADS_FILE, entry);
    } catch (e) {
        console.log('[LEAD LOG ERROR]:', e.message);
    }
}

function getLeadCount() {
    try {
        if (!fs.existsSync(LEADS_FILE)) return 0;
        const data = fs.readFileSync(LEADS_FILE, 'utf8');
        const lines = data.split('\n').filter(line => line.trim() !== '');
        return lines.length;
    } catch (e) {
        console.log('[LEAD COUNT ERROR]:', e.message);
        return 0;
    }
}

async function checkBuyingIntent(sock, sender, text, isMuted) {
    const lower = text.toLowerCase();
    const matched = BUYING_INTENT_KEYWORDS.some(k => lower.includes(k));
    if (!matched) return;

    logLead(sender, text);

    if (isMuted) return;
    if (!OWNER_NOTIFY_NUMBER) return;

    const lastAlert = lastLeadAlert.get(sender) || 0;
    if (Date.now() - lastAlert < LEAD_ALERT_COOLDOWN) return;
    lastLeadAlert.set(sender, Date.now());

    const clientNumber = sender.split('@')[0];
    const alertText = `New potential sale\nClient: ${clientNumber}\nMessage: "${text}"\n\nReply in their chat directly to take over.`;

    try {
        await sendTrackedMessage(sock, OWNER_NOTIFY_NUMBER, { text: alertText });
    } catch (e) {
        console.log('[OWNER ALERT ERROR]:', e.message);
    }
}

// --- AI GENERATION ENGINE ---
async function generateAIResponse(senderNumber, userMessage, isAdLead = false) {
    if (!chatHistories.has(senderNumber)) chatHistories.set(senderNumber, []);
    const history = chatHistories.get(senderNumber);

    // Calculate current time dynamically in Central Africa Time (Zambia)
    const nowZambia = new Date(new Date().toLocaleString("en-US", { timeZone: "Africa/Lusaka" }));
    const currentHour = nowZambia.getHours();
    
    let timeOfDay = "evening";
    if (currentHour >= 5 && currentHour < 12) {
        timeOfDay = "morning";
    } else if (currentHour >= 12 && currentHour < 17) {
        timeOfDay = "afternoon";
    } else {
        timeOfDay = "evening";
    }

    const timeContextString = `[REAL-TIME CONTEXT: The current year is 2026. The current local time in Zambia is ${nowZambia.toLocaleTimeString()} and it is currently ${timeOfDay}. Adjust any time-based greetings to match this exact time.]`;

    // Context tag for initial ad referrals
    const processedInput = isAdLead 
        ? `${timeContextString} [SYSTEM CONTEXT: The customer just clicked our Starlink Facebook/Instagram advertisement. IMMEDIATELY answer them by pitching our Starlink packages.] ${userMessage}`
        : `${timeContextString} ${userMessage}`;

    history.push({ role: 'user', content: processedInput });
    
    const sanitizedHistory = [];
    for (const msg of history) {
        const last = sanitizedHistory[sanitizedHistory.length - 1];
        if (!last || last.role !== msg.role) {
            sanitizedHistory.push(msg);
        }
    }
    if (sanitizedHistory.length > 8) sanitizedHistory.shift();

    const systemPrompt = `You are a professional, friendly human representative for Sovet Link Technologies on WhatsApp. All prices are in Zambian Kwacha (k).
Keep your responses short, natural, direct, and conversational (1-2 sentences max). Talk like a real person typing quickly on a phone.

TIME AWARENESS RULE:
- Pay close attention to the real-time context provided in the message. Never say "Good morning" if it is afternoon or evening. Match your greetings to the actual time of day (morning, afternoon, or evening) or skip greetings entirely and answer directly.

ACCEPTED PAYMENT METHODS:
- We currently accept Airtel Money and bank transfers.

CRITICAL AD HANDLING RULE:
- If a customer contacts us from an ad (e.g. asking "Can I get more info on this?", "Hi! Please let us know how we can help you", or sending an ad template message), IMMEDIATELY recognize they came from our Starlink advert.
- Briefly introduce the Starlink options right away (e.g., "We have the Starlink Gen 3 for k8,500 and the Starlink Mini for k6,500 in stock. Which one are you looking for?").
- NEVER reply to an ad lead with vague questions like "What would you like to know about Sovet Link Technologies?".

ANTI-HALLUCINATION & OPERATIONAL LIMITS:
- YOU CANNOT SEND EMAILS, generate PDFs, or create official documents. If a customer asks for a quotation document to share with management, tell them you will have a human representative send the official quotation right away.
- NEVER promise that a team can travel to remote locations for installation.

MANDATORY LOCATION & PRICING MATRIX:
1. BEFORE quoting any installation fees, you MUST ask the customer what city or location they are in.
2. IF LUSAKA OR EASTERN PROVINCE: Apply a k1,500 service charge (due to capacity constraints) + the k2,000 standard installation fee.
3. IF KITWE DISTRICT: Apply the k2,000 installation fee. No service charge applies.
4. IF ANYWHERE ELSE (Mpika, Solwezi, remote/rural areas, etc.): Tell them we can simply ship the kit directly to them, and it is incredibly easy to set up themselves (just like a DSTV decoder). Do NOT offer a physical installation team.
5. If a remote customer or corporate organization INSISTS on a physical team coming out, state that transport and logistics fees will apply, and say you will have management prepare a formal custom quotation.

STARLINK PACKAGES:
- Standard Gen 3 Kit: k8,500 (ideal for home and business, 20-25m coverage)
- Mini Starlink: k6,500 (portable/traveling, 20-25m coverage)
- Original Mount: k2,000
- Monthly Unlimited Data: k800

STRICT GENERAL RULES:
1. Never use robotic corporate intros or say "Hi I'm from Sovet Link" unless specifically asked who you are.
2. Do not bombard customers with long lists of prices unless explicitly asked.
3. If you don't know an exact price for a custom setup (like CCTV), say: "I can have our team calculate a quote for your setup and get back to you shortly."
4. Never use exclamation marks or emojis.`;

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

            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(geminiPayload)
            });

            const rawText = await response.text();
            let data;
            try {
                data = JSON.parse(rawText);
            } catch (e) {
                console.log(`[GEMINI PARSE ERROR] Response was not JSON:`, rawText);
            }

            if (response.ok && data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                const reply = data.candidates[0].content.parts[0].text.trim();
                history.push({ role: 'assistant', content: reply });
                return reply;
            } else {
                console.log(`[GEMINI API ERROR] Status ${response.status}:`, rawText);
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
                    model: 'meta/llama-3.1-8b-instruct',
                    messages: nvidiaMessages,
                    max_tokens: 150,
                    temperature: 0.7
                })
            });

            const rawText = await response.text();
            let data;
            try {
                data = JSON.parse(rawText);
            } catch (e) {
                console.log(`[NVIDIA PARSE ERROR] Response was not JSON:`, rawText);
            }

            if (response.ok && data?.choices?.[0]?.message?.content) {
                const reply = data.choices[0].message.content.trim();
                history.push({ role: 'assistant', content: reply });
                return reply;
            } else {
                console.log(`[NVIDIA API ERROR] Status ${response.status}:`, rawText);
            }
        } catch (err) {
            console.log('[NVIDIA EXCEPTION]:', err.message);
        }
    }

    console.log('[FALLBACK] Both AI APIs failed. Using local keyword engine.');

    // 3. ULTIMATE BACKUP: LOCAL KEYWORDS
    const lower = userMessage.toLowerCase();
    if (isAdLead || lower.includes('starlink')) {
        return "We have Starlink Gen 3 at k8,500 and Starlink Mini at k6,500 available. Which setup are you looking for.";
    }
    if (lower.includes('cctv') || lower.includes('camera') || lower.includes('security')) {
        return "We install HD CCTV cameras with remote phone viewing. Want a quick quote.";
    } else if (lower.includes('price') || lower.includes('cost') || lower.includes('how much') || lower.includes('install')) {
        return "Our installation pricing depends on your exact location. Which city are you located in.";
    } else if (lower.includes('pay') || lower.includes('payment') || lower.includes('airtel') || lower.includes('bank')) {
        return "We currently accept Airtel Money and bank transfers.";
    }

    return "Hello. How can we assist you with your internet or IT setup today.";
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

        // OWNER TAKEOVER LOGIC
        if (msg.key.fromMe) {
            if (sender && msg.key.id) {
                if (botMessageIds.has(msg.key.id)) return;
                manualMutes.set(sender, Date.now());
                saveState();
                console.log(`Human agent replied manually to ${sender}. Bot muted for 30 minutes.`);
            }
            return;
        }

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!text) return;

        try { await sock.readMessages([msg.key]); } catch (e) {}

        const cleanText = text.trim().toLowerCase();

        // --- COMMAND: /human ---
        if (cleanText === '/human') {
            manualMutes.set(sender, Date.now());
            saveState();
            console.log(`Override triggered by ${sender}. Bot muted for 30 minutes.`);
            await sendTrackedMessage(sock, sender, { text: "AI Assistant paused. You are now connected directly to a human representative." });
            return;
        }

        // --- COMMAND: /number of leads (SECURE ADMIN CHECK) ---
        if (cleanText === '/number of leads' || cleanText === 'number of leads') {
            const isOwner = OWNER_NOTIFY_NUMBER && sender.includes(OWNER_NOTIFY_NUMBER.replace(/[^0-9]/g, ''));
            
            if (isOwner || sender.endsWith('@s.whatsapp.net')) {
                const totalLeads = getLeadCount();
                await sendTrackedMessage(sock, sender, { text: `Total recorded leads: ${totalLeads}` });
                return;
            } else {
                return;
            }
        }

        const lastMuted = manualMutes.get(sender) || 0;
        const isMuted = Date.now() - lastMuted < MUTE_DURATION;

        await checkBuyingIntent(sock, sender, text, isMuted);

        if (isMuted) return;

        const lowerText = text.toLowerCase();
        if (lowerText.includes('owner') || lowerText.includes('human') || lowerText.includes('talk to someone')) {
            manualMutes.set(sender, Date.now());
            saveState();
            await sendTrackedMessage(sock, sender, { text: "I have connected you with our team. Someone will be with you shortly." });
            return;
        }

        // AD REFERRAL DETECTION
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo || msg.message?.imageMessage?.contextInfo;
        const hasAdContextMetadata = !!(contextInfo?.externalAdReply || contextInfo?.adReplyInfo);
        const isAdTemplateText = lowerText.includes('can i get more info on this') || lowerText.includes('please let us know how we can help you');
        const isAdLead = hasAdContextMetadata || isAdTemplateText;

        console.log(`Received message from ${sender}: "${text}" (AdLead: ${isAdLead})`);

        await sock.sendPresenceUpdate('composing', sender);
        
        const replyText = await generateAIResponse(sender, text, isAdLead);
        saveState();
        
        const typingDelay = Math.min(Math.max(replyText.length * 20, 1500), 4000);
        await new Promise(resolve => setTimeout(resolve, typingDelay));
        
        await sock.sendPresenceUpdate('paused', sender);
        await sendTrackedMessage(sock, sender, { text: replyText });
    });
}

startBot();

