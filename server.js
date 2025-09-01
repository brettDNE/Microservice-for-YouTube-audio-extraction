import express from 'express';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const PORT = process.env.PORT || 8080;
const app = express();

let storage = null;
const BUCKET = process.env.BUCKET;
if (BUCKET) {
  const { Storage } = await import('@google-cloud/storage');
  storage = new Storage();
}

app.get('/health', (_req, res) => res.status(200).send('ok'));

app.get('/extract', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({error: 'Missing ?url'});

    const format = (req.query.format || 'mp3').toLowerCase();
    const upload = String(req.query.upload || 'false') === 'true';

    // Always use /tmp on Cloud Run
    const outBase = path.join('/tmp', '%(id)s.%(ext)s');

    // Build yt-dlp args: extract audio, set audio format, write to /tmp
    const args = [
      '-x',
      '--audio-format', format,
      '-o', outBase,
      '--no-playlist',
      url
    ];

    // Run yt-dlp
    await run('yt-dlp', args);

    // Find the produced file in /tmp (best effort)
    const files = fs.readdirSync('/tmp').filter(f => f.endsWith(`.${format}`));
    if (!files.length) {
      return res.status(500).json({error: 'No output file produced'});
    }

    const filePath = path.join('/tmp', files[0]);

    if (upload && storage && BUCKET) {
      const destName = path.basename(filePath);
      await storage.bucket(BUCKET).upload(filePath, {destination: destName, resumable: false});

      // Option B: signed URL (private bucket)
      const [signedUrl] = await storage.bucket(BUCKET).file(destName).getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + 15 * 60 * 1000 // 15 min
      });
      cleanup(filePath);
      return res.json({bucket: BUCKET, object: destName, url: signedUrl});
    }

    // Stream file back directly
    res.setHeader('Content-Type', format === 'mp3' ? 'audio/mpeg' : 'audio/wav');
    const stream = fs.createReadStream(filePath);
    stream.on('close', () => cleanup(filePath));
    stream.pipe(res);

  } catch (err) {
    console.error(err);
    res.status(500).json({error: String(err.message || err)});
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`listening on 0.0.0.0:${PORT}`);
});

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {stdio: ['ignore', 'inherit', 'inherit']});
    p.on('error', reject);
    p.on('exit', code => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
  });
}

function cleanup(p) {
  try { fs.unlinkSync(p); } catch {}
}
