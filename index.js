require('dotenv').config();
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8080;

let qrCodeData = '';
let isConnected = false;
let currentSock = null;

const userSessions = {};

// Response pools with 3+ natural variations. Strictly NO emojis and NO exclamation marks (!)
const responsePools = {
    morning: [
        "Good morning. How can I assist you with your inquiry today.",
        "Morning. What can I help you with right now.",
        "Good morning to you. Let me know what you need help with."
    ],
    afternoon: [
        "Good afternoon. How may I help you today.",
        "Afternoon. What can our team assist you with.",
        "Good afternoon. Feel free to share what you are looking for."
    ],
    evening: [
        "Good evening. How can I help you tonight.",
        "Evening. Let me know what you need assistance with.",
        "Good evening. What project or inquiry do you have."
    ],
    general_greeting: [
        "Hello. How can I assist you today.",
        "Hi there. What can I help you with.",
        "Greetings. How may our team support you."
    ],
    starlink: [
        "We handle professional Starlink installations for homes and offices.",
        "Our team provides complete Starlink setup and signal alignment services.",
        "We specialize in deploying Starlink systems for reliable high-speed internet connectivity."
    ],
    starlink_price: [
        "Starlink hardware starts around K9,000 for Gen 3 and K6,800 for Mini, while monthly unlimited packages start from K800.",
        "For pricing, our Starlink hardware packages begin at K6,800, and monthly unlimited data starts at K800.",
        "Hardware costs start from K6,800 for the Mini and K9,000 for Gen 3, with monthly services starting at K800."
    ],
    cctv: [
        "We supply and install professional CCTV security camera systems for residential and commercial premises.",
        "Our CCTV services include full installation and mobile phone remote viewing configuration.",
        "We set up secure CCTV surveillance systems tailored to your specific property requirements."
    ],
    cctv_price: [
        "CCTV pricing depends on the number of cameras and property layout, so we usually evaluate the site first.",
        "Costs for CCTV systems vary based on your specific setup requirements and camera count.",
        "We provide custom pricing for CCTV installations after assessing your property size."
    ],
    network: [
        "We offer professional networking solutions, structured cabling, LAN setups, and ongoing IT support.",
        "Our IT team handles office networking, structured cabling, and technical troubleshooting.",
        "We provide robust network setup and IT support services for businesses."
    ],
    network_price: [
        "IT support and network setup pricing depends on the scale of the infrastructure required.",
        "We evaluate network cabling and setup needs before providing a precise quotation.",
        "Costs for network installations vary based on office size and equipment requirements."
    ],
    payment: [
        "Please note that payments are not processed automatically here. Our team will verify and confirm your details manually.",
        "Our team handles payment verifications offline to ensure complete security before confirmation.",
        "Kindly share your payment details, and our team will review and confirm everything shortly."
    ],
    thanks: [
        "You are welcome. Let me know if you need anything else.",
        "Glad I could help. Reach out if you have more questions.",
        "Anytime. We are always here to assist."
    ],
    farewell: [
        "Goodbye. Have a great day ahead.",
        "Take care. Feel free to reach out whenever you need assistance.",
        "Bye for now. Have a wonderful day."
    ],
    fallback: [
        "Could you please clarify what specific service or information you are looking for.",
        "I want to make sure I understand correctly. Could you provide a bit more detail.",
        "Let me know more about what you need so I can guide you properly."
    ]
};

function getRandomReply(category) {
    const pool = responsePools[category] || responsePools.fallback;
    const randomIndex = Math.floor(Math.random() * pool.length);
    return pool[randomIndex];
}

function getTimeBasedGreeting() {
    const hour = new Date().getHours();
    if (hour < 12) return getRandomReply('morning');
    if (hour < 17) return getRandomReply('afternoon');
    return getRandomReply('evening');
}

