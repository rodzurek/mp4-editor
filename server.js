import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5178);
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['public/app.css', 'text/css; charset=utf-8'],
};

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.ts', '.m2ts', '.mts', '.flv', '.wmv']);

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => resolve({ code: -1, out, err: e.message }));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

async function listDrives() {
  const drives = [];
  for (let c = 65; c <= 90; c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    try {
      await fsp.access(root);
      drives.push(root);
    } catch {
      /* drive not present */
    }
  }
  return drives;
}

async function browse(dir) {
  const target = dir ? path.resolve(dir) : path.join(os.homedir(), '');
  const cwd = fs.existsSync(target) ? target : os.homedir();
  const entries = await fsp.readdir(cwd, { withFileTypes: true });
  const dirs = [];
  const files = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(cwd, entry.name);
    if (entry.isDirectory()) {
      dirs.push({ name: entry.name, path: full });
    } else if (VIDEO_EXT.has(path.extname(entry.name).toLowerCase())) {
      let size = 0;
      try {
        size = (await fsp.stat(full)).size;
      } catch {
        /* unreadable */
      }
      files.push({ name: entry.name, path: full, size });
    }
  }

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  dirs.sort((a, b) => collator.compare(a.name, b.name));
  files.sort((a, b) => collator.compare(a.name, b.name));

  return {
    cwd,
    parent: path.dirname(cwd) === cwd ? null : path.dirname(cwd),
    drives: process.platform === 'win32' ? await listDrives() : ['/'],
    dirs,
    files,
  };
}

async function probe(file) {
  const { code, out, err } = await run(FFPROBE, [
    '-v', 'error',
    '-show_entries', 'format=duration,size,format_name',
    '-show_entries', 'stream=index,codec_type,codec_name,width,height,r_frame_rate',
    '-of', 'json',
    file,
  ]);
  if (code !== 0) throw new Error(err || 'ffprobe failed');
  return JSON.parse(out);
}

// Keyframe timestamps in [from, from+window). Stream copy can only cut at these.
async function keyframes(file, from, window) {
  const start = Math.max(0, Number(from) || 0);
  const span = Math.max(1, Number(window) || 60);
  const { code, out, err } = await run(FFPROBE, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-skip_frame', 'nokey',
    '-show_entries', 'frame=pts_time',
    '-of', 'csv=p=0',
    '-read_intervals', `${start}%+${span}`,
    file,
  ]);
  if (code !== 0) throw new Error(err || 'ffprobe failed');
  return out
    .split(/\r?\n/)
    .map((line) => line.replace(/,+$/, '').trim())
    .filter((line) => line !== '')
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
}

function streamVideo(req, res, file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return json(res, 404, { error: 'file not found' });
  }

  const type = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska' }[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;

  if (!range) {
    res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'accept-ranges': 'bytes' });
    return fs.createReadStream(file).pipe(res);
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : stat.size - 1;
  if (start >= stat.size || end >= stat.size || start > end) {
    res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
    return res.end();
  }

  res.writeHead(206, {
    'content-type': type,
    'content-range': `bytes ${start}-${end}/${stat.size}`,
    'accept-ranges': 'bytes',
    'content-length': end - start + 1,
  });
  fs.createReadStream(file, { start, end }).pipe(res);
}

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(os.tmpdir(), 'mp4-trimmer');

// Turns whatever a drop event produced (plain path, file:// URI, quoted path) into a real file.
function resolveDropped(raw) {
  let text = String(raw || '').trim().replace(/^"(.*)"$/, '$1');
  if (!text) return null;

  if (/^file:\/\//i.test(text)) {
    try {
      text = fileURLToPath(text);
    } catch {
      return null;
    }
  }

  try {
    const stat = fs.statSync(text);
    if (!stat.isFile()) return null;
    return { path: path.resolve(text), size: stat.size };
  } catch {
    return null;
  }
}

// Fallback for browser-dropped File objects, which carry a name but never a path:
// look for a matching name+size in the directory the user is already browsing.
async function findByName(name, size, hint) {
  const dirs = [hint, path.join(os.homedir(), ''), path.join(os.homedir(), 'Downloads'), path.join(os.homedir(), 'Desktop')];
  const seen = new Set();

  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const candidate = path.join(dir, name);
    try {
      const stat = await fsp.stat(candidate);
      if (stat.isFile() && (!size || stat.size === Number(size))) {
        return { path: candidate, size: stat.size };
      }
    } catch {
      /* not here */
    }
  }
  return null;
}

