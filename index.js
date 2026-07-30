import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import pino from 'pino';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;

// Track manual owner replies to pause the bot temporarily
const manualMutes = new Map(); // senderNumber -> timestamp
const MUTE_DURATION = 45 * 60 * 1000; // 45 minutes

// In-memory conversation history store for contextual awareness
const chatHistories = new Map(); // senderNumber -> array of messages

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
Services provided: CCTV cameras, access control systems, IT security services, and Starlink setups.`;

    // 1. TRY GEMINI API FIRST
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

    // 2. TRY NVIDIA API SECONDARY BACKUP
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

    // 3. KEYWORD FALLBACK (Ultimate Backup)
    const lower = userMessage.toLowerCase();
    if (lower.includes('cctv') || lower.includes('camera')) {
        return "We install HD CCTV cameras with remote phone viewing. Want a quick quote?";
    } else if (lower.includes('price') || lower.includes('cost')) {
        return "Our pricing depends on your exact setup. Would you like a technician to visit and assess?";
    } else if (lower.includes('hello') || lower.includes('hi')) {
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

    sock.udarstven?.('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, qr } = update;
        if (connection === 'open') {
            console.log('Bot connected successfully!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) {
            // If owner replied manually, mute the bot for this chat
            if (msg.key.fromMe && msg.key.remoteJid) {
                manualMutes.set(msg.key.remoteJid, Date.now());
            }
            return;
        }

        const sender = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!text) return;

        // Check if owner recently took over manually
        const lastMuted = manualMutes.get(sender) || 0;
        if (Date.now() - lastMuted < MUTE_DURATION) {
            return; // Bot stays stepped down while owner is handling it
        }

        // Check for manual handover triggers from customer
        if (text.toLowerCase().includes('owner') || text.toLowerCase().includes('human')) {
            manualMutes.set(sender, Date.now() + (2 * 60 * 60 * 1000)); // Mute for 2 hours
            await sock.sendMessage(sender, { text: "I've connected you with the owner. Someone from our team will be with you shortly." });
            return;
        }

        // Send typing indicator and generate natural response
        await sock.sendPresenceUpdate('composing', sender);
        const replyText = await generateAIResponse(sender, text);
        
        await sock.sendMessage(sender, { text: replyText });
    });
}

startBot();

