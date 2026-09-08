const el = (id) => document.getElementById(id);

const state = {
  cwd: null,
  file: null,
  duration: 0,
  running: false,
};

/* ---------- time helpers ---------- */

function fmt(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s - h * 3600 - m * 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${rest.toFixed(3).padStart(6, '0')}`;
}

function parse(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  const parts = value.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function humanSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

/* ---------- file browser ---------- */

async function browse(dir) {
  const res = await fetch(`/api/browse?dir=${encodeURIComponent(dir || '')}`);
  const data = await res.json();
  if (data.error) return setStatus(data.error, 'err');

  state.cwd = data.cwd;
  el('cwd').value = data.cwd;

  const list = el('list');
  list.innerHTML = '';

  const add = (label, target, isDir, size) => {
    const row = document.createElement('div');
    row.className = isDir ? 'row dir' : 'row';
    row.innerHTML = `<span class="name"></span>${size == null ? '' : `<span class="size">${humanSize(size)}</span>`}`;
    row.querySelector('.name').textContent = label;
    if (!isDir && target === state.file) row.classList.add('active');
    row.onclick = () => (isDir ? browse(target) : load(target));
    list.append(row);
  };

  for (const root of data.roots) add(root, root, true);
  if (data.parent) add('..', data.parent, true);
  for (const d of data.dirs) add(d.name, d.path, true);
  for (const f of data.files) add(f.name, f.path, false, f.size);
}

/* ---------- load a video ---------- */

async function load(file) {
  state.file = file;
  el('filename').textContent = file;
  const video = el('video');
  video.src = `/api/video?path=${encodeURIComponent(file)}`;
  video.load();

  el('start').value = '00:00:00.000';
  el('end').value = '';
  el('output').value = suggestOutput(file);
  el('kfinfo').textContent = '';
  el('download').hidden = true;
  setStatus('');

  try {
    const info = await (await fetch(`/api/probe?path=${encodeURIComponent(file)}`)).json();
    state.duration = Number(info?.format?.duration) || 0;
    const v = (info.streams || []).find((s) => s.codec_type === 'video') || {};
    const a = (info.streams || []).find((s) => s.codec_type === 'audio') || {};
    el('meta').textContent = [
      state.duration ? fmt(state.duration) : null,
      v.codec_name && `${v.codec_name} ${v.width}x${v.height}`,
      a.codec_name,
    ].filter(Boolean).join('  ·  ');
    if (state.duration) el('end').value = fmt(state.duration);
  } catch {
    el('meta').textContent = '';
  }

  syncTimeline();

  [...document.querySelectorAll('.row')].forEach((row) => {
    row.classList.toggle('active', row.querySelector('.name').textContent === file.split(/[\\/]/).pop() && !row.classList.contains('dir'));
  });
}

function suggestOutput(file) {
  const dot = file.lastIndexOf('.');
  const base = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : '.mp4';
  return `${base}_trim${ext}`;
}

/* ---------- marks ---------- */

function mark(which) {
  el(which).value = fmt(el('video').currentTime);
  refreshOutName();
  syncTimeline();
}

function seekTo(which) {
  const t = parse(el(which).value);
  if (t != null) el('video').currentTime = t;
}

function refreshOutName() {
  if (!state.file || el('output').dataset.touched === '1') return;
  el('output').value = suggestOutput(state.file);
}

// Stream copy cuts only at keyframes: snap start back to the nearest one at or before it.
async function snapStart() {
  if (!state.file) return;
  const start = parse(el('start').value) || 0;
  const from = Math.max(0, start - 30);
  const res = await fetch(`/api/keyframes?path=${encodeURIComponent(state.file)}&from=${from}&window=${start - from + 1}`);
  const { times = [], error } = await res.json();
  if (error) return setStatus(error, 'err');

  const before = times.filter((t) => t <= start + 0.001).pop();
  if (before == null) {
    el('kfinfo').textContent = 'no keyframe found in the 30 s before the in point';
    return;
  }
  el('start').value = fmt(before);
  el('video').currentTime = before;
  el('kfinfo').textContent = `snapped to keyframe at ${fmt(before)} (${(start - before).toFixed(3)} s earlier)`;
  syncTimeline();
}

/* ---------- timeline ---------- */

const MIN_SPAN = 0.05; // never let the handles cross or collapse

function currentMarks() {
  const start = parse(el('start').value) ?? 0;
  const end = parse(el('end').value);
  return { start, end: end == null ? state.duration : end };
}

function syncTimeline() {
  const d = state.duration;
  const { start, end } = currentMarks();
  const pct = (t) => (d > 0 ? Math.min(100, Math.max(0, (t / d) * 100)) : 0);
  const a = pct(start);
  const b = pct(end);

  el('tlSel').style.left = `${a}%`;
  el('tlSel').style.width = `${Math.max(0, b - a)}%`;
  el('tlIn').style.left = `${a}%`;
  el('tlOut').style.left = `${b}%`;
  el('tlPlayhead').style.left = `${pct(el('video').currentTime)}%`;

  el('tlIn2').textContent = fmt(start);
  el('tlOut2').textContent = fmt(end);
  el('tlLen').textContent = d > 0 ? `${(Math.max(0, end - start)).toFixed(3)} s selected` : '';
}

function timeAt(clientX) {
  const rect = el('tlTrack').getBoundingClientRect();
  const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
  return Math.min(state.duration, Math.max(0, ratio * state.duration));
}

function setMark(which, time, { seek = false } = {}) {
  const { start, end } = currentMarks();
  const t = which === 'start'
    ? Math.min(time, end - MIN_SPAN)
    : Math.max(time, start + MIN_SPAN);
  const clamped = Math.min(state.duration, Math.max(0, t));
  el(which).value = fmt(clamped);
  if (seek) el('video').currentTime = clamped;
  refreshOutName();
  syncTimeline();
}

function startHandleDrag(which, node) {
  node.addEventListener('pointerdown', (e) => {
    if (!state.duration) return;
    e.preventDefault();
    e.stopPropagation();
    node.setPointerCapture(e.pointerId);
    node.classList.add('dragging');

    const move = (ev) => setMark(which, timeAt(ev.clientX), { seek: true });
    const done = (ev) => {
      node.releasePointerCapture(ev.pointerId);
      node.classList.remove('dragging');
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', done);
      node.removeEventListener('pointercancel', done);
    };

    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', done);
    node.addEventListener('pointercancel', done);
  });
}

// Bare track = scrub the playhead (drag to keep scrubbing).
el('tlTrack').addEventListener('pointerdown', (e) => {
  if (!state.duration) return;
  const track = el('tlTrack');
  track.setPointerCapture(e.pointerId);
  el('video').currentTime = timeAt(e.clientX);
  syncTimeline();

  const move = (ev) => {
    el('video').currentTime = timeAt(ev.clientX);
    syncTimeline();
  };
  const done = (ev) => {
    track.releasePointerCapture(ev.pointerId);
    track.removeEventListener('pointermove', move);
    track.removeEventListener('pointerup', done);
    track.removeEventListener('pointercancel', done);
  };

  track.addEventListener('pointermove', move);
  track.addEventListener('pointerup', done);
  track.addEventListener('pointercancel', done);
});

startHandleDrag('start', el('tlIn'));
startHandleDrag('end', el('tlOut'));

/* ---------- trim ---------- */

function setStatus(text, kind = '') {
  const node = el('status');
  node.textContent = text;
  node.className = `status ${kind}`;
}

// The trimmed file lives on the server; pull it to whatever machine is viewing.
function offerDownload(file) {
  const url = `/api/download?path=${encodeURIComponent(file)}`;
  const name = file.split(/[\\/]/).pop();
  const box = el('download');

  box.hidden = false;
  box.innerHTML = '';
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.textContent = `download ${name}`;
  box.append(link);

  if (el('autodl').checked) link.click();
}

async function trim() {
  if (state.running) return;
  if (!state.file) return setStatus('pick a file first', 'err');

  const start = parse(el('start').value);
  const endText = el('end').value.trim();
  const end = endText ? parse(endText) : null;
  if (start == null) return setStatus('bad start time', 'err');
  if (endText && end == null) return setStatus('bad end time', 'err');
  if (end != null && end <= start) return setStatus('end must be after start', 'err');

  const body = {
    input: state.file,
    start: start.toFixed(3),
    end: end == null ? '' : end.toFixed(3),
    output: el('output').value.trim(),
    reencode: el('reencode').checked,
    overwrite: el('overwrite').checked,
  };

  state.running = true;
  el('trim').disabled = true;
  setStatus('running ffmpeg…');
  el('log').textContent = '';
  el('download').hidden = true;

  try {
    const res = await fetch('/api/trim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.headers.get('content-type')?.includes('json')) {
      const { error } = await res.json();
      throw new Error(error || 'request failed');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      el('log').textContent = text;
      el('log').scrollTop = el('log').scrollHeight;
    }

    const done = /__DONE__ (.+)/.exec(text);
    const failed = /__ERROR__ (.+)/.exec(text);
    if (done) {
      const written = done[1].trim();
      setStatus(`wrote ${written}`, 'ok');
      offerDownload(written);
    } else if (failed) setStatus(failed[1].trim(), 'err');
    else setStatus('finished (no status line)', 'err');
  } catch (e) {
    setStatus(String(e.message || e), 'err');
  } finally {
    state.running = false;
    el('trim').disabled = false;
  }
}

/* ---------- drag and drop ---------- */

function showProgress(percent) {
  const bar = el('progress');
  if (percent == null) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  bar.value = percent;
}

async function resolvePath(query) {
  const res = await fetch(`/api/resolve?${new URLSearchParams(query)}`);
  return res.json();
}

function uploadFile(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload?name=${encodeURIComponent(file.name)}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        showProgress((e.loaded / e.total) * 100);
        setStatus(`copying ${file.name} — ${humanSize(e.loaded)} / ${humanSize(e.total)}`);
      }
    };
    xhr.onload = () => {
      showProgress(null);
      try {
        const body = JSON.parse(xhr.responseText);
        xhr.status === 200 ? resolve(body) : reject(new Error(body.error || `upload failed (${xhr.status})`));
      } catch {
        reject(new Error(`upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => {
      showProgress(null);
      reject(new Error('upload failed'));
    };
    xhr.send(file);
  });
}

