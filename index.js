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

// 30 Comprehensive response pools with 3+ natural variations. Strictly NO emojis and NO exclamation marks (!)
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
    client_type: [
        "We cater to both residential homes and commercial businesses, including offices and schools. Is this inquiry for your home or business premises.",
        "Our installation teams handle projects of all sizes, from private homes to corporate buildings. What type of property are you setting up.",
        "We provide tailored IT and security solutions for both domestic and corporate clients. Let me know your specific requirements."
    ],
    warranty: [
        "We assist with hardware troubleshooting and warranty support for installed systems. What specific equipment is giving you trouble.",
        "If you encounter any faulty hardware we supplied, our team will inspect and guide you on the replacement process. Can you describe the issue.",
        "We provide support for equipment maintenance and repairs. Let us know what component needs attention."
    ],
    custom_order: [
        "We handle custom IT infrastructure and specialized connectivity setups tailored to unique project needs. What specifications are you looking for.",
        "Our engineers can design custom solutions for complex sites or multi-building setups. Would you like to discuss your project details with us.",
        "We accommodate special technical requests for both corporate and residential clients. Tell us more about what you need built."
    ],
    question_prompt: [
        "I am ready to help. What specific service or information would you like to know about.",
        "Go ahead and share your question, and I will get you the right information.",
        "I am here to assist. What is your question regarding our services."
    ],
    bot_check: [
        "I am an automated assistant helping handle inquiries for Sovet Link Technologies, but our human technical team is always close by. What can we help you with.",
        "I handle initial client inquiries here on WhatsApp, and our human technical team steps in for technical details and bookings. How can we assist you today.",
        "I am a virtual assistant supporting the Sovet Link team. What service information can I pull up for you."
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

function getTimeBasedGreeting() {
    const hour = new Date().getHours();
    if (hour < 12) return getRandomReply('morning');
    if (hour < 17) return getRandomReply('afternoon');
    return getRandomReply('evening');
}

// Automated Lead Logger function
function logLead(sender, text, replyText) {
    const timestamp = new Date().toLocaleString();
    const cleanNumber = sender.replace('@s.whatsapp.net', '');
    const logEntry = `----------------------------------------\n[${timestamp}] Client: +${cleanNumber}\nMessage: "${text}"\nBot Reply: "${replyText}"\n`;
    try {
        fs.appendFileSync('leads.txt', logEntry + '\n');
    } catch (err) {
        console.log('Failed to write lead to file:', err);
    }
}

function processMessage(sender, text) {
    const lower = text.toLowerCase();

    if (!userSessions[sender]) {
        userSessions[sender] = { messageCount: 0, firstContact: true, pausedUntil: 0 };
    }
    userSessions[sender].messageCount += 1;

    // 1. Payment / Buying safeguard
    if (lower.includes('pay') || lower.includes('buy') || lower.includes('deposit') || lower.includes('transfer') || lower.includes('send money') || lower.includes('paid') || lower.includes('bank') || lower.includes('momo') || lower.includes('airtel money')) {
        return getRandomReply('payment');
    }

    // 2. Urgent / Emergency
    if (lower.includes('urgent') || lower.includes('emergency') || lower.includes('asap') || lower.includes('immediately') || lower.includes('down')) {
        return getRandomReply('urgent');
    }

    // 3. Greetings
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

    // 4. Thanks & Farewell
    if (lower.includes('thank') || lower.includes('thx') || lower.includes('appreciate')) {
        return getRandomReply('thanks');
    }
    if (lower.includes('bye') || lower.includes('goodbye') || lower.includes('see you') || lower.includes('later')) {
        return getRandomReply('farewell');
    }

    // 5. Bot check / Human check
    if (lower.includes('bot') || lower.includes('robot') || lower.includes('real person') || lower.includes('human')) {
        return getRandomReply('bot_check');
    }

    // 6. Question prompt
    if (lower.includes('question') || lower.includes('ask')) {
        return getRandomReply('question_prompt');
    }

    // 7. Location & Coverage
    if (lower.includes('where') || lower.includes('location') || lower.includes('office') || lower.includes('branch') || lower.includes('lusaka') || lower.includes('ndola') || lower.includes('cover') || lower.includes('province')) {
        return getRandomReply('location');
    }

    // 8. Hours
    if (lower.includes('hour') || lower.includes('time') || lower.includes('open') || lower.includes('close') || lower.includes('working') || lower.includes('sunday')) {
        return getRandomReply('hours');
    }

    // 9. Phone / Call contact
    if (lower.includes('phone') || lower.includes('call') || lower.includes('speak') || lower.includes('number')) {
        return getRandomReply('phone_contact');
    }

    // 10. Booking
    if (lower.includes('book') || lower.includes('schedule') || lower.includes('appointment') || lower.includes('consultation') || lower.includes('site visit')) {
        return getRandomReply('booking');
    }

    // 11. Company info
    if (lower.includes('company') || lower.includes('about') || lower.includes('sovet') || lower.includes('what do you do')) {
        return getRandomReply('company_info');
    }

    // 12. Multi-topic or specific services (Starlink, CCTV, Network, Pricing checks)
    const asksPrice = lower.includes('price') || lower.includes('cost') || lower.includes('how much') || lower.includes('fee') || lower.includes('rates') || lower.includes('k9') || lower.includes('k8') || lower.includes('k6');
    const mentionsStarlink = lower.includes('starlink') || lower.includes('dish') || lower.includes('internet');
    const mentionsCCTV = lower.includes('cctv') || lower.includes('camera') || lower.includes('security') || lower.includes('surveillance');
    const mentionsNetwork = lower.includes('network') || lower.includes('cabling') || lower.includes('lan') || lower.includes('wifi') || lower.includes('it support') || lower.includes('router');
    const mentionsMonthly = lower.includes('monthly') || lower.includes('subscription') || lower.includes('data plan') || lower.includes('k800');
    const mentionsInstall = lower.includes('installation') || lower.includes('install') || lower.includes('mount') || lower.includes('setup');
    const mentionsUpgrade = lower.includes('upgrade') || lower.includes('change plan');
    const mentionsSupport = lower.includes('support after') || lower.includes('warranty') || lower.includes('repair');
    const mentionsSupply = lower.includes('supply') || lower.includes('only install') || lower.includes('equipment');

    let replies = [];

    if (mentionsStarlink) {
        if (mentionsMonthly) replies.push(getRandomReply('starlink_monthly'));
        else if (asksPrice) replies.push(getRandomReply('starlink_price'));
        else if (mentionsInstall) replies.push(getRandomReply('starlink_install'));
        else replies.push(getRandomReply('starlink_price'));
    }

    if (mentionsCCTV) {
        if (lower.includes('phone') || lower.includes('remote') || lower.includes('view')) replies.push(getRandomReply('cctv_phone'));
        else if (asksPrice) replies.push(getRandomReply('cctv_price'));
        else replies.push(getRandomReply('cctv'));
    }

    if (mentionsNetwork) {
        if (lower.includes('it support') || lower.includes('troubleshoot')) replies.push(getRandomReply('it_support'));
        else replies.push(getRandomReply('network'));
    }

    if (mentionsUpgrade) replies.push(getRandomReply('upgrade'));
    if (mentionsSupport) replies.push(getRandomReply('support_after'));
    if (mentionsSupply) replies.push(getRandomReply('supply_install'));

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
        
        // Save lead automatically to leads.txt
        logLead(sender, text, replyText);

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
