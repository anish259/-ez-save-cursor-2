const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from workspace root
app.use(express.static(path.join(__dirname)));

// Helper: spawn a process and collect output
function spawnProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, ...options });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr, code });
      else reject(new Error(stderr || `Process exited with code ${code}`));
    });
  });
}

// Robust yt-dlp resolver (Windows-friendly)
let cachedYtDlp = null;
async function resolveYtDlp() {
  if (cachedYtDlp) return cachedYtDlp;
  const candidates = [];
  if (process.env.YTDLP_PATH) candidates.push({ command: process.env.YTDLP_PATH, prefix: [] });
  candidates.push({ command: 'yt-dlp', prefix: [] });
  candidates.push({ command: 'yt-dlp.exe', prefix: [] });
  candidates.push({ command: 'python', prefix: ['-m', 'yt_dlp'] });
  candidates.push({ command: 'py', prefix: ['-m', 'yt_dlp'] });
  for (const c of candidates) {
    try {
      await spawnProcess(c.command, [...c.prefix, '--version']);
      cachedYtDlp = c;
      return cachedYtDlp;
    } catch (_) {
      // try next
    }
  }
  throw new Error('yt-dlp not found. Install yt-dlp or set YTDLP_PATH to the executable.');
}

async function spawnYtDlp(args, options = {}) {
  const { command, prefix } = await resolveYtDlp();
  return spawn(command, [...prefix, ...args], { shell: false, ...options });
}

async function runYtDlpCollect(args, options = {}) {
  const { command, prefix } = await resolveYtDlp();
  return spawnProcess(command, [...prefix, ...args], options);
}

// GET /api/info?url=...
app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  try {
    const { stdout } = await runYtDlpCollect(['-J', '--no-warnings', url]);
    const info = JSON.parse(stdout);
    // Normalize common fields for frontend convenience
    const normalized = {
      id: info.id,
      title: info.title,
      uploader: info.uploader || info.channel || null,
      thumbnail: info.thumbnail || (info.thumbnails && info.thumbnails[info.thumbnails.length - 1]?.url) || null,
      duration: info.duration,
      formats: (info.formats || []).map((f) => ({
        format_id: f.format_id,
        ext: f.ext,
        format_note: f.format_note,
        vcodec: f.vcodec,
        acodec: f.acodec,
        height: f.height,
        fps: f.fps,
        filesize: f.filesize || f.filesize_approx || null,
      })),
    };
    res.json(normalized);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch info', details: String(err.message || err) });
  }
});

function generateTempTemplate() {
  const id = crypto.randomBytes(8).toString('hex');
  const dir = os.tmpdir();
  const template = path.join(dir, `ezsave-${id}.%(ext)s`);
  return { id, dir, template };
}

function findActualFile(dir, id) {
  const prefix = `ezsave-${id}.`;
  const candidates = fs.readdirSync(dir).filter((f) => f.startsWith(prefix));
  if (candidates.length === 0) return null;
  // Prefer mp4/mkv/mp3/m4a if multiple
  const preferredOrder = ['mp4', 'mkv', 'webm', 'mp3', 'm4a', 'aac', 'opus'];
  candidates.sort((a, b) => preferredOrder.indexOf(path.extname(a).slice(1)) - preferredOrder.indexOf(path.extname(b).slice(1)));
  return path.join(dir, candidates[0]);
}

