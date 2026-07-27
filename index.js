const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();
    console.log(`Using WhatsApp v${version.join('.')}`);

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['Simple Bot', 'Chrome', '10.0'],
        version: version
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('\nScan this QR code with WhatsApp:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log(`Connection closed. Reconnecting...`);
            if (statusCode !== DisconnectReason.loggedOut) {
                setTimeout(startBot, 3000);
            }
        } else if (connection === 'open') {
            console.log('Connected to WhatsApp successfully!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').toLowerCase();

        console.log(`Received message from ${sender}: ${text}`);

        // Simple keyword logic (expandable later)
        if (text.includes('hello') || text.includes('hi')) {
            await sock.sendMessage(sender, { text: 'Hello! Thanks for reaching out. How can we help you today?' });
        } else if (text.includes('price') || text.includes('cost')) {
            await sock.sendMessage(sender, { text: 'Please hold on while we check the details for you.' });
        } else {
            await sock.sendMessage(sender, { text: 'Got your message! We will get back to you shortly.' });
        }
    });
}

startBot();

