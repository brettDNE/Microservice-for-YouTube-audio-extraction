// server.js (ESM)
// Cloud Run-friendly YouTube → audio microservice using yt-dlp + ffmpeg

import express from 'express';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const PORT = process.env.PORT || 8080;
const app = express();

// --- CORS ---
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// --- Optional: GCS upload support ---
let storage = null;
const BUCKET = process.env.BUCKET || '';
if (BUCKET) {
  const { Storage } = await import('@google-cloud/storage');
  storage = new Storage();
}

// --- Optional: Netscape cookie file contents (via env/secret) ---
const COOKIES_RAW = process.env.YTDLP_COOKIES || '';

// ---------- helpers ----------

function cleanup(p) {
  try { fs.unlinkSync(p); } catch {}
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    let out = '', err = '';
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = (buf, chunk) => {
      buf += chunk.toString();
      return buf.length > 4096 ? buf.slice(-4096) : buf;
    };
    p.stdout.on('data', d => { out = keep(out, d); });
    p.stderr.on('data', d => { err = keep(err, d); });
    p.on('error', reject);
    p.on('exit', code => {
      if (code === 0) return resolve({ out, err });
      reject(new Error(`${cmd} exited ${code}\n--- stdout ---\n${out}\n--- stderr ---\n${err}`));
    });
  });
}

function buildYtDlpArgs({ url, format, outBase, cookiesPath }) {
  // Use a stable desktop Chrome UA (or override with env YTDLP_UA)
  const UA = process.env.YTDLP_UA ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  const extractorArgs = [
    '--user-agent', UA,
    '--add-header', 'Referer:https://www.youtube.com/',
    '--add-header', 'Origin:https://www.youtube.com',
    '--extractor-args', 'youtube:player_client=web'
  ];

  const retryArgs = [
    '--sleep-requests','1',
    '--retries','8',
    '--fragment-retries','8',
    '--concurrent-fragments','1'
  ];

  const formatSelector = 'bestaudio* / bestaudio / best';

  const args = [
    '-v',
    '--no-cache-dir', '--rm-cache-dir',
    '--restrict-filenames',
    '--force-ipv4',
    '--geo-bypass',
    '--no-playlist',
    '--match-filter', '!is_live',
    '-x', '--audio-format', format,
    '-o', outBase,
    '-f', formatSelector,
    ...extractorArgs,
    ...retryArgs,
    url
  ];

  if (cookiesPath) args.splice(args.length - 1, 0, '--cookies', cookiesPath);

  return args;
}

// ---------- routes ----------

app.get('/', (_req, res) => {
  res.status(200).send('ok – try /health, /doctor, or /extract?url=<youtube>&format=mp3');
});

app.get('/health', (_req, res) => res.status(200).send('ok'));

app.get('/doctor', async (_req, res) => {
  try {
    const yv = await run('yt-dlp', ['--version']);
    const fv = await run('ffmpeg', ['-version']);
    res.json({
      ytdlp_version: (yv.out || yv.err).split('\n')[0].trim(),
      ffmpeg_version: (fv.out.split('\n')[0] || '').trim(),
      writable_tmp: fs.existsSync('/tmp')
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/extract', async (req, res) => {
  try {
    const rawUrl = req.query.url;
    if (!rawUrl) return res.status(400).json({ error: 'Missing ?url' });

    const format = (req.query.format || 'mp3').toLowerCase();
    const upload = String(req.query.upload || 'false') === 'true';
    const debug = String(req.query.debug || '0') === '1';

    const outBase = path.join('/tmp', '%(id)s.%(ext)s');

    // Write cookies if provided
    let cookiesPath = '';
    if (COOKIES_RAW) {
      cookiesPath = path.join('/tmp', `cookies_${Date.now()}.txt`);
      fs.writeFileSync(cookiesPath, COOKIES_RAW, { mode: 0o600 });
    }

    const args = buildYtDlpArgs({ url: rawUrl, format, outBase, cookiesPath });

    try {
      const result = await run('yt-dlp', args);
      if (debug) console.log(result.err || result.out);
    } catch (err) {
      if (cookiesPath) cleanup(cookiesPath);
      return res.status(500).json({
        error: 'yt-dlp exited 1',
        hint: 'If detail shows LOGIN_REQUIRED, refresh cookies from youtube.com + google.com + accounts.google.com and redeploy.',
        detail: err.message || String(err)
      });
    }

    // Pick the most recent file
    const candidates = fs.readdirSync('/tmp').filter(f => f.toLowerCase().endsWith(`.${format}`));
    if (!candidates.length) {
      if (cookiesPath) cleanup(cookiesPath);
      return res.status(500).json({ error: 'No output file produced by yt-dlp' });
    }
    candidates.sort((a, b) => fs.statSync(path.join('/tmp', b)).mtimeMs - fs.statSync(path.join('/tmp', a)).mtimeMs);
    const filePath = path.join('/tmp', candidates[0]);
    const fileName = path.basename(filePath);

    // If upload requested
    if (upload && storage && BUCKET) {
      await storage.bucket(BUCKET).upload(filePath, { destination: fileName, resumable: false });
      const [signedUrl] = await storage.bucket(BUCKET).file(fileName).getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + 15 * 60 * 1000
      });
      cleanup(filePath);
      if (cookiesPath) cleanup(cookiesPath);
      return res.json({ bucket: BUCKET, object: fileName, url: signedUrl });
    }

    // Otherwise stream back
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', format === 'mp3' ? 'audio/mpeg' : 'audio/wav');
    const stream = fs.createReadStream(filePath);
    stream.on('close', () => {
      cleanup(filePath);
      if (cookiesPath) cleanup(cookiesPath);
    });
    stream.pipe(res);

  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

// ---------- start ----------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`listening on 0.0.0.0:${PORT}`);
});
