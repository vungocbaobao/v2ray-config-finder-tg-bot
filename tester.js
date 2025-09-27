// tester.js
import axios from 'axios';
import { spawn } from 'child_process';
import crypto from 'crypto';
import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { all, initDb } from './database.js';

// --- Configuration ---
const MAX_LATENCY_MS = process.env.MAX_LATENCY_MS ? parseInt(process.env.MAX_LATENCY_MS, 10) : 3000;
const CONCURRENT_TESTS = process.env.CONCURRENT_TESTS ? parseInt(process.env.CONCURRENT_TESTS, 10) : 10;
const TEST_INTERVAL_MINUTES = process.env.TEST_INTERVAL_MINUTES ? parseInt(process.env.TEST_INTERVAL_MINUTES, 10) : 30;
const ENABLE_SPEED_TEST = process.env.ENABLE_SPEED_TEST === 'true';
const SPEED_TEST_URL = process.env.SPEED_TEST_URL || 'http://cachefly.cachefly.net/5mb.test';
const SPEED_TEST_FILE_SIZE_MB = process.env.SPEED_TEST_FILE_SIZE_MB ? parseInt(process.env.SPEED_TEST_FILE_SIZE_MB, 10) : 5;

const SERVICES_TO_TEST = [
    { url: 'https://music.youtube.com', hashtag: '#YouTube_Music' },
    { url: 'https://www.spotify.com', hashtag: '#Spotify' },
    { url: 'https://chat.openai.com', hashtag: '#ChatGPT' },
    { url: 'https://gemini.google.com', hashtag: '#Gemini' }
];

// --- Command-line argument parsing ---
const getArg = (argName) => {
    const argIndex = process.argv.indexOf(argName);
    return (argIndex > -1 && process.argv.length > argIndex + 1) ? process.argv[argIndex + 1] : null;
};

// --- Main Tester Logic ---
async function initialize() {
    const singleFilePath = getArg('--file');

    if (singleFilePath) {
        // Run once for a single local file and then exit.
        console.log(`[Tester] Starting in single-file mode for: ${singleFilePath}`);
        await runSingleFileTest(singleFilePath);
        process.exit(0);
    } else {
        // Default scheduled mode, running continuously.
        console.log('[Tester] Starting in scheduled mode. Fetching configs from database.');
        await initDb();
        if (ENABLE_SPEED_TEST) console.log(`[Tester] Full Speed Testing is ENABLED.`);
        else console.log(`[Tester] Quick Latency Testing is ENABLED.`);
        
        runTestCycle();
        setInterval(runTestCycle, TEST_INTERVAL_MINUTES * 60 * 1000);
    }
}

// --- Helper Functions ---
async function getGeoInfo(ip) {
    if (!ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || ip.startsWith('192.168') || ip.startsWith('10.') || ip === '127.0.0.1') {
        return { countryCode: 'XX', countryName: 'Private/Invalid IP' };
    }
    try {
        const response = await axios.get(`http://ip-api.com/json/${ip}?fields=country,countryCode`);
        return { countryCode: response.data.countryCode || 'XX', countryName: response.data.country || 'Unknown' };
    } catch (error) {
        return { countryCode: 'XX', countryName: 'Error' };
    }
}

function parseConfigsFromText(text) {
    const lines = text.split('\n');
    const protocolsToTest = ['vmess://', 'vless://', 'trojan://', 'ss://', 'hysteria2://'];
    const configs = new Set();
    for (const line of lines) {
        const trimmedLine = line.trim();
        if (protocolsToTest.some(p => trimmedLine.startsWith(p))) {
            configs.add(trimmedLine);
        }
    }
    return Array.from(configs);
}