// Last resort: stream the dropped bytes to a temp file so ffmpeg has something on disk.
async function upload(req, res, name) {
  const safe = path.basename(String(name || 'dropped.mp4')).replace(/[<>:"|?*]/g, '_');
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });

  let target = path.join(UPLOAD_DIR, safe);
  if (fs.existsSync(target)) {
    const ext = path.extname(safe);
    target = path.join(UPLOAD_DIR, `${path.basename(safe, ext)}-${Date.now()}${ext}`);
  }

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(target);
    req.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    req.on('error', reject);
    req.on('aborted', () => {
      out.destroy();
      reject(new Error('upload aborted'));
    });
  });

  const stat = await fsp.stat(target);
  json(res, 200, { path: target, size: stat.size, uploaded: true });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Streams ffmpeg stderr back to the browser as it runs.
async function trim(req, res) {
  let opts;
  try {
    opts = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: 'bad json' });
  }

  const { input, start, end, output, reencode } = opts;
  if (!input || !fs.existsSync(input)) return json(res, 400, { error: 'input not found' });
  if (!output) return json(res, 400, { error: 'no output path' });
  if (path.resolve(input) === path.resolve(output)) return json(res, 400, { error: 'output must differ from input' });

  const args = ['-hide_banner', '-y'];
  if (reencode) {
    // Accurate cut: seek after -i so the decoder trims at the exact frame.
    args.push('-i', input, '-ss', String(start));
    if (end != null && end !== '') args.push('-to', String(end));
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k');
  } else {
    args.push('-ss', String(start));
    if (end != null && end !== '') args.push('-to', String(end));
    args.push('-i', input, '-c', 'copy', '-avoid_negative_ts', 'make_zero');
  }
  args.push(output);

  res.writeHead(200, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-cache',
    'x-accel-buffering': 'no',
  });
  res.write(`$ ffmpeg ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}\n`);

  const child = spawn(FFMPEG, args, { windowsHide: true });
  child.stderr.on('data', (d) => res.write(d));
  child.stdout.on('data', (d) => res.write(d));
  child.on('error', (e) => res.end(`\n__ERROR__ ${e.message}\n`));
  child.on('close', (code) => res.end(code === 0 ? `\n__DONE__ ${output}\n` : `\n__ERROR__ ffmpeg exited with code ${code}\n`));
  req.on('close', () => child.killed || child.kill('SIGKILL'));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [rel, type] = STATIC[url.pathname];
      res.writeHead(200, { 'content-type': type });
      return fs.createReadStream(path.join(ROOT, rel)).pipe(res);
    }

    if (req.method === 'GET' && url.pathname === '/api/browse') {
      return json(res, 200, await browse(url.searchParams.get('dir')));
    }

    if (req.method === 'GET' && url.pathname === '/api/probe') {
      return json(res, 200, await probe(url.searchParams.get('path')));
    }

    if (req.method === 'GET' && url.pathname === '/api/keyframes') {
      return json(res, 200, {
        times: await keyframes(url.searchParams.get('path'), url.searchParams.get('from'), url.searchParams.get('window')),
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/video') {
      return streamVideo(req, res, url.searchParams.get('path'));
    }

    if (req.method === 'POST' && url.pathname === '/api/trim') {
      return await trim(req, res);
    }

    // Drop resolution: try the dropped text as a path, then a name+size match on disk.
    if (req.method === 'GET' && url.pathname === '/api/resolve') {
      const text = url.searchParams.get('text');
      const hit = text
        ? resolveDropped(text)
        : await findByName(url.searchParams.get('name'), url.searchParams.get('size'), url.searchParams.get('hint'));
      return json(res, 200, hit ? { ...hit, found: true } : { found: false });
    }

    if (req.method === 'POST' && url.pathname === '/api/upload') {
      return await upload(req, res, url.searchParams.get('name'));
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: String(e.message || e) });
    else res.end();
  }
});

const { code } = await run(FFMPEG, ['-version']);
if (code !== 0) {
  console.error(`ffmpeg not runnable as "${FFMPEG}". Set FFMPEG/FFPROBE env vars to full paths.`);
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mp4 trimmer: http://127.0.0.1:${PORT}`);
});
