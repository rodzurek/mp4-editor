import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5178);
const HOST = process.env.HOST || '127.0.0.1';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
const YTDLP = process.env.YTDLP || 'yt-dlp';
const YTDLP_MAX_HEIGHT = Math.max(144, Number(process.env.YTDLP_MAX_HEIGHT) || 1080);

// Every path the app touches must sit inside one of these. Colon-separated on
// Linux, semicolon-separated on Windows (path.delimiter).
const MEDIA_ROOTS = (process.env.MEDIA_ROOTS || os.homedir())
  .split(path.delimiter)
  .map((dir) => dir.trim())
  .filter(Boolean)
  .map((dir) => {
    try {
      return fs.realpathSync(path.resolve(dir));
    } catch {
      return path.resolve(dir);
    }
  });

const TOKEN = process.env.TOKEN || crypto.randomBytes(16).toString('hex');
const COOKIE = 'mp4trim';

const norm = process.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s;

// Resolves symlinks as far as the path exists, so a link inside a root cannot
// point out of it, and a not-yet-created output file still gets checked.
function realOrNearest(target) {
  let cur = path.resolve(target);
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail.slice().reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(target);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

// Returns the resolved path when it lives under an allowed root, else null.
function allowed(target) {
  if (!target) return null;
  const real = realOrNearest(target);
  const key = norm(real);
  const ok = MEDIA_ROOTS.some((root) => key === norm(root) || key.startsWith(norm(root + path.sep)));
  return ok ? real : null;
}

function tokenOk(candidate) {
  if (!candidate) return false;
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cookieToken(req) {
  const header = req.headers.cookie || '';
  const hit = header.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`));
  return hit ? decodeURIComponent(hit.slice(COOKIE.length + 1)) : null;
}

// Token arrives once in the URL, then lives in a cookie so <video src> and
// XHR uploads authenticate without touching every request in the client.
function authorize(req, res, url) {
  if (tokenOk(cookieToken(req))) return true;

  const supplied = url.searchParams.get('token') || req.headers['x-token'];
  if (tokenOk(supplied)) {
    res.setHeader('set-cookie', `${COOKIE}=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
    return true;
  }

  json(res, 401, { error: 'bad or missing token — open the URL printed by the server' });
  return false;
}

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

async function browse(dir) {
  const requested = dir ? allowed(dir) : MEDIA_ROOTS[0];
  const cwd = requested && fs.existsSync(requested) ? requested : MEDIA_ROOTS[0];
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
    parent: allowed(path.dirname(cwd)) && path.dirname(cwd) !== cwd ? path.dirname(cwd) : null,
    roots: MEDIA_ROOTS,
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

const MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
};

function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

// Same bytes as /api/video, but asks the browser to save instead of play.
function download(res, file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return json(res, 404, { error: 'file not found' });
  }

  const name = path.basename(file);
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');

  res.writeHead(200, {
    'content-type': mimeFor(file),
    'content-length': stat.size,
    'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
  });
  fs.createReadStream(file).pipe(res);
}

function streamVideo(req, res, file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return json(res, 404, { error: 'file not found' });
  }

  const type = mimeFor(file);
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

// Uploads land inside a root so the trimmer can read them back under the same rules.
const UPLOAD_DIR = allowed(process.env.UPLOAD_DIR || path.join(MEDIA_ROOTS[0], '_uploads'));

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

  const safe = allowed(text);
  if (!safe) return null;

  try {
    const stat = fs.statSync(safe);
    if (!stat.isFile()) return null;
    return { path: safe, size: stat.size };
  } catch {
    return null;
  }
}