function parseLink(link) {
    const hashIndex = link.indexOf('#');
    const configPart = hashIndex === -1 ? link : link.substring(0, hashIndex);
    const namePart = hashIndex === -1 ? '' : decodeURIComponent(link.substring(hashIndex + 1));
    const protocol = configPart.split('://')[0];

    try {
        let details = {};
        switch (protocol) {
            case 'vmess':
                details = JSON.parse(Buffer.from(configPart.substring(8), 'base64').toString());
                break;
            case 'vless':
            case 'trojan': {
                const url = new URL(configPart);
                details = { id: url.username, add: url.hostname, port: parseInt(url.port) };
                url.searchParams.forEach((value, key) => { details[key] = value; });
                break;
            }
            case 'ss': {
                const url = new URL(configPart);
                const userInfo = Buffer.from(url.username, 'base64').toString();
                const [method, password] = userInfo.split(':');
                details = { method, password, add: url.hostname, port: parseInt(url.port) };
                break;
            }
            case 'hysteria2': {
                const url = new URL(configPart);
                details = { id: url.username, add: url.hostname, port: parseInt(url.port), sni: url.searchParams.get('sni'), insecure: url.searchParams.get('insecure') === '1' };
                break;
            }
            default: return null;
        }
        details.ps = namePart || details.ps || `${details.add}:${details.port}`;
        return { protocol, details };
    } catch (e) { return null; }
}

async function testConfig(originalLink, testPort) {
    const parsed = parseLink(originalLink);
    if (!parsed || !parsed.details.add || !parsed.details.port) return null;
    
    const { protocol, details } = parsed;
    let outboundConfig;
    try {
        switch (protocol) {
             case 'vmess': outboundConfig = { protocol, settings: { vnext: [{ address: details.add, port: details.port, users: [{ id: details.id, alterId: details.aid || 0, security: details.scy || 'auto' }] }] }, streamSettings: { network: details.net, security: details.tls, wsSettings: { path: details.path, headers: { Host: details.host } }, tlsSettings: { serverName: details.sni || details.host } } }; break;
             case 'vless': outboundConfig = { protocol, settings: { vnext: [{ address: details.add, port: details.port, users: [{ id: details.id, flow: details.flow, encryption: "none" }] }] }, streamSettings: { network: details.type, security: details.security, realitySettings: details.security === 'reality' ? { publicKey: details.pbk, shortId: details.sid, fingerprint: details.fp || 'chrome' } : undefined, wsSettings: { path: details.path, headers: { Host: details.host } }, tlsSettings: { serverName: details.sni } } }; break;
             case 'trojan': outboundConfig = { protocol, settings: { servers: [{ address: details.add, port: details.port, password: details.id }] }, streamSettings: { security: details.security || 'tls', tlsSettings: { serverName: details.sni }, wsSettings: { path: details.path, headers: { Host: details.host } } } }; break;
             case 'ss': outboundConfig = { protocol: "shadowsocks", settings: { servers: [{ address: details.add, port: details.port, method: details.method, password: details.password }] } }; break;
             case 'hysteria2': outboundConfig = { protocol, settings: { servers: [{ address: details.add, port: details.port, password: details.id }] }, streamSettings: { network: 'udp', security: 'tls', tlsSettings: { serverName: details.sni, insecure: details.insecure, alpn: ["h3"] } } }; break;
             default: return null;
        }
    } catch (e) { return null; }
    
    const testJson = { log: { loglevel: "none" }, inbounds: [{ port: testPort, listen: "127.0.0.1", protocol: "socks" }], outbounds: [outboundConfig] };
    const tempConfigPath = `./tmp/temp_config_${crypto.randomBytes(4).toString('hex')}.json`;
    let xrayProcess;

    try {
        await fs.writeFile(tempConfigPath, JSON.stringify(testJson));
        xrayProcess = spawn('./xray', ['-c', tempConfigPath]);
        
        await new Promise(resolve => setTimeout(resolve, 300)); // Give Xray a moment to start

        const agent = new SocksProxyAgent(`socks5://127.0.0.1:${testPort}`);
        const startTime = Date.now();
        
        await axios.get("http://www.gstatic.com/generate_204", { httpAgent: agent, httpsAgent: agent, timeout: MAX_LATENCY_MS });
        const latency = Date.now() - startTime;
        
        // Services Testing
        const workingServices = [];
        for (const service of SERVICES_TO_TEST) {
            try {
                await axios.get(service.url, { httpAgent: agent, httpsAgent: agent, timeout: 5000 });
                workingServices.push(service.hashtag);
                console.log(`[${service.hashtag}] success for ${details.ps}`);
            } catch (serviceError) {
                console.log(`[${service.hashtag}] failed for ${details.ps}`);
            }
        }

        let speedMbps = null;
        if (ENABLE_SPEED_TEST) {
            const speedStartTime = Date.now();
            await axios.get(SPEED_TEST_URL, { httpAgent: agent, httpsAgent: agent, timeout: 20000, responseType: 'arraybuffer' });
            const speedEndTime = Date.now();
            const durationSeconds = (speedEndTime - speedStartTime) / 1000;
            if (durationSeconds > 0) {
                 speedMbps = ((SPEED_TEST_FILE_SIZE_MB * 8) / durationSeconds).toFixed(2);
            }
        }
        
        const geo = await getGeoInfo(details.add);
        
        console.log(`✅ [SUCCESS] (${latency}ms) | Speed: ${speedMbps ? speedMbps + 'Mbps' : 'N/A'} | ${geo.countryName} | ${details.ps}`);
        return { config: originalLink, latency, speedMbps, ...geo, name: details.ps, tags: workingServices };

    } catch (error) {
        const reason = error.code === 'ECONNABORTED' ? 'Timeout' : error.message;
        console.log(`❌ [FAIL] (${reason}) ${details.ps}`);
        return null;
    } finally {
        if (xrayProcess) xrayProcess.kill();
        await fs.unlink(tempConfigPath).catch(() => {});
    }
}

