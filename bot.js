// bot.js
import 'dotenv/config';
import fs from 'fs/promises';
import TelegramBot from 'node-telegram-bot-api';
import path from 'path';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { all, get, initDb, run } from './database.js';

// --- Configuration ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_USER_ID = parseInt(process.env.ADMIN_USER_ID, 10);
const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID;
const PROXY_URL = process.env.PROXY_URL;
const RESULTS_DIR = './results';
const POST_BATCH_SIZE = 5;

if (!BOT_TOKEN || !ADMIN_USER_ID || !TARGET_CHANNEL_ID) {
    console.error('Bot token, admin user ID, or target channel ID is missing.');
    process.exit(1);
}

let bot;

// --- Helper Functions ---
function getFlagEmoji(countryCode, configName = "") {
    if (countryCode && countryCode.length === 2 && countryCode !== "XX") {
        try {
        return String.fromCodePoint(
            ...countryCode
            .toUpperCase()
            .split("")
            .map((char) => 127397 + char.charCodeAt())
        );
        } catch (e) {
        }
    }

    const flagRegex = /\p{Regional_Indicator}{2}/u;
    const match = configName.match(flagRegex);
    if (match) return match[0]; 

  return "🏁";
}

// --- Main Bot Logic ---
async function startBot() {
    try {
        await initDb();
        await fs.mkdir(RESULTS_DIR, { recursive: true });
    } catch (error) {
        console.error("FATAL: Could not initialize database or create results directory.", error);
        process.exit(1);
    }

    const botOptions = { polling: true };
    if (PROXY_URL) {
        const agent = new SocksProxyAgent(PROXY_URL);
        botOptions.request = { agent };
        console.log(`[Bot] Using SOCKS5 proxy for Telegram API: ${PROXY_URL}`);
    }
    
    bot = new TelegramBot(BOT_TOKEN, botOptions);
    console.log('[Bot] Poster Bot started successfully.');
    
    setupCommandHandlers();
    startPostingCycle();
}

// --- Command Handlers ---
function setupCommandHandlers() {
    // (Command handler code is unchanged)
    bot.on('message', (msg) => {
        if (msg.text && msg.text.startsWith('/') && msg.from.id !== ADMIN_USER_ID) {
            bot.sendMessage(msg.chat.id, "❌ Access Denied.");
            return;
        }
    });

    bot.onText(/\/start/, (msg) => {
        if (msg.from.id !== ADMIN_USER_ID) return;
        bot.sendMessage(msg.chat.id, "Welcome Admin. This bot posts configs found by the tester. Use /help for commands.");
    });
    
    bot.onText(/\/help/, (msg) => {
        if (msg.from.id !== ADMIN_USER_ID) return;
        const helpText = `
🤖 *Bot Command Reference*
\`/addfile <URL>\` - Adds a URL for the tester.
\`/removefile <ID>\` - Removes a URL for the tester.
\`/listfiles\` - Lists URLs the tester is checking.
\`/setschedule <seconds>\` - Sets the posting interval.
\`/getschedule\` - Shows the current posting interval.
        `;
        bot.sendMessage(msg.chat.id, helpText, { parse_mode: 'Markdown' });
    });
    
    bot.onText(/\/addfile (.+)/, async (msg, match) => {
        if (msg.from.id !== ADMIN_USER_ID) return;
        try { await run('INSERT INTO config_files (url) VALUES (?)', [match[1]]); bot.sendMessage(msg.chat.id, "✅ Success! Tester will use this URL on its next cycle."); } catch (e) { bot.sendMessage(msg.chat.id, "❌ Error or URL already exists."); }
    });
    bot.onText(/\/removefile (.+)/, async (msg, match) => {
        if (msg.from.id !== ADMIN_USER_ID) return;
        const id = parseInt(match[1], 10);
        if (isNaN(id)) return bot.sendMessage(msg.chat.id, "Invalid ID.");
        const result = await run('DELETE FROM config_files WHERE id = ?', [id]);
        bot.sendMessage(msg.chat.id, result.changes > 0 ? `✅ Success! File ID ${id} removed.` : `⚠️ Not Found.`);
    });
    bot.onText(/\/listfiles/, async (msg) => {
        if (msg.from.id !== ADMIN_USER_ID) return;
        const files = await all('SELECT id, url FROM config_files ORDER BY id');
        if (files.length === 0) return bot.sendMessage(msg.chat.id, "No files for tester.");
        let message = "📝 *Tester Source URLs:*\n\n";
        files.forEach(file => { message += `*ID ${file.id}:* \`${file.url}\`\n`; });
        bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
    });
    bot.onText(/\/setschedule (.+)/, async (msg, match) => {
        if (msg.from.id !== ADMIN_USER_ID) return;
        const seconds = parseInt(match[1], 10);
        if (isNaN(seconds) || seconds < 60) return bot.sendMessage(msg.chat.id, "Minimum is 60 seconds.");
        await run("INSERT OR REPLACE INTO settings (key, value) VALUES ('posting_interval_seconds', ?)", [seconds]);
        bot.sendMessage(msg.chat.id, `✅ Posting schedule updated to every ${seconds} seconds.`);
        if (postingInterval) clearInterval(postingInterval);
        startPostingCycle();
    });
    bot.onText(/\/getschedule/, async (msg) => {
        if (msg.from.id !== ADMIN_USER_ID) return;
        const row = await get("SELECT value FROM settings WHERE key = 'posting_interval_seconds'");
        const seconds = row ? row.value : "900 (default)";
        bot.sendMessage(msg.chat.id, `⏰ Current posting schedule is ${seconds} seconds.`);
    });
}


