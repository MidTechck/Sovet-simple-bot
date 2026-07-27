const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.urlencoded({ extended: true }));

let currentSock = null;
let pairingCodeResult = '';
let isConnected = false;

async function startPairing(phoneNumber) {
    if (currentSock) {
        try { currentSock.end(undefined); } catch (e) {}
    }

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        auth: state,
        version,
        logger: pino({ level: 'silent' }),
        browser: ['Chrome', 'Mac OS', '10.15.7']
    });

    currentSock = sock;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            isConnected = true;
            pairingCodeResult = '';
            console.log('Connected to WhatsApp successfully.');
        }

        if (connection === 'close') {
            isConnected = false;
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log('Connection closed. Status:', statusCode);

            if (statusCode === DisconnectReason.loggedOut || statusCode === 405 || statusCode === 440) {
                try {
                    fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                } catch (e) {}
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    if (!sock.authState.creds.registered) {
        const cleanedNumber = phoneNumber.replace(/[^0-9]/g, '');
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(cleanedNumber);
                pairingCodeResult = code;
                console.log('Pairing code generated:', code);
            } catch (err) {
                console.log('Failed to request pairing code:', err);
            }
        }, 3000);
    }
}

app.get('/', (req, res) => {
    if (isConnected) {
        return res.send('<h1 style="text-align:center; margin-top:20vh; font-family:sans-serif; color:green;">Bot is already connected to WhatsApp.</h1>');
    }

    if (pairingCodeResult) {
        return res.send(`
            <html>
            <body style="text-align:center; margin-top:15vh; font-family:sans-serif;">
                <h2>Your WhatsApp Pairing Code</h2>
                <p style="font-size:48px; font-weight:bold; letter-spacing:6px; color:#25D366;">${pairingCodeResult}</p>
                <p>1. Open WhatsApp on your phone</p>
                <p>2. Tap Linked Devices -> Link a Device -> Link with phone number instead</p>
                <p>3. Enter this code on your phone</p>
            </body>
            </html>
        `);
    }

    res.send(`
        <html>
        <body style="text-align:center; margin-top:15vh; font-family:sans-serif;">
            <h2>WhatsApp Bot Pairing</h2>
            <form action="/pair" method="POST">
                <p>Enter your WhatsApp phone number with country code (e.g. 260XXXXXXXXX):</p>
                <input type="text" name="phone" placeholder="260..." style="padding:10px; font-size:16px; width:260px;" required />
                <br><br>
                <button type="submit" style="padding:10px 20px; font-size:16px; background:#25D366; color:white; border:none; cursor:pointer;">Generate Pairing Code</button>
            </form>
        </body>
        </html>
    `);
});

app.post('/pair', (req, res) => {
    const phone = req.body.phone;
    if (phone) {
        startPairing(phone);
        res.send(`
            <html>
            <head><meta http-equiv="refresh" content="5"></head>
            <body style="text-align:center; margin-top:15vh; font-family:sans-serif;">
                <h2>Requesting pairing code from WhatsApp, please wait...</h2>
                <p>This page will refresh automatically when the code is ready.</p>
            </body>
            </html>
        `);
    } else {
        res.redirect('/');
    }
});

app.listen(PORT, () => {
    console.log('Server running on port ' + PORT);
});

