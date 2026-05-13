const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const QRCode = require('qrcode');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const API_PORT = process.env.PORT || 3000;

function loadConfig() {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
}

const config = loadConfig();
const FIREBASE_DB = config.firebaseDb || 'https://fir-e9a0b-default-rtdb.firebaseio.com';

// ── שמירת סשן בפיירבייס ──────────────────────────────────────────

async function fbGet(path) {
    try {
        const res = await fetch(`${FIREBASE_DB}/${path}.json`);
        return await res.json();
    } catch(e) { return null; }
}

async function fbSet(path, data) {
    try {
        await fetch(`${FIREBASE_DB}/${path}.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
    } catch(e) {}
}

async function fbDel(path) {
    try {
        await fetch(`${FIREBASE_DB}/${path}.json`, { method: 'DELETE' });
    } catch(e) {}
}

// סשן מותאם שנשמר בפיירבייס
async function useFirebaseAuthState() {
    async function readData(key) {
        const safe = key.replace(/[.#$[\]]/g, '_');
        const data = await fbGet(`botAuth/${safe}`);
        if (!data) return null;
        try { return JSON.parse(data, BufferJSON.reviver); } catch(e) { return data; }
    }

    async function writeData(key, value) {
        const safe = key.replace(/[.#$[\]]/g, '_');
        await fbSet(`botAuth/${safe}`, JSON.stringify(value, BufferJSON.replacer));
    }

    async function removeData(key) {
        const safe = key.replace(/[.#$[\]]/g, '_');
        await fbDel(`botAuth/${safe}`);
    }

    let creds = await readData('creds');
    if (!creds || !creds.noiseKey || !creds.noiseKey.private) {
        creds = initAuthCreds();
    }

    const state = {
        creds,
        keys: {
            get: async (type, ids) => {
                const data = {};
                for (const id of ids) {
                    const val = await readData(`keys_${type}_${id}`);
                    if (val) data[id] = val;
                }
                return data;
            },
            set: async (data) => {
                for (const [type, typeData] of Object.entries(data)) {
                    for (const [id, val] of Object.entries(typeData || {})) {
                        if (val) {
                            await writeData(`keys_${type}_${id}`, val);
                        } else {
                            await removeData(`keys_${type}_${id}`);
                        }
                    }
                }
            }
        }
    };

    const saveCreds = async () => {
        await writeData('creds', state.creds);
    };

    return { state, saveCreds };
}

// ── בדיקת חנות פתוחה ──────────────────────────────────────────

async function isStoreOpen() {
    try {
        const val = await fbGet('settings/storeOpen');
        return val === true;
    } catch(e) { return false; }
}

// ── שרת API ──────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

let sock = null;
let isConnected = false;
let lastQR = null;

app.get('/status', (req, res) => {
    res.json({ connected: isConnected });
});

app.get('/qr', (req, res) => {
    if (isConnected) return res.json({ connected: true, qr: null });
    res.json({ connected: false, qr: lastQR });
});

app.get('/qr-view', (req, res) => {
    if (isConnected) {
        return res.send('<h2 style="font-family:sans-serif;text-align:center;margin-top:80px">✅ הבוט מחובר!</h2>');
    }
    if (!lastQR) {
        return res.send('<h2 style="font-family:sans-serif;text-align:center;margin-top:80px">⏳ ממתין ל-QR... רענן בעוד 10 שניות</h2><script>setTimeout(()=>location.reload(),10000)</script>');
    }
    res.send(`<!DOCTYPE html><html><body style="display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f5f5f5;flex-direction:column;font-family:sans-serif">
        <h2>סרוק כדי לחבר WhatsApp</h2>
        <img src="${lastQR}" style="width:300px;height:300px;border:8px solid white;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.15)"/>
        <p style="color:#888;margin-top:16px">QR תקף לכ-60 שניות. רענן אם פג תוקפו.</p>
        <script>setTimeout(()=>location.reload(),55000)</script>
    </body></html>`);
});

app.post('/send', async (req, res) => {
    if (!isConnected || !sock) {
        return res.status(503).json({ success: false, error: 'הבוט לא מחובר' });
    }
    const { phone, message } = req.body;
    if (!phone || !message) {
        return res.status(400).json({ success: false, error: 'חסר מספר או הודעה' });
    }
    try {
        let jid = phone.replace(/[\s\-()]/g, '');
        if (jid.startsWith('0')) jid = '972' + jid.substring(1);
        if (!jid.includes('@')) jid = jid + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: message });
        console.log(`[${new Date().toLocaleString('he-IL')}] נשלחה הודעה ל-${phone}`);
        res.json({ success: true });
    } catch(e) {
        console.error('שגיאה בשליחה:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/logout', async (req, res) => {
    try {
        isConnected = false;
        lastQR = null;
        if (sock) { try { await sock.logout(); } catch(e) {} }
        await fbDel('botAuth');
        res.json({ success: true });
        setTimeout(() => process.exit(1), 1000);
    } catch(e) {
        res.json({ success: false, error: e.message });
        setTimeout(() => process.exit(1), 1000);
    }
});

app.listen(API_PORT, () => {
    console.log(`שרת API פועל על פורט ${API_PORT}`);
});

// ── הפעלת הבוט ──────────────────────────────────────────

async function startBot() {
    console.log('מפעיל בוט...');
    try {
    const { state, saveCreds } = await useFirebaseAuthState();
    console.log('Firebase auth loaded');
    const { version } = await fetchLatestBaileysVersion();
    console.log('Baileys version:', version);

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'warn' }),
        browser: ['WhatsApp', 'Chrome', '4.0.0'],
        keepAliveIntervalMs: 30000,
        connectTimeoutMs: 60000,
        markOnlineOnConnect: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log('QR נוצר — ממתין לסריקה...');
            try {
                lastQR = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
            } catch(e) {}
        }

        if (connection === 'open') {
            console.log('=============================================');
            console.log('הבוט מחובר ומוכן לעבודה!');
            console.log('=============================================');
            isConnected = true;
            lastQR = null;
        }

        if (connection === 'close') {
            isConnected = false;
            const code = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output?.statusCode : 0;
            const shouldReconnect = code !== DisconnectReason.loggedOut;
            console.log('התנתק, קוד:', code, '— מחבר מחדש:', shouldReconnect);
            if (shouldReconnect) {
                setTimeout(startBot, 5000);
            } else {
                console.log('נותק מכוון — מוחק סשן...');
                await fbDel('botAuth');
                setTimeout(startBot, 3000);
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (msg.key.fromMe) continue;
            if (msg.key.remoteJid?.endsWith('@g.us')) continue;

            const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();
            if (!text) continue;

            const cfg = loadConfig();
            const chatId = msg.key.remoteJid;

            let matched = false;
            for (const rule of cfg.rules) {
                const isMatch = rule.keywords.some(kw => {
                    if (rule.matchType === 'exact') return text.toLowerCase() === kw.toLowerCase();
                    return text.toLowerCase().includes(kw.toLowerCase());
                });

                if (isMatch) {
                    const storeOpen = await isStoreOpen();
                    let response;
                    try {
                        const msgs = await fbGet('settings/waMessages');
                        response = storeOpen
                            ? (msgs?.botOn || rule.response)
                            : (msgs?.botOff || 'היי, לצערנו אנחנו כרגע לא מקבלים הזמנות אונליין.');
                    } catch(e) {
                        response = storeOpen ? rule.response : 'היי, לצערנו אנחנו כרגע לא מקבלים הזמנות אונליין.';
                    }

                    console.log(`[${new Date().toLocaleString('he-IL')}] הודעה מ-${chatId}: "${text}" → חנות ${storeOpen ? 'פתוחה' : 'סגורה'}`);
                    await sock.sendMessage(chatId, { text: response });
                    matched = true;
                    break;
                }
            }

            if (!matched && cfg.defaultResponse) {
                await sock.sendMessage(chatId, { text: cfg.defaultResponse });
            }
        }
    });
    } catch(err) {
        console.error('startBot error:', err.message, err.stack);
        setTimeout(startBot, 5000);
    }
}

startBot().catch(err => {
    console.error('שגיאה בהפעלה:', err.message);
    setTimeout(() => process.exit(1), 5000);
});
