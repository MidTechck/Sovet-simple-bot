require('dotenv').config();
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || '';
const OWNER_NOTIFY_NUMBER = process.env.OWNER_NOTIFY_NUMBER || '';
const OWNER_DIRECT_LINE = process.env.OWNER_DIRECT_LINE || '';

const GEMINI_MODELS = [
    'gemini-2.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.7-flash'
];

const NVIDIA_MODELS = [
    'meta/llama-3.1-8b-instruct',
    'nvidia/llama-3.1-nemotron-nano-8b-v1'
];

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '.';
const AUTH_DIR = path.join(DATA_DIR, 'auth_info_baileys');
const STATE_FILE = path.join(DATA_DIR, 'bot_state.json');
const LEADS_FILE = path.join(DATA_DIR, 'leads.log');

const app = express();
const PORT = process.env.PORT || 8080;
let qrCodeDataUrl = '';
let isConnected = false;
let currentSock = null;

app.get('/', (req, res) => {
    if (isConnected) {
        return res.send('<h2 style="font-family:sans-serif;text-align:center;margin-top:40px;">Bot is connected</h2>');
    }
    if (qrCodeDataUrl) {
        return res.send(`
            <html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
            <body style="font-family:Arial;text-align:center;margin-top:40px;">
                <h2>Scan QR Code with WhatsApp</h2>
                <p>Linked Devices → Link a Device</p>
                <img src="${qrCodeDataUrl}" style="max-width:300px">
            </body></html>
        `);
    }
    return res.send('<h2 style="font-family:sans-serif;text-align:center;margin-top:40px;">Waiting for QR...</h2>');
});
app.listen(PORT, () => console.log(`Web server on port ${PORT}`));

const manualMutes = new Map();
const MUTE_DURATION = 30 * 60 * 1000;
const customers = new Map();
const MAX_HISTORY = 12;
const botMessageIds = new Set();
const lastLeadAlert = new Map();
const LEAD_ALERT_COOLDOWN = 20 * 60 * 1000;

function digitsOnly(value) {
    return String(value || '').replace(/\D/g, '');
}

function getPhoneFromMessage(msg) {
    const key = msg?.key || {};
    const candidates = [
        key.remoteJidAlt,
        key.senderPn,
        key.participantPn,
        key.remoteJid,
        msg.senderPn
    ];

    for (const candidate of candidates) {
        if (!candidate) continue;
        if (String(candidate).endsWith('@g.us')) continue;
        const digits = digitsOnly(candidate);
        if (digits.length >= 10 && digits.length <= 15) return digits;
    }

    const fallback = digitsOnly(key.remoteJid);
    return fallback || null;
}

function getOrCreateCustomer(phone) {
    if (!customers.has(phone)) {
        customers.set(phone, {
            memory: {
                name: null,
                location: null,
                service: null,
                quotation: null,
                status: 'new',
                notes: '',
                lastSummary: '',
                updatedAt: new Date().toISOString()
            },
            history: []
        });
    }
    return customers.get(phone);
}

function addToHistory(phone, role, content, isHuman = false) {
    if (!phone || !content) return;
    const customer = getOrCreateCustomer(phone);
    const last = customer.history[customer.history.length - 1];
    if (last && last.role === role && last.content === content) return;

    customer.history.push({
        role,
        content,
        isHuman,
        timestamp: new Date().toISOString()
    });
    if (customer.history.length > MAX_HISTORY) {
        customer.history.splice(0, customer.history.length - MAX_HISTORY);
    }
    customer.memory.updatedAt = new Date().toISOString();
}

function generateMessageID() {
    return crypto.randomBytes(16).toString('hex').toUpperCase();
}

async function sendTrackedMessage(sock, jid, content) {
    const messageId = generateMessageID();
    botMessageIds.add(messageId);
    if (botMessageIds.size > 300) {
        const first = botMessageIds.values().next().value;
        botMessageIds.delete(first);
    }
    return sock.sendMessage(jid, content, { messageId });
}

function sanitizeReply(text) {
    let cleaned = String(text || '').replace(/!+/g, '.');
    cleaned = cleaned.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '');
    cleaned = cleaned.replace(/\.{2,}/g, '.').replace(/[ \t]{2,}/g, ' ').trim();
    return cleaned;
}