// Fallback for browser-dropped File objects, which carry a name but never a path:
// look for a matching name+size in the directory the user is already browsing.
async function findByName(name, size, hint) {
  const dirs = [hint, ...MEDIA_ROOTS].map((dir) => dir && allowed(dir));
  const seen = new Set();
  const base = path.basename(String(name || ''));
  if (!base) return null;

  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const candidate = path.join(dir, base);
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
  if (!UPLOAD_DIR) return json(res, 500, { error: 'UPLOAD_DIR is outside the allowed roots' });

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

  const { input, start, end, output, reencode, overwrite } = opts;
  const src = allowed(input);
  const dst = allowed(output);
  if (!src || !fs.existsSync(src)) return json(res, 400, { error: 'input not found inside an allowed root' });
  if (!output) return json(res, 400, { error: 'no output path' });
  if (!dst) return json(res, 400, { error: 'output is outside the allowed roots' });
  if (src === dst) return json(res, 400, { error: 'output must differ from input' });
  if (fs.existsSync(dst) && !overwrite) return json(res, 409, { error: `${dst} already exists — tick overwrite to replace it` });

  // Keep timestamps numeric so they can never arrive looking like an ffmpeg flag.
  const from = Number(start);
  const to = end == null || end === '' ? null : Number(end);
  if (!Number.isFinite(from) || from < 0) return json(res, 400, { error: 'bad start time' });
  if (to != null && (!Number.isFinite(to) || to <= from)) return json(res, 400, { error: 'bad end time' });

  const args = ['-hide_banner', '-y'];
  if (reencode) {
    // Accurate cut: seek after -i so the decoder trims at the exact frame.
    args.push('-i', src, '-ss', String(from));
    if (to != null) args.push('-to', String(to));
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k');
  } else {
    args.push('-ss', String(from));
    if (to != null) args.push('-to', String(to));
    args.push('-i', src, '-c', 'copy', '-avoid_negative_ts', 'make_zero');
  }
  args.push(dst);

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
  child.on('close', (code) => res.end(code === 0 ? `\n__DONE__ ${dst}\n` : `\n__ERROR__ ffmpeg exited with code ${code}\n`));
  req.on('close', () => child.killed || child.kill('SIGKILL'));
}

// Permanently removes one video file. Only regular files with a video
// extension inside the allowed roots; never directories or symlinks.
async function remove(req, res) {
  let opts;
  try {
    opts = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: 'bad json' });
  }

  const given = opts.path ? path.resolve(String(opts.path)) : null;
  const file = allowed(given);
  if (!file) return json(res, 403, { error: 'path outside the allowed roots' });
  if (!VIDEO_EXT.has(path.extname(file).toLowerCase())) return json(res, 400, { error: 'only video files can be deleted' });

  let stat;
  try {
    stat = await fsp.lstat(given);
  } catch {
    return json(res, 404, { error: 'file not found' });
  }
  if (!stat.isFile()) return json(res, 400, { error: 'not a regular file' });

  try {
    await fsp.unlink(file);
  } catch (e) {
    const busy = e.code === 'EBUSY' || e.code === 'EPERM';
    return json(res, busy ? 409 : 500, { error: busy ? 'file is in use — stop playback and try again' : e.message });
  }
  json(res, 200, { deleted: file });
}