// GET /api/download?url=...&choice=best|144p|240p|360p|480p|720p|1080p|1440p|2160p|audio-mp3|audio-aac|audio-m4a or &format_id=xyz
app.get('/api/download', async (req, res) => {
  const { url, choice, format_id } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  const { id, dir, template } = generateTempTemplate();

  // Build yt-dlp args
  const args = ['-o', template, '--no-playlist'];

  // Enable merge via ffmpeg where needed
  // yt-dlp auto-detects ffmpeg and merges when selecting video+audio formats
  if (format_id) {
    args.push('-f', format_id);
  } else if (choice) {
    const selectForHeight = (h) => `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${h}][ext=mp4]/bestvideo[height<=${h}]+bestaudio/best[height<=${h}]`;
    const setMerge = (h) => {
      // Prefer mp4 for <=1080, mkv for >1080 to avoid codec/container issues that can drop audio
      args.push('--merge-output-format', h > 1080 ? 'mkv' : 'mp4');
    };
    switch (choice) {
      case 'best':
        args.push('-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best');
        setMerge(1080);
        break;
      case '144p': args.push('-f', selectForHeight(144)); setMerge(144); break;
      case '240p': args.push('-f', selectForHeight(240)); setMerge(240); break;
      case '360p': args.push('-f', selectForHeight(360)); setMerge(360); break;
      case '480p': args.push('-f', selectForHeight(480)); setMerge(480); break;
      case '720p': args.push('-f', selectForHeight(720)); setMerge(720); break;
      case '1080p': args.push('-f', selectForHeight(1080)); setMerge(1080); break;
      case '1440p': args.push('-f', selectForHeight(1440)); setMerge(1440); break;
      case '2160p': args.push('-f', selectForHeight(2160)); setMerge(2160); break;
      case 'audio-mp3': args.push('-x', '--audio-format', 'mp3'); break;
      case 'audio-aac': args.push('-x', '--audio-format', 'aac'); break;
      case 'audio-m4a': args.push('-x', '--audio-format', 'm4a'); break;
      default:
        args.push('-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best');
        setMerge(1080);
    }
  } else {
    args.push('-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best');
    args.push('--merge-output-format', 'mp4');
  }

  args.push(url);

  try {
    const child = await spawnYtDlp(args, { cwd: dir });
    await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('yt-dlp exited with code ' + code))));
    });
    const filePath = findActualFile(dir, id);
    if (!filePath) {
      return res.status(500).json({ error: 'Download finished but file not found' });
    }

    const filename = path.basename(filePath);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    const stream = fs.createReadStream(filePath);
    stream.on('close', () => {
      // Clean up temp file after sending
      fs.unlink(filePath, () => {});
    });
    stream.pipe(res);
  } catch (err) {
    res.status(500).json({ error: 'Download failed', details: String(err.message || err) });
  }
});

// In-memory job store for SSE-based progress
const jobs = new Map();

function buildArgsForChoice(choice, format_id, template) {
  const args = ['-o', template, '--no-playlist'];
  if (format_id) {
    args.push('-f', format_id);
    return args;
  }
  const selectForHeight = (h) => `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${h}][ext=mp4]/bestvideo[height<=${h}]+bestaudio/best[height<=${h}]`;
  const setMerge = (h, arr) => arr.push('--merge-output-format', h > 1080 ? 'mkv' : 'mp4');
  switch (choice) {
    case 'best':
      args.push('-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best');
      setMerge(1080, args);
      break;
    case '144p': args.push('-f', selectForHeight(144)); setMerge(144, args); break;
    case '240p': args.push('-f', selectForHeight(240)); setMerge(240, args); break;
    case '360p': args.push('-f', selectForHeight(360)); setMerge(360, args); break;
    case '480p': args.push('-f', selectForHeight(480)); setMerge(480, args); break;
    case '720p': args.push('-f', selectForHeight(720)); setMerge(720, args); break;
    case '1080p': args.push('-f', selectForHeight(1080)); setMerge(1080, args); break;
    case '1440p': args.push('-f', selectForHeight(1440)); setMerge(1440, args); break;
    case '2160p': args.push('-f', selectForHeight(2160)); setMerge(2160, args); break;
    case 'audio-mp3': args.push('-x', '--audio-format', 'mp3'); break;
    case 'audio-aac': args.push('-x', '--audio-format', 'aac'); break;
    case 'audio-m4a': args.push('-x', '--audio-format', 'm4a'); break;
    default:
      args.push('-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best');
      setMerge(1080, args);
  }
  return args;
}