function loadState() {
    try {
        const raw = fs.readFileSync(STATE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.customers) {
            for (const [phone, data] of Object.entries(parsed.customers)) {
                customers.set(phone, data);
            }
        }
        if (parsed.manualMutes) {
            for (const [k, v] of Object.entries(parsed.manualMutes)) {
                manualMutes.set(k, v);
            }
        }
        console.log(`Restored ${customers.size} customers`);
    } catch (e) {
        console.log('No previous state, starting fresh');
    }
}

function saveState() {
    try {
        const data = {
            customers: Object.fromEntries(customers),
            manualMutes: Object.fromEntries(manualMutes)
        };
        fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.log('[SAVE ERROR]', e.message);
    }
}

loadState();

const BUYING_INTENT_KEYWORDS = [
    'price', 'cost', 'how much', 'quote', 'quotation', 'book', 'order',
    'buy', 'purchase', 'interested', 'install', 'schedule', 'appointment', 'deposit', 'pay'
];

const AD_LEAD_GREETING = `Hi. Thanks for your interest in Starlink.

Current offer:
Starlink Kit: K8,500
Original Mount: K2,000
Monthly Unlimited: K800
Installation: K1,500 within Lusaka & Copperbelt`;

function logLead(sender, text) {
    try {
        fs.appendFileSync(LEADS_FILE, `${new Date().toISOString()} | ${digitsOnly(sender)} | ${text}\n`);
    } catch (e) {}
}

async function checkBuyingIntent(sock, sender, text, isMuted, isAdLead = false) {
    const lower = text.toLowerCase();
    if (!BUYING_INTENT_KEYWORDS.some(k => lower.includes(k)) && !isAdLead) return;

    logLead(sender, text);
    if (isMuted || !OWNER_NOTIFY_NUMBER) return;

    const last = lastLeadAlert.get(sender) || 0;
    if (Date.now() - last < LEAD_ALERT_COOLDOWN) return;
    lastLeadAlert.set(sender, Date.now());

    try {
        await sendTrackedMessage(sock, OWNER_NOTIFY_NUMBER, {
            text: `New potential sale\nClient: ${digitsOnly(sender)}\nMessage: ${text}`
        });
    } catch (e) {}
}

function buildRecentHistory(phone, userMessage) {
    const customer = getOrCreateCustomer(phone);
    const recent = customer.history.slice(-MAX_HISTORY).map(h => ({
        role: h.role,
        content: h.content
    }));
    if (recent.length === 0 || recent[recent.length - 1].content !== userMessage) {
        recent.push({ role: 'user', content: userMessage });
    }
    return recent;
}

function buildMemoryBlock(phone) {
    const memory = getOrCreateCustomer(phone).memory;
    let block = 'CUSTOMER MEMORY:\n';
    if (memory.name) block += `Name: ${memory.name}\n`;
    if (memory.location) block += `Location: ${memory.location}\n`;
    if (memory.service) block += `Service: ${memory.service}\n`;
    if (memory.quotation) block += `Quotation: ${memory.quotation}\n`;
    if (memory.status) block += `Status: ${memory.status}\n`;
    if (memory.notes) block += `Notes: ${memory.notes}\n`;
    if (memory.lastSummary) block += `Last summary: ${memory.lastSummary}\n`;
    if (block === 'CUSTOMER MEMORY:\n') block += 'No previous information stored yet.\n';
    return block;
}

function smartFallback(phone, userMessage, isAdLead) {
    const recent = buildRecentHistory(phone, userMessage);
    const joined = recent.map(m => m.content).join(' ').toLowerCase();
    const current = userMessage.toLowerCase();

    if (isAdLead || joined.includes('starlink') || current.includes('gen 3') || current.includes('mini')) {
        if (current.includes('mini')) return 'Starlink Mini is K6,500. Installation depends on your city. Are you in Lusaka or Copperbelt.';
        if (current.includes('gen 3') || joined.includes('gen 3')) {
            if (joined.includes('lusaka')) return 'Starlink Gen 3 is K8,500. In Lusaka installation is K1,500 and the original mount is K2,000. Should I continue with that package.';
            return 'Starlink Gen 3 is K8,500. Which city are you in so I can confirm the installation fee.';
        }
        return 'We have Starlink Gen 3 at K8,500 and Mini at K6,500. Which one are you interested in.';
    }
    if (current.includes('price') || current.includes('cost') || current.includes('how much')) {
        return 'Pricing depends on your location. Which city are you in.';
    }
    if (recent.length > 1) {
        return 'Yes, I am still with you. Please continue.';
    }
    return 'Hello. How can we help you today.';
}