// The browser never hands out a real path for a dropped File, so try the cheap
// routes first and only copy bytes when nothing on disk can be matched.
async function acceptDrop(dt) {
  const text = dt.getData('text/uri-list') || dt.getData('text/plain');
  if (text) {
    const hit = await resolvePath({ text: text.split(/\r?\n/)[0] });
    if (hit.found) return useFile(hit.path);
  }

  const file = dt.files?.[0];
  if (!file) return setStatus('nothing usable in that drop', 'err');

  const hint = state.cwd || '';
  const hit = await resolvePath({ name: file.name, size: file.size, hint });
  if (hit.found) return useFile(hit.path);

  setStatus(`${file.name} not found on disk — copying into a temp folder…`);
  const uploaded = await uploadFile(file);
  await useFile(uploaded.path);
  setStatus(`working from copy at ${uploaded.path}`, 'ok');
}

async function useFile(file) {
  await load(file);
  const dir = file.replace(/[\\/][^\\/]*$/, '');
  if (dir && dir !== state.cwd) await browse(dir);
  [...document.querySelectorAll('.row')].forEach((row) => {
    row.classList.toggle('active', !row.classList.contains('dir') && row.querySelector('.name').textContent === file.split(/[\\/]/).pop());
  });
}

let dragDepth = 0;