function processMessage(sender, text) {
    const lower = text.toLowerCase();

    if (!userSessions[sender]) {
        userSessions[sender] = { messageCount: 0, firstContact: true, pausedUntil: 0 };
    }
    userSessions[sender].messageCount += 1;

    // 1. Payment / Buying safeguard
    if (lower.includes('pay') || lower.includes('buy') || lower.includes('deposit') || lower.includes('transfer') || lower.includes('send money') || lower.includes('paid')) {
        return getRandomReply('payment');
    }

    // 2. Greetings
    if (lower.includes('morning')) return getRandomReply('morning');
    if (lower.includes('afternoon')) return getRandomReply('afternoon');
    if (lower.includes('evening')) return getRandomReply('evening');
    if (lower.includes('hi') || lower.includes('hello') || lower.includes('hey') || lower.includes('greetings') || lower.includes('how are you')) {
        if (userSessions[sender].firstContact) {
            userSessions[sender].firstContact = false;
            return getTimeBasedGreeting();
        }
        return getRandomReply('general_greeting');
    }

    // 3. Thanks & Farewell
    if (lower.includes('thank') || lower.includes('thx') || lower.includes('appreciate')) {
        return getRandomReply('thanks');
    }
    if (lower.includes('bye') || lower.includes('goodbye') || lower.includes('see you') || lower.includes('later')) {
        return getRandomReply('farewell');
    }

    // 4. Pricing vs Services Check
    const asksPrice = lower.includes('price') || lower.includes('cost') || lower.includes('how much') || lower.includes('fee') || lower.includes('rates') || lower.includes('K');

    const mentionsStarlink = lower.includes('starlink') || lower.includes('dish') || lower.includes('internet');
    const mentionsCCTV = lower.includes('cctv') || lower.includes('camera') || lower.includes('security');
    const mentionsNetwork = lower.includes('network') || lower.includes('cabling') || lower.includes('lan') || lower.includes('wifi') || lower.includes('it support') || lower.includes('router');

    let replies = [];

    if (mentionsStarlink) {
        replies.push(asksPrice ? getRandomReply('starlink_price') : getRandomReply('starlink'));
    }
    if (mentionsCCTV) {
        replies.push(asksPrice ? getRandomReply('cctv_price') : getRandomReply('cctv'));
    }
    if (mentionsNetwork) {
        replies.push(asksPrice ? getRandomReply('network_price') : getRandomReply('network'));
    }

    if (replies.length > 0) {
        return replies.join(" ");
    }

    return getRandomReply('fallback');
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
        if (!msg.message) return;

        const sender = msg.key.remoteJid;

        if (!userSessions[sender]) {
            userSessions[sender] = { messageCount: 0, firstContact: true, pausedUntil: 0 };
        }

        // HUMAN TAKEOVER GUARD: If YOU or a team member sends a message in this chat, 
        // mute the bot for this user for 30 minutes so you can chat freely without the bot interfering.
        if (msg.key.fromMe) {
            userSessions[sender].pausedUntil = Date.now() + (30 * 60 * 1000);
            console.log(`Human agent active in chat ${sender}. Bot paused for 30 minutes.`);
            return;
        }

        // If the bot is currently paused because a human is handling the chat, ignore incoming messages completely
        if (userSessions[sender].pausedUntil > Date.now()) {
            console.log(`Bot is currently muted for ${sender} due to active human conversation.`);
            return;
        }

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        if (!text) return;

        console.log(`Received message from ${sender}: "${text}"`);
        
        // Smart delay & typing animation
        await sock.sendPresenceUpdate('composing', sender);

        const replyText = processMessage(sender, text);
        
        const typingDelay = Math.min(Math.max(replyText.length * 20, 1500), 4000);
        await new Promise(resolve => setTimeout(resolve, typingDelay));
        
        await sock.sendPresenceUpdate('paused', sender);
        await sock.sendMessage(sender, { text: replyText });
    });
}

app.get('/', async (req, res) => {
    if (isConnected) {
        return res.send('<h1 style="color:green; text-align:center; margin-top:20vh; font-family:sans-serif;">Bot is successfully connected to WhatsApp!</h1>');
    }
    if (!qrCodeData) {
        return res.send(`
            <html>
            <head><meta http-equiv="refresh" content="3"></head>
            <body style="text-align:center; margin-top:20vh; font-family:sans-serif;">
                <h2>Initializing WhatsApp session and generating fresh QR code...</h2>
                <p>This page will auto-refresh in a moment.</p>
            </body>
            </html>
        `);
    }
    try {
        const url = await qrcode.toDataURL(qrCodeData);
        res.send(`
            <html>
            <head><meta http-equiv="refresh" content="12"></head>
            <body style="text-align:center; margin-top:6vh; font-family:sans-serif;">
                <h2>Scan QR Code to Link WhatsApp Bot</h2>
                <p>Open WhatsApp &gt; Linked Devices &gt; Link a Device</p>
                <img src="${url}" alt="WhatsApp QR Code" style="width:300px; height:300px; border:3px solid #25D366; border-radius:12px; padding:10px; background:white;" />
                <p style="color:gray; font-size:14px; margin-top:15px;">Page auto-refreshes to keep your QR session active.</p>
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

