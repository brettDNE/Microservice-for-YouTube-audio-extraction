// server.js (ESM)
// Cloud Run-friendly YouTube → audio microservice using yt-dlp + ffmpeg

import express from 'express';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const PORT = process.env.PORT || 8080;
const app = express();

// --- CORS (so you can call it from browser JS) ---
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
    let stderr = '';
    let stdout = '';
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', d => (stdout += d.toString()));
    p.stderr.on('data', d => (stderr += d.toString()));
    p.on('error', reject);
    p.on('exit', code => {
      if (code === 0) return resolve({ stdout, stderr });
      const err = new Error(`${cmd} exited ${code}`);
      err.code = code;
      err.stderr = stderr;
      err.stdout = stdout;
      reject(err);
    });
  });
}

function buildYtDlpArgs({ url, format, outBase, cookiesPath }) {
  const args = [
    '-v',
    '--no-cache-dir',
    '--rm-cache-dir',
    '--restrict-filenames',
    '--force-ipv4',
    '--geo-bypass',
    '--no-playlist',
    '-x', '--audio-format', format,
    '-o', outBase,
    '--extractor-args', 'youtube:player_client=android',
    '-f', 'bestaudio/best'
  ];
  if (cookiesPath) args.push('--cookies', cookiesPath);
  args.push(url);
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
      ytdlp_version: (yv.stdout || yv.stderr).split('\n')[0].trim(),
      ffmpeg_version: (fv.stdout.split('\n')[0] || '').trim(),
      writable_tmp: fs.existsSync('/tmp')
    });
  } catch (e) {
    res.status(500).json({ error: e.message, detail: (e.stderr || '').slice(-2000) });
  }
});

app.get('/extract', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'Missing ?url' });

    const format = (req.query.format || 'mp3').toLowerCase(); // mp3|wav
    const upload = String(req.query.upload || 'false') === 'true';
    const debug = String(req.query.debug || '0') === '1';

    const outBase = path.join('/tmp', '%(id)s.%(ext)s');

    // Optional: write cookies to /tmp if provided via env/secret
    let cookiesPath = '';
    if (COOKIES_RAW) {
      try {
        cookiesPath = path.join('/tmp', `cookies_${Date.now()}.txt`);
        fs.writeFileSync(cookiesPath, COOKIES_RAW, { mode: 0o600 });
      } catch (e) {
        console.warn('Failed to write cookies file:', e);
      }
    }

    // Run yt-dlp
    const args = buildYtDlpArgs({ url, format, outBase, cookiesPath });
    const result = await run('yt-dlp', args);
    if (debug) console.log(result.stderr || result.stdout);

    // Find the most recent produced file in /tmp
    const candidates = fs.readdirSync('/tmp').filter(f => f.toLowerCase().endsWith(`.${format}`));
    if (!candidates.length) {
      if (cookiesPath) cleanup(cookiesPath);
      return res.status(500).json({ error: 'No output file produced by yt-dlp' });
    }
    candidates.sort((a, b) => fs.statSync(path.join('/tmp', b)).mtimeMs - fs.statSync(path.join('/tmp', a)).mtimeMs);
    const filePath = path.join('/tmp', candidates[0]);

    // Force a friendly download filename when streaming
    const fileName = path.basename(filePath);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', format === 'mp3' ? 'audio/mpeg' : 'audio/wav');

    if (upload && storage && BUCKET) {
      const destName = fileName;
      await storage.bucket(BUCKET).upload(filePath, { destination: destName, resumable: false });
      const [signedUrl] = await storage.bucket(BUCKET).file(destName).getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + 15 * 60 * 1000 // 15 minutes
      });
      cleanup(filePath);
      if (cookiesPath) cleanup(cookiesPath);
      return res.json({ bucket: BUCKET, object: destName, url: signedUrl });
    }

    // Stream back directly
    const stream = fs.createReadStream(filePath);
    stream.on('close', () => {
      cleanup(filePath);
      if (cookiesPath) cleanup(cookiesPath);
    });
    stream.pipe(res);

  } catch (err) {
    console.error(err.stderr || err);
    return res.status(500).json({
      error: String(err.message || err),
      detail: req.query.debug === '1' ? (err.stderr || '').slice(-5000) : undefined
    });
  }
});

// ---------- start ----------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`listening on 0.0.0.0:${PORT}`);
});