window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  el('dropzone').classList.add('show');
});

window.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) el('dropzone').classList.remove('show');
});

window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  el('dropzone').classList.remove('show');
  try {
    await acceptDrop(e.dataTransfer);
  } catch (err) {
    showProgress(null);
    setStatus(String(err.message || err), 'err');
  }
});

// "Copy as path" in Explorer, then Ctrl+V here: no copy, no upload.
window.addEventListener('paste', async (e) => {
  if (e.target.tagName === 'INPUT') return;
  const text = e.clipboardData?.getData('text/plain');
  if (!text) return;
  e.preventDefault();
  const hit = await resolvePath({ text: text.split(/\r?\n/)[0] });
  if (hit.found) await useFile(hit.path);
  else setStatus(`no file at ${text.trim()}`, 'err');
});

/* ---------- wiring ---------- */

el('go').onclick = () => browse(el('cwd').value);
el('cwd').onkeydown = (e) => e.key === 'Enter' && browse(el('cwd').value);
el('markStart').onclick = () => mark('start');
el('markEnd').onclick = () => mark('end');
el('seekStart').onclick = () => seekTo('start');
el('seekEnd').onclick = () => seekTo('end');
el('snap').onclick = snapStart;
el('trim').onclick = trim;
el('output').oninput = () => (el('output').dataset.touched = '1');
el('start').oninput = syncTimeline;
el('end').oninput = syncTimeline;

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const video = el('video');
  const step = e.shiftKey ? 0.1 : 1;
  if (e.key === ' ') { e.preventDefault(); video.paused ? video.play() : video.pause(); }
  else if (e.key === 'q') mark('start');
  else if (e.key === 'w') mark('end');
  else if (e.key === 'ArrowLeft') { e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - step); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); video.currentTime += step; }
});

el('video').addEventListener('timeupdate', () => {
  el('now').textContent = fmt(el('video').currentTime);
  syncTimeline();
});

el('video').addEventListener('loadedmetadata', () => {
  if (!state.duration && Number.isFinite(el('video').duration)) {
    state.duration = el('video').duration;
    if (!el('end').value) el('end').value = fmt(state.duration);
  }
  syncTimeline();
});

browse('');
