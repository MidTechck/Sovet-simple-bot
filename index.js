import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import pino from 'pino';
import dotenv from 'dotenv';

dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;

// Track manual owner replies to pause the bot temporarily
const manualMutes = new Map(); // senderNumber -> timestamp
const MUTE_DURATION = 45 * 60 * 1000; // 45 minutes

// In-memory conversation history store for contextual awareness
const chatHistories = new Map(); // senderNumber -> array of messages

// Helper function for typing delay
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- AI GENERATION WITH MULTI-TIER FALLBACK ---
async function generateAIResponse(senderNumber, userMessage) {
    // Maintain chat history (last 6 turns for context)
    if (!chatHistories.has(senderNumber)) {
        chatHistories.set(senderNumber, []);
    }
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
            console.log('Gemini API failed, falling back to Nvidia...', err.message);
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
            console.log('Nvidia API failed, falling back to keywords...', err.message);
        }
    }

    // 3. ULTIMATE BACKUP: LOCAL KEYWORDS
    const lower = userMessage.toLowerCase();
    if (lower.includes('cctv') || lower.includes('camera')) {
        return "We install HD CCTV cameras with remote phone viewing. Want a quick quote?";
    } else if (lower.includes('starlink') || lower.includes('internet')) {
        return "We do full Starlink installations and network extensions. Are you looking to set up a new dish?";
    } else if (lower.includes('price') || lower.includes('cost')) {
        return "Our pricing depends on your exact setup. Would you like a technician to assess your site?";
    } else if (lower.includes('hello') || lower.includes('hi') || lower.includes('hey')) {
        return "Hey there! How can we help you with your security or IT systems today?";
    }

    return "Thanks for reaching out! Let me connect you with the owner to assist you further.";
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            console.log('Bot connected successfully!');
        } else if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting...', shouldReconnect);
            if (shouldReconnect) startBot();
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;

        const sender = msg.key.remoteJid;

        // If the owner replies manually in WhatsApp, pause the bot for this chat
        if (msg.key.fromMe) {
            if (sender) {
                manualMutes.set(sender, Date.now());
            }
            return;
        }

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!text) return;

        // Check if bot is currently muted due to owner taking over
        const lastMuted = manualMutes.get(sender) || 0;
        if (Date.now() - lastMuted < MUTE_DURATION) {
            return;
        }

        // Check for human handover triggers from customer
        if (text.toLowerCase().includes('owner') || text.toLowerCase().includes('human') || text.toLowerCase().includes('talk to someone')) {
            manualMutes.set(sender, Date.now() + (2 * 60 * 60 * 1000)); // Mute for 2 hours
            await sock.sendMessage(sender, { text: "I've connected you with the owner. Someone from our team will be with you shortly." });
            return;
        }

        // Simulate typing delay (2.5 seconds) so it feels natural and avoids WhatsApp spam triggers
        await sock.sendPresenceUpdate('composing', sender);
        await delay(2500);

        // Generate response using Gemini / Nvidia / Keywords
        const replyText = await generateAIResponse(sender, text);
        
        await sock.sendMessage(sender, { text: replyText });
    });
}

startBot();

