// tester.js
import axios from 'axios';
import { spawn } from 'child_process';
import crypto from 'crypto';
import 'dotenv/config';
import fs from 'fs/promises';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { all, initDb } from './database.js';

// Config (tweak as needed or via env)
const MAX_LATENCY_MS = process.env.MAX_LATENCY_MS ? parseInt(process.env.MAX_LATENCY_MS, 10) : 5000;
const CONCURRENT_TESTS = process.env.CONCURRENT_TESTS ? parseInt(process.env.CONCURRENT_TESTS, 10) : 10;
const TEST_INTERVAL_MINUTES = process.env.TEST_INTERVAL_MINUTES ? parseInt(process.env.TEST_INTERVAL_MINUTES, 10) : 30;
const XRAY_BIN = process.env.XRAY_BIN || './xray';
const CHANNEL_ID = (process.env.TARGET_CHANNEL_ID || '').replace(/^@/, ''); // the channel name/id to inject into remark
const DEBUG = process.env.DEBUG_TESTER === '1';

console.log('Tester config:', { MAX_LATENCY_MS, CONCURRENT_TESTS, TEST_INTERVAL_MINUTES, XRAY_BIN, CHANNEL_ID, DEBUG });

// ----------------- helpers -----------------
function safeDecodeURIComponent(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function withRemarkFragment(candidate, remark) {
  if (!remark) return candidate;
  // remove any existing fragment just in case
  const base = candidate.split('#')[0];
  // encode remark for use in URI fragment
  const encoded = encodeURIComponent(remark);
  return `${base}#${encoded}`;
}

function padBase64(s) {
  if (!s) return s;
  return s + '='.repeat((4 - (s.length % 4)) % 4);
}

function isLikelyBase64(str) {
  if (!str || typeof str !== 'string') return false;
  const s = str.replace(/\s+/g, '');
  return /^[A-Za-z0-9+/=._-]{6,}$/.test(s);
}

function stripTrailingJunkForRemark(str) {
  if (!str) return str;
  return str.replace(/[`"'“”\s]+$/g, '').trim();
}

function normalizeDetails(details) {
  if (!details) return details;
  details.add = details.add || details.address || details.host || details.server || details.hostname;
  if (typeof details.add === 'string') details.add = details.add.trim();
  if (details.port !== undefined) {
    const p = parseInt(String(details.port).replace(/[^\d]/g, ''), 10);
    details.port = Number.isNaN(p) ? undefined : p;
  }
  details.id = details.id || details.uuid || details.password || details.user || details.pass || details.auth;
  // if add is a URL string, extract hostname
  try {
    if (details.add && (details.add.startsWith('http://') || details.add.startsWith('https://'))) {
      const tmp = new URL(details.add);
      details.add = tmp.hostname;
      if (!details.port && tmp.port) details.port = parseInt(tmp.port, 10);
    }
  } catch (e) {}
  return details;
}

function extractProtocolAndCandidate(line) {
  // Finds a supported protocol substring anywhere in the line, returns candidate (trimmed)
  if (!line || typeof line !== 'string') return null;
  const protocols = ['vmess://','vless://','trojan://','ss://','ssr://','hy2://','hysteria://','hysteria2://'];
  const lower = line.toLowerCase();
  for (const p of protocols) {
    const idx = lower.indexOf(p);
    if (idx === -1) continue;
    let candidate = line.slice(idx);
    const m = candidate.match(/^[^\s]+/);
    if (m) candidate = m[0];
    // trim trailing non-url/base64 characters
    while (candidate.length && !/^[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]$/.test(candidate[candidate.length-1])) {
      candidate = candidate.slice(0, -1);
    }
    candidate = candidate.replace(/[`"'“”]+$/g, '').trim();
    if (!candidate) return null;
    return candidate;
  }
  return null;
}

function extractCandidateAndRemark(line) {
  const candidateFull = extractProtocolAndCandidate(line);
  if (!candidateFull) return null;
  const hashIdx = candidateFull.indexOf('#');
  const candidate = hashIdx === -1 ? candidateFull : candidateFull.slice(0, hashIdx);
  const rawRemark = hashIdx === -1 ? '' : candidateFull.slice(hashIdx + 1);
  const cleanedRemark = stripTrailingJunkForRemark(rawRemark);
  return { candidate, rawRemark: cleanedRemark };
}

function adjustRemarkWithChannel(rawRemark) {
  // if CHANNEL_ID empty just return decoded rawRemark or fallback
  const decoded = safeDecodeURIComponent(rawRemark || '').trim();
  if (!CHANNEL_ID) return decoded || undefined;
  if (!decoded) return `@${CHANNEL_ID}`;
  const atIdx = decoded.indexOf('@');
  if (atIdx === -1) {
    // append
    return `${decoded} @${CHANNEL_ID}`;
  } else {
    // keep text before '@', replace following token with our channel id
    const before = decoded.slice(0, atIdx).trim();
    // result is "<before> @CHANNEL_ID" or if before empty then "@CHANNEL_ID"
    return before ? `${before} @${CHANNEL_ID}` : `@${CHANNEL_ID}`;
  }
}

// ----------------- parsing -----------------
function parseLink(candidate) {
  if (!candidate || typeof candidate !== 'string') return null;
  const hashIdx = candidate.indexOf('#');
  const main = hashIdx === -1 ? candidate : candidate.slice(0, hashIdx);
  const proto = main.split('://')[0].toLowerCase();

  try {
    // vmess: vmess://BASE64(JSON)
    if (proto === 'vmess') {
      const payload = main.slice('vmess://'.length);
      if (!isLikelyBase64(payload)) return null;
      const json = Buffer.from(padBase64(payload), 'base64').toString('utf8');
      const obj = JSON.parse(json);
      obj.ps = obj.ps || '';
      const details = normalizeDetails(obj);
      return (details.add && details.port) ? { protocol: 'vmess', details } : null;
    }

    // ss: many variants
    if (proto === 'ss') {
      const payload = main.slice('ss://'.length);
      const beforeQuery = payload.split('?')[0];
      // Case: left@host:port  (left may be base64 or plain method:pass)
      const lastAt = beforeQuery.lastIndexOf('@');
      if (lastAt !== -1) {
        const left = beforeQuery.slice(0, lastAt);
        const right = beforeQuery.slice(lastAt + 1);
        const [hostPart, portPart] = right.split(':');
        if (isLikelyBase64(left)) {
          try {
            const decoded = Buffer.from(padBase64(left), 'base64').toString('utf8');
            const [method, password] = decoded.split(':');
            const details = normalizeDetails({ method, password, add: hostPart, port: portPart });
            return (details.add && details.port) ? { protocol: 'ss', details } : null;
          } catch {}
        }
        if (left.includes(':')) {
          const [method, password] = left.split(':');
          const details = normalizeDetails({ method, password, add: hostPart, port: portPart });
          return (details.add && details.port) ? { protocol: 'ss', details } : null;
        }
      }

      // Case: payload is base64 encoding "method:pass@host:port"
      if (isLikelyBase64(beforeQuery)) {
        try {
          const decoded = Buffer.from(padBase64(beforeQuery), 'base64').toString('utf8');
          const at = decoded.indexOf('@');
          if (at !== -1) {
            const userPart = decoded.slice(0, at);
            const hostPart = decoded.slice(at + 1);
            const [method, password] = userPart.split(':');
            const [host, port] = hostPart.split(':');
            const details = normalizeDetails({ method, password, add: host, port });
            return (details.add && details.port) ? { protocol: 'ss', details } : null;
          }
        } catch {}
      }

      // Fallback: try URL parse like ss://method:pass@host:port
      try {
        const url = new URL(main);
        let method = url.username || undefined;
        let password = url.password || undefined;
        if (!method && payload.includes('@')) {
          const userinfo = payload.slice(0, payload.indexOf('@'));
          [method, password] = userinfo.split(':');
        }
        const details = normalizeDetails({ method, password, add: url.hostname, port: url.port ? parseInt(url.port,10) : undefined });
        return (details.add && details.port) ? { protocol: 'ss', details } : null;
      } catch { return null; }
    }

    // ssr: ssr://BASE64(payload)
    if (proto === 'ssr') {
      try {
        const payload = main.slice('ssr://'.length);
        if (!isLikelyBase64(payload)) return null;
        const decoded = Buffer.from(padBase64(payload), 'base64').toString('utf8');
        const [hostpart/*like host:port:protocol:method:obfs:pw_b64*/, /*q*/] = decoded.split('/?');
        const parts = hostpart.split(':');
        if (parts.length < 6) return null;
        const [add, port, protocol, method, obfs, password_b64] = parts;
        const password = Buffer.from(padBase64(password_b64), 'base64').toString('utf8');
        const details = normalizeDetails({ add, port, protocol, method, obfs, password });
        return (details.add && details.port) ? { protocol: 'ssr', details } : null;
      } catch { return null; }
    }

    // vless / trojan / hy2 / hysteria* handled by URL
    if (['vless','trojan','hy2','hysteria','hysteria2'].includes(proto)) {
      try {
        const url = new URL(main);
        const config = {
          id: url.username || url.password || '',
          add: url.hostname,
          port: url.port ? parseInt(url.port, 10) : undefined
        };
        url.searchParams.forEach((v,k) => { config[k] = v; });
        const details = normalizeDetails(config);
        const outProto = proto === 'hy2' ? 'hysteria2' : proto;
        return (details.add && details.port) ? { protocol: outProto, details } : null;
      } catch { return null; }
    }

    return null;
  } catch (e) {
    return null;
  }
}

// ----------------- test runner -----------------
async function testConfig(originalCandidate, remarkForPosting, testPort) {
  // parse technical token
  const parsed = parseLink(originalCandidate);
  if (!parsed || !parsed.details || !parsed.details.add || !parsed.details.port) return null;
  const { protocol, details } = parsed;

  // set details.ps to remarkForPosting if provided (else keep existing or fallback)
  details.ps = remarkForPosting || details.ps || `${details.add}:${details.port}`;

  // Build outbound similar to xray shape
  let outboundConfig;
  try {
    switch (protocol) {
      case 'vmess':
        outboundConfig = {
          protocol: 'vmess',
          settings: { vnext: [{ address: details.add, port: details.port, users: [{ id: details.id || '', alterId: details.aid || 0, security: details.security || details.scy || 'auto' }] }] },
          streamSettings: {
            network: details.net || details.network || 'tcp',
            security: details.tls || details.security || '',
            wsSettings: ((details.net === 'ws' || details.type === 'ws') ? { path: details.path || '/', headers: { Host: details.host || '' } } : undefined),
            tlsSettings: (details.tls || details.sni) ? { serverName: details.sni || details.host } : undefined
          }
        };
        break;
      case 'vless':
        outboundConfig = {
          protocol: 'vless',
          settings: { vnext: [{ address: details.add, port: details.port, users: [{ id: details.id || '', flow: details.flow || undefined, encryption: 'none' }] }] },
          streamSettings: {
            network: details.type || details.net || 'tcp',
            security: details.security || '',
            realitySettings: details.security === 'reality' ? { publicKey: details.pbk, shortId: details.sid, fingerprint: details.fp } : undefined,
            wsSettings: ((details.type === 'ws' || details.net === 'ws') ? { path: details.path || '/', headers: { Host: details.host || '' } } : undefined),
            tlsSettings: details.security ? { serverName: details.sni || details.host } : undefined
          }
        };
        break;
      case 'trojan':
        outboundConfig = {
          protocol: 'trojan',
          settings: { servers: [{ address: details.add, port: details.port, password: details.id || details.password }] },
          streamSettings: {
            security: details.security || 'tls',
            tlsSettings: { serverName: details.sni || details.host },
            wsSettings: (details.type === 'ws') ? { path: details.path || '/', headers: { Host: details.host || '' } } : undefined
          }
        };
        break;
      case 'ss':
      case 'ssr':
        outboundConfig = {
          protocol: 'shadowsocks',
          settings: {
            servers: [{
              address: details.add,
              port: details.port,
              method: details.method || details.cipher || 'aes-256-gcm',
              password: details.password || details.pass || details.password_b64 || ''
            }]
          }
        };
        break;
      case 'hysteria2':
      case 'hysteria':
        outboundConfig = {
          protocol: 'hysteria',
          settings: { servers: [{ address: details.add, port: details.port, password: details.id || details.password || '' }] },
          streamSettings: {
            network: 'udp',
            security: 'tls',
            tlsSettings: { serverName: details.sni || details.host, insecure: (details.insecure === '1' || details.insecure === true) }
          }
        };
        break;
      default:
        return null;
    }
  } catch (e) {
    return null;
  }

  const testJson = {
    log: { loglevel: "warning" },
    inbounds: [{ port: testPort, listen: "127.0.0.1", protocol: "socks", settings: { udp: true } }],
    outbounds: [outboundConfig]
  };

  const tempConfigPath = `./tmp/temp_config_${crypto.randomBytes(4).toString('hex')}.json`;
  let xrayProcess = null;
  let stderrBuf = '';
  let stdoutBuf = '';

  try {
    await fs.writeFile(tempConfigPath, JSON.stringify(testJson, null, 2));
    xrayProcess = spawn(XRAY_BIN, ['-c', tempConfigPath], { stdio: ['ignore','pipe','pipe'] });

    xrayProcess.stderr.on('data', (d) => { stderrBuf += d.toString(); });
    xrayProcess.stdout.on('data', (d) => { stdoutBuf += d.toString(); });

    // give xray a little time to startup
    await new Promise(r => setTimeout(r, 350));

    const agent = new SocksProxyAgent(`socks5://127.0.0.1:${testPort}`);
    const start = Date.now();
    await axios.get("http://www.gstatic.com/generate_204", {
      httpAgent: agent,
      httpsAgent: agent,
      timeout: MAX_LATENCY_MS
    });
    const latency = Date.now() - start;

    // success
    try { if (xrayProcess) xrayProcess.kill(); } catch {}
    await fs.unlink(tempConfigPath).catch(()=>{});
    const finalConfig = withRemarkFragment(originalCandidate, details.ps);
    console.log(`✅ [SUCCESS] (${latency}ms): ${details.ps}`);
    return { config: finalConfig, latency, name: details.ps };
  } catch (err) {
    console.log(`❌ [FAIL] Test failed for ${remarkForPosting || (details && details.ps) || originalCandidate}`);
    if (DEBUG) {
      try {
        await fs.mkdir('./tmp/debug', { recursive: true });
        const id = crypto.randomBytes(3).toString('hex');
        await fs.writeFile(`./tmp/debug/fail_${id}_config.json`, JSON.stringify(testJson, null, 2));
        await fs.writeFile(`./tmp/debug/fail_${id}_stderr.txt`, stderrBuf || String(err));
        await fs.writeFile(`./tmp/debug/fail_${id}_stdout.txt`, stdoutBuf || '');
        console.log(`[DEBUG] Wrote debug files: ./tmp/debug/fail_${id}_*`);
      } catch (e) { /* ignore debug write errors */ }
    }
    try { if (xrayProcess) xrayProcess.kill(); } catch {}
    await fs.unlink(tempConfigPath).catch(()=>{});
    return null;
  }
}

// ----------------- main cycle -----------------
async function runTestCycle() {
  console.log(`\n[Tester] Starting new test cycle at ${new Date().toISOString()}`);
  try {
    const sources = await all("SELECT * FROM config_files");
    if (sources.length === 0) {
      console.log("[Tester] No sources in database. Skipping cycle.");
      return;
    }

    for (const source of sources) {
      console.log(`[Tester] Fetching source: ${source.url}`);
      try {
        const response = await axios.get(source.url, { timeout: 15000 });
        const lines = (response.data || '').split(/\r?\n/);
        const configsToTest = new Map(); // key = md5(technicalCandidate) -> { candidate, rawRemark }

        for (const line of lines) {
          if (!line || !line.trim()) continue;
          const ext = extractCandidateAndRemark(line);
          if (!ext) continue;
          // dedupe by technical candidate (the part before '#')
          const key = crypto.createHash('md5').update(ext.candidate).digest('hex');
          if (!configsToTest.has(key)) configsToTest.set(key, ext);
        }

        if (configsToTest.size === 0) {
          console.log(`[Tester] No valid configs found in ${source.url}`);
          continue;
        }

        console.log(`[Tester] Found ${configsToTest.size} configs from ${source.url}. Starting tests...`);
        const allConfigsArray = Array.from(configsToTest.values());
        const workingConfigs = [];

        for (let i = 0; i < allConfigsArray.length; i += CONCURRENT_TESTS) {
          const batch = allConfigsArray.slice(i, i + CONCURRENT_TESTS);
          console.log(`--- Testing batch ${Math.floor(i / CONCURRENT_TESTS) + 1} of ${Math.ceil(allConfigsArray.length / CONCURRENT_TESTS)} ---`);
          const promises = batch.map((item, idx) => {
            const testPort = 20800 + (i + idx) % 1000; // simple per-task port
            // prepare remark for posting (replace/append @CHANNEL_ID logic)
            const remarkForPosting = adjustRemarkWithChannel(item.rawRemark);
            return testConfig(item.candidate, remarkForPosting, testPort);
          });
          const results = await Promise.all(promises);
          workingConfigs.push(...results.filter(Boolean));
        }

        if (workingConfigs.length > 0) {
          workingConfigs.sort((a,b) => a.latency - b.latency);
          const sourceName = (() => {
            try { return new URL(source.url).pathname.split('/').pop().replace(/[^a-z0-9_\-\.]/gi,'') || 'source'; } catch { return 'source'; }
          })();
          const timestamp = new Date().toISOString().replace(/:/g,'-').replace(/\..+/, '');
          const filename = `./results/${sourceName}_${timestamp}.json`;
          await fs.mkdir('./results', { recursive: true });
          await fs.writeFile(filename, JSON.stringify(workingConfigs, null, 2));
          console.log(`\n[Tester] ✅ Saved ${workingConfigs.length} working configs to ${filename}\n`);
        } else {
          console.log(`\n[Tester] ❌ No working configs found for source: ${source.url}\n`);
        }
      } catch (error) {
        console.error(`[Tester] Failed to process source ${source.url}:`, error.message);
      }
    }
  } catch (error) {
    console.error("[Tester] A critical error occurred during the test cycle:", error);
  }
}

// ----------------- init -----------------
async function initialize() {
  await initDb();
  console.log('[Tester] Tester process started. Fetching configs directly (no proxy).');
  // run immediately
  await runTestCycle();
  // schedule
  setInterval(runTestCycle, TEST_INTERVAL_MINUTES * 60 * 1000);
}

initialize();