// GET /api/progress?url=...&choice=...&format_id=...
// Streams Server-Sent Events with progress, ends with done event containing job id and filename
app.get('/api/progress', async (req, res) => {
  const { url, choice, format_id } = req.query;
  if (!url) {
    res.writeHead(400, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: fail\n`);
    res.write(`data: ${JSON.stringify({ error: 'Missing url' })}\n\n`);
    return res.end();
  }

  const { id, dir, template } = generateTempTemplate();
  const args = buildArgsForChoice(choice, format_id, template);
  args.push(url);

  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  // Disable timeouts to avoid server closing long downloads
  req.socket.setTimeout(0);
  res.setTimeout?.(0);
  res.flushHeaders?.();
  // Suggest client retry interval and send padding to bust proxy buffers
  try { res.write(`retry: 10000\n`); } catch (_) {}
  try { res.write(`:${' '.repeat(2048)}\n\n`); } catch (_) {}

  jobs.set(id, { dir, template, filePath: null, percent: 0 });

  const child = await spawnYtDlp(args, { cwd: dir });

  // Heartbeat to keep SSE alive through proxies/browsers
  const heartbeat = setInterval(() => {
    try { res.write(`: keepalive\n\n`); } catch (_) {}
  }, 10000);

  // Emit initial progress=0 so UI shows immediately
  try {
    res.write(`event: progress\n`);
    res.write(`data: ${JSON.stringify({ id, percent: 0 })}\n\n`);
  } catch (_) {}

  const sendProgress = (percent, extra = {}) => {
    const payload = { id, percent, ...extra };
    try { res.write(`event: progress\n`); res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch (_) {}
  };

  child.stdout.on('data', (d) => {
    // Not typically used for progress, but could include metadata
  });
  child.stderr.on('data', (d) => {
    const text = d.toString();
    // Match patterns like: [download]  12.3% of ... at 2.1MiB/s ETA 00:13
    const m = text.match(/\[download\]\s+(\d{1,3}\.\d|\d{1,3})%/);
    if (m) {
      const percent = Math.max(0, Math.min(100, parseFloat(m[1])));
      jobs.get(id).percent = percent;
      sendProgress(percent);
    }
    if (/ERROR:/i.test(text)) {
      try { res.write(`event: fail\n`); res.write(`data: ${JSON.stringify({ error: text.trim() })}\n\n`); } catch (_) {}
    }
  });

  child.on('error', (err) => {
    clearInterval(heartbeat);
    try { res.write(`event: fail\n`); res.write(`data: ${JSON.stringify({ error: err.message || 'Spawn failed (yt-dlp not found?)' })}\n\n`); } catch (_) {}
    try { res.end(); } catch (_) {}
  });

  child.on('close', (code) => {
    clearInterval(heartbeat);
    if (code === 0) {
      const filePath = findActualFile(dir, id);
      if (filePath) {
        const filename = path.basename(filePath);
        const job = jobs.get(id) || {};
        job.filePath = filePath;
        jobs.set(id, job);
        try { res.write(`event: done\n`); res.write(`data: ${JSON.stringify({ id, filename })}\n\n`); } catch (_) {}
      } else {
        try { res.write(`event: fail\n`); res.write(`data: ${JSON.stringify({ error: 'File not found' })}\n\n`); } catch (_) {}
      }
    } else {
      try { res.write(`event: fail\n`); res.write(`data: ${JSON.stringify({ error: 'Download failed' })}\n\n`); } catch (_) {}
    }
    try { res.end(); } catch (_) {}
  });

  // If client disconnects, stop the job and cleanup
  req.on('close', () => {
    try { clearInterval(heartbeat); } catch (_) {}
    try { child.kill('SIGKILL'); } catch (_) {}
  });
});

// GET /api/file?id=...
app.get('/api/file', (req, res) => {
  const { id } = req.query;
  const job = jobs.get(id);
  if (!job || !job.filePath) return res.status(404).json({ error: 'Not ready' });
  const filename = path.basename(job.filePath);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const stream = fs.createReadStream(job.filePath);
  stream.on('close', () => {
    fs.unlink(job.filePath, () => {});
    jobs.delete(id);
  });
  stream.pipe(res);
});

// POLLING BASED APPROACH (alternative to SSE):
// POST /api/start { url, choice, format_id }
app.use(express.json());
app.post('/api/start', (req, res) => {
  const { url, choice, format_id } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Missing url' });

  const { id, dir, template } = generateTempTemplate();
  const args = buildArgsForChoice(choice, format_id, template);
  args.push(url);
  resolveYtDlp().then(({ command, prefix }) => {
    const child = spawn(command, [...prefix, ...args], { cwd: dir, shell: false });
    const state = { id, dir, template, filePath: null, percent: 0, status: 'running', error: null, cmd: [command, ...prefix] };
    jobs.set(id, state);

    child.stderr.on('data', (d) => {
      const text = d.toString();
      const m = text.match(/\[download\]\s+(\d{1,3}\.\d|\d{1,3})%/);
      if (m) {
        state.percent = Math.max(0, Math.min(100, parseFloat(m[1])));
      }
      if (/ERROR:/i.test(text)) {
        state.status = 'error';
        state.error = text.trim();
      }
    });

    child.on('error', (err) => {
      state.status = 'error';
      state.error = err.message || 'Spawn failed (yt-dlp not found?)';
    });

    child.on('close', (code) => {
      if (code === 0) {
        const filePath = findActualFile(dir, id);
        if (filePath) {
          state.filePath = filePath;
          state.status = 'done';
        } else {
          state.status = 'error';
          state.error = 'File not found';
        }
      } else if (state.status !== 'error') {
        state.status = 'error';
        state.error = 'Download failed';
      }
    });

    res.json({ id });
  }).catch((e) => {
    res.status(500).json({ error: e.message || 'yt-dlp not found' });
  });
});

// GET /api/status?id=...
app.get('/api/status', (req, res) => {
  const { id } = req.query;
  if (!id || !jobs.has(id)) return res.status(404).json({ error: 'Not found' });
  const j = jobs.get(id);
  res.json({ id: j.id, percent: j.percent, status: j.status, error: j.error, filename: j.filePath ? path.basename(j.filePath) : null, cmd: j.cmd || null });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`EZ Save server running at http://localhost:${PORT}`);
});


