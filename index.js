require('dotenv').config();
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

// Persistent storage configuration for Railway volumes
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || './data';
const AUTH_DIR = path.join(DATA_DIR, 'auth_info_baileys');
const CHATS_DIR = path.join(DATA_DIR, 'chats');
const LEADS_FILE = path.join(DATA_DIR, 'leads.txt');

if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
if (!fs.existsSync(CHATS_DIR)) fs.mkdirSync(CHATS_DIR, { recursive: true });

let qrCodeData = '';
let isConnected = false;
let currentSock = null;

const userSessions = {};

// Expanded response pools with strictly NO emojis and NO exclamation marks (!)
const responsePools = {
    location: [
        "We are based in Lusaka Woodlands and Ndola, and we serve clients across Zambia. Would you like us to check coverage for your specific location.",
        "Our primary offices are located in Lusaka Woodlands and Ndola. Let us know your area so we can confirm our teams can reach you.",
        "We operate out of Lusaka and Ndola while handling projects nationwide. What town or neighborhood are you located in."
    ],
    hours: [
        "We operate from Monday to Sunday between 08:00 and 18:00. Are you looking to schedule a visit during these hours.",
        "Our team is available every day of the week from 08:00 to 18:00. Let me know what time works best for your schedule.",
        "We are open Monday through Sunday, 08:00 to 18:00 daily. Do you need assistance right now or for a future date."
    ],
    starlink_price: [
        "Starlink Gen 3 starts from K9,000 and Starlink Mini starts from K6,800. Would you like details on monthly data packages as well.",
        "Hardware pricing begins at K6,800 for the Mini and K9,000 for the Gen 3 kit. Are you interested in purchasing a unit for home or office use.",
        "We supply Starlink hardware starting from K6,800 for Mini models and K9,000 for Gen 3. Let me know which option fits your setup needs."
    ],
    starlink_monthly: [
        "Monthly unlimited internet packages start from K800. Would you like help choosing the right plan for your usage.",
        "Our monthly unlimited data plans begin at K800. Let me know if you need assistance with subscription renewals or setup.",
        "Monthly unlimited connectivity starts from K800 per month. Do you have a specific data speed or plan in mind."
    ],
    starlink_install: [
        "We handle complete Starlink installations, including proper roof mounting and precise signal alignment. Do you already have your kit ready.",
        "Our technicians provide full Starlink setup and structural mounting services. Where would you want the dish positioned on your property.",
        "We specialize in professional Starlink installation and cable routing. Shall I arrange for our team to assess your site."
    ],
    cctv: [
        "We supply and install professional CCTV camera security systems for homes, offices, shops, and schools. How many cameras do you need.",
        "Our team provides complete CCTV supply and installation tailored to your property layout. What specific areas around your premises do you want monitored.",
        "We set up secure CCTV surveillance solutions with clear night vision and local storage. Would you prefer an indoor or outdoor setup."
    ],
    cctv_price: [
        "CCTV pricing depends on the number of cameras and property layout, so we usually evaluate the site first. Can you share a few details about your property.",
        "Costs for CCTV systems vary based on camera count and cabling distance. Would you like us to schedule a site visit for an accurate quote.",
        "We provide customized pricing for CCTV installations after assessing your premises. How large is the area you wish to secure."
    ],
    cctv_phone: [
        "We configure all our CCTV installations for remote mobile phone viewing so you can monitor your property anywhere. Do you use an Android or iPhone device.",
        "Our security setups include linking your CCTV cameras directly to your smartphone app. Would you like this feature set up for multiple users.",
        "We ensure you can view your security cameras live on your phone with secure login credentials. Let me know if you need help with an existing camera setup."
    ],
    network: [
        "We offer professional networking solutions, structured cabling, LAN setups, and office Wi-Fi planning. How large is your office space.",
        "Our IT team handles enterprise network setups, cable management, and router configuration. What specific connectivity challenges are you experiencing.",
        "We provide robust structured cabling and wireless network deployments for businesses. Would you like a site survey for your office network."
    ],
    it_support: [
        "We offer ongoing IT support and technical troubleshooting for business infrastructure. What specific issue is your team facing right now.",
        "Our technical support team assists with hardware repairs, network diagnostics, and system maintenance. Can you describe the problem in more detail.",
        "We provide professional IT maintenance and troubleshooting services. Is this for a home network or a corporate office."
    ],
    supply_install: [
        "We supply and install both Starlink kits and CCTV equipment as part of our full service. Do you need us to provide the hardware or do you already have it.",
        "You can purchase equipment directly through us or have us install hardware you already own. Which option works best for you.",
        "We handle both hardware procurement and professional installation. Let me know what items you currently have on hand."
    ],
    upgrade: [
        "Yes, you can upgrade your Starlink plan or equipment later as your needs change. Would you like to discuss available upgrade options with our team.",
        "We assist clients with upgrading their internet plans and hardware components. What specific changes would you like to make to your current setup.",
        "Upgrading your Starlink subscription or hardware is quite straightforward. Shall I connect you with a specialist to review your account."
    ],
    support_after: [
        "Yes, we offer reliable support after installation. If you experience any issues, our team is always ready to help resolve them. Are you calling about a recent installation.",
        "We provide ongoing technical support and follow-up service after every project completion. What specific assistance do you need with your system.",
        "Our commitment continues long after installation with dedicated technical support. Let me know what issue you are encountering."
    ],
    booking: [
        "You can book a service through our online booking form or directly with our team here on WhatsApp. What date works best for your site visit.",
        "Scheduling an installation or consultation is easy. Shall I grab your details so our team can book you in.",
        "We arrange site visits and service bookings directly through our support desk. What service would you like to schedule today."
    ],
    payment: [
        "Please note that payments are not processed automatically here. Our team will verify and confirm your details manually before any work begins.",
        "Our team handles payment verifications offline to ensure complete security. Kindly share your transaction details, and we will review and confirm shortly.",
        "We require manual verification by our finance team for all payments to ensure safety. Let me know once you are ready to process your transaction."
    ],
    hardware_availability: [
        "We keep standard stock of both Starlink kits and CCTV camera packages ready for deployment. Are you looking to pick up hardware or have it delivered and installed.",
        "Our inventory is regularly stocked with immediate hardware supplies. Let me know the specific items you are looking for so I can confirm availability.",
        "We maintain steady hardware stock for quick deployments across our service zones. Do you need immediate supply or scheduling for next week."
    ],
    wifi_troubleshoot: [
        "If your Wi-Fi connection is dropping or slow, restarting your router and checking cable connections is a good first step. Are you using a router connected to Starlink or standard broadband.",
        "Network connection issues can often be resolved by power-cycling your equipment. Let me know what specific error or symptoms your network is showing.",
        "We help troubleshoot local Wi-Fi and routing issues. Is this affecting a single device or your entire office network."
    ],
    quote_request: [
        "To give you an accurate price quote, we usually look at the scope of work and location details. Can you share a brief description of what you want set up.",
        "We provide detailed quotations after gathering your project specifications. Tell me a bit about your property or business needs.",
        "Our team prepares customized quotes based on your exact site requirements. What specific services are you budgeting for."
    ],
    speed_test: [
        "If you are checking internet speeds, connecting directly via ethernet or standing close to the router helps get accurate readings. What speeds are you currently getting.",
        "We can guide you on running proper throughput tests on your Starlink or network connection. Let me know what download speeds register on your end."
    ],
    router_setup: [
        "We configure enterprise routers, access points, and mesh Wi-Fi systems for seamless coverage. What model of router are you using.",
        "Our engineers handle complete router and switch configurations for homes and offices. Do you need VLANs or guest networks set up."
    ],
    cable_repair: [
        "We offer professional cable repair, fiber splicing, and structured cabling re-termination. Where is the cable fault located.",
        "Damaged cables can severely degrade your network performance. Would you like our technicians to inspect and replace the faulty lines."
    ],
    wireless_bridge: [
        "We install long-range wireless bridges to connect multiple buildings or distant cameras without trenching. What distance do you need to bridge.",
        "Point-to-point wireless link setups are ideal for extending network coverage across properties. Tell me about the layout between your structures."
    ],
    power_backup: [
        "We supply and install UPS units and solar inverter power backups to keep your Starlink and CCTV running during power cuts. What is your power backup requirement.",
        "Uninterrupted power systems protect your security and internet infrastructure. Do you need backup power for just your router or your entire office."
    ],
    site_survey: [
        "Our team conducts physical site surveys to determine optimal dish placement and network coverage paths. Would you like to book a survey visit.",
        "A site survey ensures your installation is optimized for signal strength and security. When would you want our technicians to inspect your property."
    ],
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
    apology: [
        "No need to apologize at all. How can I assist you further with your project.",
        "That is completely fine. What else can our team help you with today.",
        "No worries at all. Let me know how we can proceed."
    ],
    company_info: [
        "We are Sovet Link Technologies, providing reliable IT infrastructure, Starlink internet, and CCTV solutions in Zambia. Would you like to know more about a specific service.",
        "Sovet Link Technologies specializes in professional networking, security systems, and high-speed Starlink setups. How can our team help you today.",
        "We are an IT infrastructure and connectivity firm based in Zambia. What kind of project are you working on."
    ],
    phone_contact: [
        "You can reach our team directly at +260 968 252 812 for immediate assistance. Would you like me to have someone call you back.",
        "Our direct line is +260 968 252 812. Feel free to give us a call whenever you are ready.",
        "You can call our support desk at +260 968 252 812 or chat with us right here. How else can we assist you."
    ],
    warranty: [
        "We assist with hardware troubleshooting and warranty support for installed systems. What specific equipment is giving you trouble.",
        "If you encounter any faulty hardware we supplied, our team will inspect and guide you on the replacement process. Can you describe the issue.",
        "We provide support for equipment maintenance and repairs. Let us know what component needs attention."
    ],
    urgent: [
        "For urgent technical assistance or network outages, please call our team directly at +260 968 252 812 so we can prioritize your request.",
        "If this is an urgent matter, calling our direct line at +260 968 252 812 is the fastest way to get immediate support.",
        "We treat urgent infrastructure issues with priority. Feel free to call us at +260 968 252 812 right away."
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

// Exact character-length based typing delay calculation
function getTypingDelay(text) {
    const len = text.length;
    if (len < 60) {
        return Math.floor((Math.random() * 0.3 + 1.5) * 1000);
    } else if (len <= 140) {
        return Math.floor((Math.random() * 0.2 + 1.9) * 1000);
    } else {
        return Math.floor((Math.random() * 0.1 + 2.2) * 1000);
    }
}

// File-based persistent conversation memory per client
function appendClientHistory(cleanNumber, role, messageText) {
    const filePath = path.join(CHATS_DIR, `${cleanNumber}.txt`);
    const timestamp = new Date().toLocaleString();
    const entry = `[${timestamp}] ${role.toUpperCase()}: "${messageText}"\n`;
    try {
        fs.appendFileSync(filePath, entry);
    } catch (err) {
        console.log('Failed to write client history file:', err);
    }
}

function logLead(sender, text, replyText) {
    const timestamp = new Date().toLocaleString();
    const cleanNumber = sender.replace('@s.whatsapp.net', '').replace(/[^0-9]/g, '');
    const logEntry = `----------------------------------------\n[${timestamp}] Client: +${cleanNumber}\nMessage: "${text}"\nBot Reply: "${replyText}"\n`;
    try {
        fs.appendFileSync(LEADS_FILE, logEntry + '\n');
    } catch (err) {
        console.log('Failed to write lead to file:', err);
    }
}

function processMessage(sender, text) {
    const lower = text.toLowerCase();

    if (!userSessions[sender]) {
        userSessions[sender] = { messageCount: 0, firstContact: true, pausedUntil: 0, lastCategory: null };
    }
    userSessions[sender].messageCount += 1;

    let matchedCategory = 'fallback';

    // 1. Apologies handling
    if (lower.includes('sorry') || lower.includes('apologize') || lower.includes('apologies') || lower.includes('pardon')) {
        matchedCategory = 'apology';
    }
    // 2. Payment / Buying safeguard
    else if (lower.includes('pay') || lower.includes('buy') || lower.includes('deposit') || lower.includes('transfer') || lower.includes('send money') || lower.includes('paid') || lower.includes('bank') || lower.includes('momo') || lower.includes('airtel money')) {
        matchedCategory = 'payment';
    }
    // 3. Urgent / Emergency
    else if (lower.includes('urgent') || lower.includes('emergency') || lower.includes('asap') || lower.includes('immediately') || lower.includes('down') || lower.includes('outage')) {
        matchedCategory = 'urgent';
    }
    // 4. Greetings
    else if (lower.includes('morning')) matchedCategory = 'morning';
    else if (lower.includes('afternoon')) matchedCategory = 'afternoon';
    else if (lower.includes('evening')) matchedCategory = 'evening';
    else if (lower.includes('hi') || lower.includes('hello') || lower.includes('hey') || lower.includes('greetings') || lower.includes('how are you')) {
        matchedCategory = 'general_greeting';
    }
    // 5. Thanks & Farewell
    else if (lower.includes('thank') || lower.includes('thx') || lower.includes('appreciate')) {
        matchedCategory = 'thanks';
    }
    else if (lower.includes('bye') || lower.includes('goodbye') || lower.includes('see you') || lower.includes('later')) {
        matchedCategory = 'farewell';
    }
    // 6. Bot check / Human check
    else if (lower.includes('bot') || lower.includes('robot') || lower.includes('real person') || lower.includes('human')) {
        matchedCategory = 'bot_check';
    }
    // 7. Decision-making & Contextual Affirmation/Negation (Yes / No / Maybe handling based on memory)
    else if (['yes', 'yeah', 'yep', 'sure', 'okay', 'ok', 'yup', 'definitely', 'proceed', 'please do'].some(word => lower === word || lower.startsWith(word + ' '))) {
        const lastCat = userSessions[sender].lastCategory;
        if (lastCat === 'starlink_price') matchedCategory = 'starlink_install';
        else if (lastCat === 'cctv_price') matchedCategory = 'booking';
        else if (lastCat === 'site_survey') matchedCategory = 'booking';
        else if (lastCat === 'location') matchedCategory = 'starlink_price';
        else matchedCategory = 'question_prompt';
    }
    else if (['no', 'nope', 'nah', 'not really', "don't"].some(word => lower === word || lower.startsWith(word + ' '))) {
        matchedCategory = 'fallback';
    }
    else if (['maybe', 'perhaps', 'not sure', 'possibly'].some(word => lower.includes(word))) {
        matchedCategory = 'question_prompt';
    }
  // 8. Technical, Stock, Quote & Troubleshooting keywords
    else if (lower.includes('question') || lower.includes('ask')) matchedCategory = 'question_prompt';
    else if (lower.includes('stock') || lower.includes('available') || lower.includes('have you got') || lower.includes('in store') || lower.includes('inventory')) matchedCategory = 'hardware_availability';
    else if (lower.includes('quote') || lower.includes('quotation') || lower.includes('estimate') || lower.includes('pricing')) matchedCategory = 'quote_request';
    else if (lower.includes('slow') || lower.includes('disconnect') || lower.includes('router') || lower.includes('signal') || lower.includes('wifi')) matchedCategory = 'wifi_troubleshoot';
    else if (lower.includes('speed') || lower.includes('mbps') || lower.includes('throughput') || lower.includes('bandwidth')) matchedCategory = 'speed_test';
    else if (lower.includes('configure') || lower.includes('access point') || lower.includes('mesh')) matchedCategory = 'router_setup';
    else if (lower.includes('cable') || lower.includes('fiber') || lower.includes('splice') || lower.includes('wire')) matchedCategory = 'cable_repair';
    else if (lower.includes('bridge') || lower.includes('point to point') || lower.includes('link buildings')) matchedCategory = 'wireless_bridge';
    else if (lower.includes('ups') || lower.includes('solar') || lower.includes('backup power') || lower.includes('battery')) matchedCategory = 'power_backup';
    else if (lower.includes('survey') || lower.includes('site visit') || lower.includes('inspection')) matchedCategory = 'site_survey';
    // 9. Location & Coverage
    else if (lower.includes('where') || lower.includes('location') || lower.includes('office') || lower.includes('branch') || lower.includes('lusaka') || lower.includes('ndola') || lower.includes('cover') || lower.includes('province')) {
        matchedCategory = 'location';
    }
    // 10. Hours
    else if (lower.includes('hour') || lower.includes('time') || lower.includes('open') || lower.includes('close') || lower.includes('working') || lower.includes('sunday')) {
        matchedCategory = 'hours';
    }
    // 11. Phone / Call contact
    else if (lower.includes('phone') || lower.includes('call') || lower.includes('speak') || lower.includes('number')) {
        matchedCategory = 'phone_contact';
    }
    // 12. Booking
    else if (lower.includes('book') || lower.includes('schedule') || lower.includes('appointment') || lower.includes('consultation')) {
        matchedCategory = 'booking';
    }
    // 13. Company info
    else if (lower.includes('company') || lower.includes('about') || lower.includes('sovet') || lower.includes('what do you do')) {
        matchedCategory = 'company_info';
    }
    else {
        // Multi-topic service parsing
        const asksPrice = lower.includes('price') || lower.includes('cost') || lower.includes('how much') || lower.includes('fee') || lower.includes('rates') || lower.includes('k9') || lower.includes('k8') || lower.includes('k6');
        const mentionsStarlink = lower.includes('starlink') || lower.includes('dish') || lower.includes('internet');
        const mentionsCCTV = lower.includes('cctv') || lower.includes('camera') || lower.includes('security') || lower.includes('surveillance');
        const mentionsNetwork = lower.includes('network') || lower.includes('cabling') || lower.includes('lan') || lower.includes('it support');
        const mentionsMonthly = lower.includes('monthly') || lower.includes('subscription') || lower.includes('data plan') || lower.includes('k800');
        const mentionsInstall = lower.includes('installation') || lower.includes('install') || lower.includes('mount') || lower.includes('setup');
        const mentionsUpgrade = lower.includes('upgrade') || lower.includes('change plan');
        const mentionsSupport = lower.includes('support after') || lower.includes('warranty') || lower.includes('repair');
        const mentionsSupply = lower.includes('supply') || lower.includes('only install') || lower.includes('equipment');

        if (mentionsStarlink) {
            if (mentionsMonthly) matchedCategory = 'starlink_monthly';
            else if (asksPrice) matchedCategory = 'starlink_price';
            else if (mentionsInstall) matchedCategory = 'starlink_install';
            else matchedCategory = 'starlink_price';
        } else if (mentionsCCTV) {
            if (lower.includes('phone') || lower.includes('remote') || lower.includes('view')) matchedCategory = 'cctv_phone';
            else if (asksPrice) matchedCategory = 'cctv_price';
            else matchedCategory = 'cctv';
        } else if (mentionsNetwork) {
            if (lower.includes('it support') || lower.includes('troubleshoot')) matchedCategory = 'it_support';
            else matchedCategory = 'network';
        } else if (mentionsUpgrade) {
            matchedCategory = 'upgrade';
        } else if (mentionsSupport) {
            matchedCategory = 'support_after';
        } else if (mentionsSupply) {
            matchedCategory = 'supply_install';
        }
    }

    // Save current interaction category into memory state
    userSessions[sender].lastCategory = matchedCategory;

    return getRandomReply(matchedCategory);
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
                    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
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
        const cleanNumber = sender.replace('@s.whatsapp.net', '').replace(/[^0-9]/g, '');

        if (!userSessions[sender]) {
            userSessions[sender] = { messageCount: 0, firstContact: true, pausedUntil: 0, lastCategory: null };
        }

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

        // ISOLATED HUMAN TAKEOVER GUARD: Mutes ONLY this specific client chat for 45 minutes
        if (msg.key.fromMe) {
            userSessions[sender].pausedUntil = Date.now() + (45 * 60 * 1000);
            console.log(`Human agent active in chat ${sender}. Bot paused for this client for 45 minutes.`);
            if (text) appendClientHistory(cleanNumber, 'agent', text);
            return;
        }

        if (userSessions[sender].pausedUntil > Date.now()) {
            console.log(`Bot is currently muted for ${sender} due to active human conversation.`);
            if (text) appendClientHistory(cleanNumber, 'client', text);
            return;
        }

        if (!text) return;

        console.log(`Received message from ${sender}: "${text}"`);
        appendClientHistory(cleanNumber, 'client', text);
        
        await sock.sendPresenceUpdate('composing', sender);

        const replyText = processMessage(sender, text);
        
        logLead(sender, text, replyText);
        appendClientHistory(cleanNumber, 'bot', replyText);

        const typingDelay = getTypingDelay(replyText);
        await new Promise(resolve => setTimeout(resolve, typingDelay));
        
        await sock.sendPresenceUpdate('paused', sender);
        await sock.sendMessage(sender, { text: replyText });
    });
}

app.get('/', async (req, res) => {
    if (isConnected) {
        return res.send('<h1 style="color:green; text-align:center; margin-top:20vh; font-family:sans-serif;">Bot is successfully connected to WhatsApp with persistent storage and contextual memory!</h1>');
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