async function callGemini(systemPrompt, recent) {
    if (!GEMINI_API_KEY) {
        console.log('[GEMINI] No API key set');
        return null;
    }

    const payload = {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: recent.map(h => ({
            role: h.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: h.content }]
        }))
    };

    for (const model of GEMINI_MODELS) {
        try {
            const res = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/\( {model}:generateContent?key= \){GEMINI_API_KEY}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                }
            );
            const raw = await res.text();
            let data = {};
            try { data = JSON.parse(raw); } catch (e) {}

            const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (res.ok && text) {
                console.log(`[GEMINI] Success with ${model}`);
                return text.trim();
            }
            console.log(`[GEMINI] ${model} failed: ${res.status} ${raw.slice(0, 250)}`);
        } catch (e) {
            console.log(`[GEMINI] ${model} exception:`, e.message);
        }
    }
    return null;
}

async function callNvidia(systemPrompt, recent) {
    if (!NVIDIA_API_KEY) {
        console.log('[NVIDIA] No API key set');
        return null;
    }

    const messages = [{ role: 'system', content: systemPrompt }, ...recent];

    for (const model of NVIDIA_MODELS) {
        try {
            const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${NVIDIA_API_KEY}`
                },
                body: JSON.stringify({
                    model,
                    messages,
                    max_tokens: 150,
                    temperature: 0.4
                })
            });
            const raw = await res.text();
            let data = {};
            try { data = JSON.parse(raw); } catch (e) {}

            const text = data?.choices?.[0]?.message?.content;
            if (res.ok && text) {
                console.log(`[NVIDIA] Success with ${model}`);
                return text.trim();
            }
            console.log(`[NVIDIA] ${model} failed: ${res.status} ${raw.slice(0, 250)}`);
        } catch (e) {
            console.log(`[NVIDIA] ${model} exception:`, e.message);
        }
    }
    return null;
}

async function generateAIResponse(phone, userMessage, isAdLead = false) {
    const recent = buildRecentHistory(phone, userMessage);
    const memoryBlock = buildMemoryBlock(phone);

    const systemPrompt = `You are a professional human representative of Sovet Link Technologies in Zambia.
Keep replies short: 1 or 2 sentences only.

${memoryBlock}

Use the recent conversation. Do not restart the chat.
If the customer already said they want Starlink Gen 3, continue from that. Do not say hello again.

STRICT RULES:
- Never use emojis or exclamation marks.
- Never invent prices, links, or past conversations.
- If the customer refers to a previous discussion that is NOT in memory and NOT in recent messages, reply exactly:
  "Let me connect you with the team so they can assist you properly."
- Before giving installation price you must know the city.
- Pricing:
  Lusaka / Eastern: K1,500 service + K2,000 mount if needed
  Kitwe / Copperbelt: K2,000 installation
  Other areas: special arrangement needed
- Packages: Gen 3 Kit K8,500 | Mini K6,500 | Mount K2,000 | Monthly K800
- Payment: Airtel Money or bank transfer only.
${OWNER_DIRECT_LINE ? `- If handing over, they can also call ${OWNER_DIRECT_LINE}.` : ''}
${isAdLead ? 'This is an ad lead. Briefly introduce the Starlink options.' : ''}`;

    const geminiReply = await callGemini(systemPrompt, recent);
    if (geminiReply) return geminiReply;

    const nvidiaReply = await callNvidia(systemPrompt, recent);
    if (nvidiaReply) return nvidiaReply;

    console.log('[AI] Both APIs failed, using smart fallback');
    return smartFallback(phone, userMessage, isAdLead);
}

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
        syncFullHistory: true
    });

    currentSock = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messaging-history.set', ({ messages }) => {
        if (!messages || !messages.length) return;
        console.log(`History sync received: ${messages.length} messages`);

        let stored = 0;
        for (const msg of messages) {
            try {
                const phone = getPhoneFromMessage(msg);
                if (!phone) continue;

                const customer = getOrCreateCustomer(phone);
                if (customer.history.length >= MAX_HISTORY) continue;

                const text = msg.message?.conversation ||
                             msg.message?.extendedTextMessage?.text ||
                             msg.message?.imageMessage?.caption;
                if (!text) continue;

                addToHistory(phone, msg.key.fromMe ? 'assistant' : 'user', text, !!msg.key.fromMe);
                stored += 1;
            } catch (e) {}
        }
        if (stored) saveState();
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrcode.toDataURL(qr, (err, url) => {
                if (!err) {
                    qrCodeDataUrl = url;
                    console.log('QR ready');
                }
            });
        }

        if (connection === 'open') {
            console.log('Connected to WhatsApp');
            isConnected = true;
            qrCodeDataUrl = '';
        } else if (connection === 'close') {
            isConnected = false;
            const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log('Disconnected:', code);
            if ([DisconnectReason.loggedOut, 401, 403, 405].includes(code)) {
                try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {}
            }
            setTimeout(startBot, 4000);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;

        const sender = msg.key.remoteJid;
        if (!sender || sender.endsWith('@g.us')) return;

        const phone = getPhoneFromMessage(msg);
        if (!phone) return;

        const text = msg.message.conversation ||
                     msg.message.extendedTextMessage?.text ||
                     msg.message.imageMessage?.caption;

        if (msg.key.fromMe) {
            if (botMessageIds.has(msg.key.id)) return;
            if (text) {
                addToHistory(phone, 'assistant', text, true);
                manualMutes.set(sender, Date.now());
                saveState();
                console.log(`Human message saved for ${phone}`);
            }
            return;
        }

        if (!text) return;
        try { await sock.readMessages([msg.key]); } catch (e) {}

        const lower = text.trim().toLowerCase();
        const isOwner = OWNER_NOTIFY_NUMBER && sender.includes(digitsOnly(OWNER_NOTIFY_NUMBER));

        if (isOwner && lower.startsWith('/note ')) {
            const parts = text.trim().slice(6).split(' ');
            const target = digitsOnly(parts[0]);
            const note = parts.slice(1).join(' ');
            if (target && note) {
                const c = getOrCreateCustomer(target);
                c.memory.notes = c.memory.notes ? c.memory.notes + ' | ' + note : note;
                c.memory.updatedAt = new Date().toISOString();
                saveState();
                await sendTrackedMessage(sock, sender, { text: `Note saved for ${target}` });
            }
            return;
        }

        if (isOwner && (lower === '/number of leads' || lower === 'number of leads')) {
            let total = 0;
            try {
                if (fs.existsSync(LEADS_FILE)) {
                    total = fs.readFileSync(LEADS_FILE, 'utf8').split('\n').filter(l => l.trim()).length;
                }
            } catch (e) {}
            await sendTrackedMessage(sock, sender, { text: `Total recorded leads: ${total}` });
            return;
        }

        addToHistory(phone, 'user', text, false);

        if (lower === '/human') {
            manualMutes.set(sender, Date.now());
            saveState();
            await sendTrackedMessage(sock, sender, { text: 'AI paused. You are now connected with the team.' });
            return;
        }

        const ctx = msg.message?.extendedTextMessage?.contextInfo || msg.message?.imageMessage?.contextInfo;
        const isAdLead = !!(ctx?.externalAdReply || ctx?.adReplyInfo) ||
                         lower.includes('can i get more info on this');

        const isMuted = Date.now() - (manualMutes.get(sender) || 0) < MUTE_DURATION;
        await checkBuyingIntent(sock, sender, text, isMuted, isAdLead);
        if (isMuted) return;

        if (lower.includes('owner') || lower.includes('human') || lower.includes('talk to someone')) {
            manualMutes.set(sender, Date.now());
            saveState();
            await sendTrackedMessage(sock, sender, { text: 'I have connected you with the team.' });
            return;
        }

        if (lower.includes('can i get more info on this')) {
            await sock.sendPresenceUpdate('composing', sender);
            await new Promise(r => setTimeout(r, 1800));
            await sendTrackedMessage(sock, sender, { text: AD_LEAD_GREETING });
            addToHistory(phone, 'assistant', AD_LEAD_GREETING, false);
            saveState();
            return;
        }

console.log(`From ${phone}: ${text}`);
        await sock.sendPresenceUpdate('composing', sender);

        const raw = await generateAIResponse(phone, text, isAdLead);
        const reply = sanitizeReply(raw);

        if (reply.toLowerCase().includes('connect you with the team')) {
            manualMutes.set(sender, Date.now());
        }

        addToHistory(phone, 'assistant', reply, false);
        saveState();

        await new Promise(r => setTimeout(r, Math.min(Math.max(reply.length * 18, 1200), 3200)));
        await sock.sendPresenceUpdate('paused', sender);
        await sendTrackedMessage(sock, sender, { text: reply });
    });
}

startBot();