async function processAndTestConfigs(configsToTest, sourceName) {
    console.log(`[Tester] Found ${configsToTest.length} configs from ${sourceName}. Starting tests...`);
    const workingConfigs = [];

    for (let i = 0; i < configsToTest.length; i += CONCURRENT_TESTS) {
        const batch = configsToTest.slice(i, i + CONCURRENT_TESTS);
        console.log(`--- Testing batch ${Math.floor(i / CONCURRENT_TESTS) + 1} of ${Math.ceil(configsToTest.length / CONCURRENT_TESTS)} ---`);
        const testPromises = batch.map((config, index) => testConfig(config, 20800 + index));
        const results = await Promise.all(testPromises);
        workingConfigs.push(...results.filter(Boolean));
    }

    if (workingConfigs.length > 0) {
        workingConfigs.sort((a, b) => (b.speedMbps || 0) - (a.speedMbps || 0) || a.latency - b.latency);
        
        const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
        const filename = `./results/${sourceName}_${timestamp}.json`;
        
        await fs.writeFile(filename, JSON.stringify(workingConfigs, null, 2));
        console.log(`\n[Tester] ✅ Success! Saved ${workingConfigs.length} working configs to ${filename}\n`);
    } else {
        console.log(`\n[Tester] ❌ No working configs found for source: ${sourceName}\n`);
    }
}

async function runSingleFileTest(filePath) {
    try {
        const fileContent = await fs.readFile(filePath, 'utf-8');
        const configs = parseConfigsFromText(fileContent);

        if (configs.length === 0) {
            console.log(`[Tester] No valid configs found in ${filePath}.`);
            return;
        }
        
        const sourceName = path.basename(filePath, path.extname(filePath));
        await processAndTestConfigs(configs, sourceName);

    } catch (error) {
        if (error.code === 'ENOENT') {
            console.error(`[Tester] Error: File not found at path: ${filePath}`);
        } else {
            console.error(`[Tester] A critical error occurred during the single file test:`, error);
        }
        process.exit(1);
    }
}

async function runTestCycle() {
    console.log(`\n[Tester] Starting new test cycle at ${new Date().toISOString()}`);
    try {
        let sources = await all("SELECT * FROM config_files");
        if (sources.length === 0) { console.log("[Tester] No sources in database. Skipping cycle."); return; }

        sources = sources.sort(() => 0.5 - Math.random())
        for (const source of sources) {
            console.log(`[Tester] Fetching source: ${source.url}`);
            try {
                const response = await axios.get(source.url, { timeout: 5000 });
                const configs = parseConfigsFromText(response.data);
                
                if (configs.length > 0) {
                    const sourceName = new URL(source.url).pathname.split('/').pop().replace('.txt', '');
                    await processAndTestConfigs(configs, sourceName);
                } else {
                    console.log(`[Tester] No valid configs found in ${source.url}`);
                }
            } catch (error) {
                console.error(`[Tester] Failed to process source ${source.url}:`, error.message);
            }
        }
    } catch (error) {
        console.error("[Tester] A critical error occurred during the test cycle:", error);
    }
}

initialize();