// Pulls a video from a URL (YouTube or anything else yt-dlp supports) into
// UPLOAD_DIR, streaming yt-dlp's output back so the browser can show progress.
async function fetchUrl(req, res) {
  if (!UPLOAD_DIR) return json(res, 500, { error: 'UPLOAD_DIR is outside the allowed roots' });

  let opts;
  try {
    opts = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: 'bad json' });
  }

  let link;
  try {
    link = new URL(String(opts.url || '').trim());
  } catch {
    return json(res, 400, { error: 'not a valid URL' });
  }
  if (link.protocol !== 'http:' && link.protocol !== 'https:') {
    return json(res, 400, { error: 'only http and https links are accepted' });
  }

  await fsp.mkdir(UPLOAD_DIR, { recursive: true });

  // Prefer H.264 + AAC so the browser previews it and stream-copy trims stay lossless.
  const h = YTDLP_MAX_HEIGHT;
  const format = [
    `bv*[height<=${h}][vcodec^=avc1]+ba[ext=m4a]`,
    `bv*[height<=${h}][ext=mp4]+ba[ext=m4a]`,
    `b[height<=${h}][ext=mp4]`,
    `bv*[height<=${h}]+ba`,
    `b[height<=${h}]`,
    'b',
  ].join('/');

  const args = [
    '--newline',
    '--progress',
    '--no-playlist',
    '--no-mtime',
    '--restrict-filenames',
    '-f', format,
    '--merge-output-format', 'mp4',
    '-o', path.join(UPLOAD_DIR, '%(title).80B [%(id)s].%(ext)s'),
    '--print', 'after_move:__FILE__ %(filepath)s',
  ];
  // Only point yt-dlp at ffmpeg when it was configured as an explicit path.
  if (process.env.FFMPEG) args.push('--ffmpeg-location', process.env.FFMPEG);
  // "--" stops option parsing, so the URL can never be read as a yt-dlp flag.
  args.push('--', link.href);

  res.writeHead(200, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-cache',
    'x-accel-buffering': 'no',
  });
  res.write(`$ yt-dlp ${link.href}\n`);

  const child = spawn(YTDLP, args, {
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });

  let out = '';
  child.stdout.on('data', (d) => {
    out += d;
    res.write(d);
  });
  child.stderr.on('data', (d) => res.write(d));
  child.on('error', (e) => {
    const hint = e.code === 'ENOENT' ? `yt-dlp not found as "${YTDLP}" — install it or set YTDLP` : e.message;
    res.end(`\n__ERROR__ ${hint}\n`);
  });
  child.on('close', (code) => {
    if (res.writableEnded) return;
    if (code !== 0) return res.end(`\n__ERROR__ yt-dlp exited with code ${code}\n`);

    const line = out.split(/\r?\n/).reverse().find((l) => l.startsWith('__FILE__ '));
    const file = line && allowed(line.slice('__FILE__ '.length).trim());
    if (!file || !fs.existsSync(file)) return res.end('\n__ERROR__ yt-dlp finished but the file could not be located\n');
    res.end(`\n__DONE__ ${file}\n`);
  });
  req.on('close', () => child.killed || child.exitCode != null || child.kill('SIGKILL'));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (!authorize(req, res, url)) return;

    if (req.method === 'GET' && STATIC[url.pathname]) {
      // Drop the token from the address bar once the cookie is set.
      if (url.pathname === '/' && url.searchParams.has('token')) {
        res.writeHead(302, { location: '/' });
        return res.end();
      }
      const [rel, type] = STATIC[url.pathname];
      res.writeHead(200, { 'content-type': type });
      return fs.createReadStream(path.join(ROOT, rel)).pipe(res);
    }

    if (req.method === 'GET' && url.pathname === '/api/browse') {
      return json(res, 200, await browse(url.searchParams.get('dir')));
    }

    if (req.method === 'GET' && url.pathname === '/api/probe') {
      const file = allowed(url.searchParams.get('path'));
      if (!file) return json(res, 403, { error: 'path outside the allowed roots' });
      return json(res, 200, await probe(file));
    }

    if (req.method === 'GET' && url.pathname === '/api/keyframes') {
      const file = allowed(url.searchParams.get('path'));
      if (!file) return json(res, 403, { error: 'path outside the allowed roots' });
      return json(res, 200, {
        times: await keyframes(file, url.searchParams.get('from'), url.searchParams.get('window')),
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/download') {
      const file = allowed(url.searchParams.get('path'));
      if (!file) return json(res, 403, { error: 'path outside the allowed roots' });
      return download(res, file);
    }

    if (req.method === 'GET' && url.pathname === '/api/video') {
      const file = allowed(url.searchParams.get('path'));
      if (!file) return json(res, 403, { error: 'path outside the allowed roots' });
      return streamVideo(req, res, file);
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

    if (req.method === 'POST' && url.pathname === '/api/delete') {
      return await remove(req, res);
    }

    if (req.method === 'POST' && url.pathname === '/api/fetch') {
      return await fetchUrl(req, res);
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

const ytdlp = await run(YTDLP, ['--version']);
if (ytdlp.code !== 0) {
  console.error(`yt-dlp not runnable as "${YTDLP}" — pasting video links will not work. Install it or set YTDLP.`);
}

if (!UPLOAD_DIR) {
  console.error('UPLOAD_DIR is outside MEDIA_ROOTS — drag-and-drop uploads will be refused.');
}

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' || HOST === '::' ? os.hostname() : HOST;
  console.log(`mp4 trimmer  http://${shown}:${PORT}/?token=${TOKEN}`);
  console.log(`roots: ${MEDIA_ROOTS.join(path.delimiter)}`);
  if (!process.env.TOKEN) console.log('token is random this boot; set TOKEN=... to keep it stable');
});