// --- POSTING CYCLE ---
let postingInterval;

async function postNextConfigBatch() {
    try {
        const files = await fs.readdir(RESULTS_DIR);
        if (files.length === 0) return;

        files.sort();
        const currentFile = files[0];
        const filePath = path.join(RESULTS_DIR, currentFile);

        const data = await fs.readFile(filePath, 'utf-8');
        const configs = JSON.parse(data);

        if (configs.length === 0) {
            console.log(`[Bot] Result file ${currentFile} is empty. Deleting it.`);
            await fs.unlink(filePath);
            return;
        }

        const batchToPost = configs.splice(0, POST_BATCH_SIZE);
        
        const formattedConfigs = batchToPost.map(c => {
            const flag = getFlagEmoji(c.countryCode, c.name);
            const speedInfo = c.speedMbps ? ` - ${c.speedMbps} Mbps` : '';
            const newName = `${flag} ${speedInfo} ${TARGET_CHANNEL_ID}`;
            const configPart = c.config.split('#')[0];
            return `${flag}${speedInfo}\n${configPart}#${encodeURIComponent(newName)}`;
        }).join('\n');
        
        const message = `<code>${formattedConfigs}</code>`;

        await bot.sendMessage(TARGET_CHANNEL_ID, message, { parse_mode: 'HTML', disable_notification: true });
        console.log(`[Bot] Posted a batch of ${batchToPost.length} configs.`);

        if (configs.length === 0) {
            await fs.unlink(filePath);
            console.log(`[Bot] Finished and deleted result file: ${currentFile}`);
        } else {
            await fs.writeFile(filePath, JSON.stringify(configs, null, 2));
        }

    } catch (error) {
        console.error("[Bot] Error during posting cycle:", error.message.includes('ETIMEDOUT') ? 'Proxy connection timed out.' : error);
    }
}

async function startPostingCycle() {
    const row = await get("SELECT value FROM settings WHERE key = 'posting_interval_seconds'");
    const intervalSeconds = (row && row.value) ? parseInt(row.value, 10) : 1800;
    
    console.log(`[Bot] Posting a new batch of configs every ${intervalSeconds} seconds.`);
    
    postNextConfigBatch();
    postingInterval = setInterval(postNextConfigBatch, intervalSeconds * 1000);
}

// --- Start the entire application ---
startBot();

