import { load } from "./app.js";

const ROW_NOTES = [
  { note: 72, label: "C5" },
  { note: 70, label: "Bb4" },
  { note: 67, label: "G4" },
  { note: 65, label: "F4" },
  { note: 63, label: "Eb4" },
  { note: 60, label: "C4" },
  { note: 55, label: "G3" },
  { note: 48, label: "C3" },
];

const PAD_KEYS = [
  { key: "a", note: 48, label: "C3 (A)" },
  { key: "s", note: 51, label: "Eb3 (S)" },
  { key: "d", note: 55, label: "G3 (D)" },
  { key: "f", note: 58, label: "Bb3 (F)" },
  { key: "g", note: 60, label: "C4 (G)" },
  { key: "h", note: 63, label: "Eb4 (H)" },
  { key: "j", note: 67, label: "G4 (J)" },
  { key: "k", note: 72, label: "C5 (K)" },
];

function mapStepToRowNote(note) {
  if (!note) return 0;
  let best = ROW_NOTES[0].note;
  let bestDist = 999;
  for (const r of ROW_NOTES) {
    const d = Math.abs(r.note - note);
    if (d < bestDist) { bestDist = d; best = r.note; }
  }
  return best;
}

const params = new URLSearchParams(location.search);
let customWasmUrl = null;
if (params.get("wasm") === "b64") {
  const b64 = await (await fetch("./program.wasm.b64")).text();
  const bin = atob(b64.trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  customWasmUrl = URL.createObjectURL(new Blob([bytes], { type: "application/wasm" }));
}

const loaded = await load(customWasmUrl ? { wasmUrl: customWasmUrl } : {});
let analyser = null;
const scopeData = new Uint8Array(512);

const sys = loaded.createSystem({
  createAudioContext: (cfg) => {
    const hook = window.__microdawAudioHook;
    return hook?.createAudioContext ? hook.createAudioContext(cfg) : new AudioContext({ sampleRate: cfg.sampleRate });
  },
  onNode: async (node, ctx) => {
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    node.connect(analyser);
    const hook = window.__microdawAudioHook;
    if (hook?.onNode) await hook.onNode(node, ctx);
  },
});

const session = loaded.exports.createSession(sys.alloc);
const coiBadge = document.getElementById("coi-badge");
coiBadge.textContent = self.crossOriginIsolated ? "COI: SAB zero-copy" : "COI: MessagePort fallback";
const statusPill = document.getElementById("status-pill");
statusPill.textContent = "Ready";
statusPill.classList.add("pill-live");

const btnPlay = document.getElementById("btn-play");
const btnReset = document.getElementById("btn-reset");
const selPreset = document.getElementById("sel-preset");
const gridEl = document.getElementById("step-grid");
const padRowEl = document.getElementById("pad-row");
const telReadout = document.getElementById("tel-readout");
const peakFill = document.getElementById("peak-fill");
const scopeCanvas = document.getElementById("scope");
const scopeCtx = scopeCanvas.getContext("2d");

let lastTel = { step: 0, playing: false, activeVoices: 0, peak: 0 };
const cellButtons = new Map();

function buildGrid() {
  gridEl.innerHTML = "";
  cellButtons.clear();
  for (const row of ROW_NOTES) {
    const lbl = document.createElement("span");
    lbl.className = "row-label";
    lbl.textContent = row.label;
    gridEl.appendChild(lbl);
    for (let col = 0; col < 16; col++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "step-cell" + (col % 4 === 0 ? " beat-col" : "");
      btn.dataset.step = String(col);
      btn.dataset.note = String(row.note);
      btn.addEventListener("click", () => {
        const snap = session.snapshot();
        const curMapped = mapStepToRowNote(snap.steps[col].note);
        if (curMapped === row.note) session.setStep(col, 0, 0);
        else session.setStep(col, row.note, 0.85);
        syncUiFromSnapshot();
      });
      gridEl.appendChild(btn);
      cellButtons.set(`${col}:${row.note}`, btn);
    }
  }
}

function buildPads() {
  padRowEl.innerHTML = "";
  for (const pad of PAD_KEYS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pad-btn";
    btn.textContent = pad.label;
    btn.dataset.note = String(pad.note);
    btn.addEventListener("click", async () => {
      await ensureAudioStarted();
      session.triggerNote(pad.note, 0.9);
      btn.classList.add("lit");
      setTimeout(() => btn.classList.remove("lit"), 120);
    });
    padRowEl.appendChild(btn);
  }
}

async function ensureAudioStarted() {
  if (session.isAudioOpen()) return true;
  const res = await session.startAudio(sys.audio);
  if (res.kind === "err") {
    statusPill.textContent = "Audio err: " + res.error.message;
    return false;
  }
  return true;
}

function syncUiFromSnapshot() {
  const snap = session.snapshot();
  btnPlay.textContent = snap.playing ? "Stop" : "Play";
  btnPlay.classList.toggle("playing", snap.playing);
  selPreset.value = snap.preset;
  document.querySelectorAll(".wave-btn").forEach((b) => {
    b.classList.toggle("active", Number(b.dataset.wave) === snap.wave);
  });
  document.getElementById("rng-bpm").value = String(snap.bpm);
  document.getElementById("val-bpm").textContent = String(snap.bpm);
  document.getElementById("rng-cutoff").value = String(Math.round(snap.cutoff));
  document.getElementById("val-cutoff").textContent = `${Math.round(snap.cutoff)} Hz`;
  document.getElementById("rng-attack").value = String(Math.round(snap.attack * 1000));
  document.getElementById("val-attack").textContent = `${Math.round(snap.attack * 1000)} ms`;
  document.getElementById("rng-release").value = String(Math.round(snap.release * 1000));
  document.getElementById("val-release").textContent = `${Math.round(snap.release * 1000)} ms`;
  const gp = Math.round(snap.gain * 100);
  document.getElementById("rng-gain").value = String(gp);
  document.getElementById("val-gain").textContent = `${gp}%`;

  for (let col = 0; col < 16; col++) {
    const activeNote = mapStepToRowNote(snap.steps[col].note);
    for (const row of ROW_NOTES) {
      const el = cellButtons.get(`${col}:${row.note}`);
      if (el) el.classList.toggle("active", activeNote === row.note);
    }
  }
}

btnPlay.addEventListener("click", async () => {
  const snap = session.snapshot();
  if (!snap.playing) {
    if (!(await ensureAudioStarted())) return;
    session.setPlaying(true);
    statusPill.textContent = "Playing";
  } else {
    session.setPlaying(false);
    statusPill.textContent = "Paused";
  }
  syncUiFromSnapshot();
});

btnReset.addEventListener("click", () => {
  session.resetSequencer();
  lastTel = { ...lastTel, step: 0 };
  updatePlayhead();
});

selPreset.addEventListener("change", () => {
  session.loadPreset(selPreset.value);
  syncUiFromSnapshot();
});

document.querySelectorAll(".wave-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    session.setWave(Number(btn.dataset.wave));
    syncUiFromSnapshot();
  });
});

document.getElementById("rng-bpm").addEventListener("input", (e) => {
  session.setBpm(Number(e.target.value));
  syncUiFromSnapshot();
});
document.getElementById("rng-cutoff").addEventListener("input", (e) => {
  session.setCutoff(Number(e.target.value));
  syncUiFromSnapshot();
});
document.getElementById("rng-attack").addEventListener("input", (e) => {
  session.setAttack(Number(e.target.value) / 1000);
  syncUiFromSnapshot();
});
document.getElementById("rng-release").addEventListener("input", (e) => {
  session.setRelease(Number(e.target.value) / 1000);
  syncUiFromSnapshot();
});
document.getElementById("rng-gain").addEventListener("input", (e) => {
  session.setGain(Number(e.target.value) / 100);
  syncUiFromSnapshot();
});

window.addEventListener("keydown", async (e) => {
  if (e.repeat || e.target?.tagName === "INPUT" || e.target?.tagName === "SELECT") return;
  const pad = PAD_KEYS.find((p) => p.key === e.key.toLowerCase());
  if (!pad) return;
  await ensureAudioStarted();
  session.triggerNote(pad.note, 0.9);
});

function updatePlayhead() {
  for (const el of cellButtons.values()) {
    el.classList.toggle("is-playhead", Number(el.dataset.step) === lastTel.step);
  }
  telReadout.textContent = `step: ${lastTel.step + 1} · voices: ${lastTel.activeVoices}`;
  peakFill.style.width = `${Math.min(100, Math.round(lastTel.peak * 100))}%`;
}

function tickFrame() {
  const tel = session.pollTelemetry();
  if (tel !== null) {
    lastTel = tel;
    updatePlayhead();
  }
  if (scopeCtx) {
    const w = scopeCanvas.width;
    const h = scopeCanvas.height;
    scopeCtx.fillStyle = "#090d14";
    scopeCtx.fillRect(0, 0, w, h);
    scopeCtx.strokeStyle = "#38bdf8";
    scopeCtx.lineWidth = 2;
    scopeCtx.beginPath();
    if (analyser) {
      analyser.getByteTimeDomainData(scopeData);
      for (let i = 0; i < scopeData.length; i++) {
        const x = (i / (scopeData.length - 1)) * w;
        const y = ((scopeData[i] - 128) / 128) * (h * 0.42) + h * 0.5;
        if (i === 0) scopeCtx.moveTo(x, y);
        else scopeCtx.lineTo(x, y);
      }
    } else {
      scopeCtx.moveTo(0, h * 0.5);
      scopeCtx.lineTo(w, h * 0.5);
    }
    scopeCtx.stroke();
  }
  requestAnimationFrame(tickFrame);
}

buildGrid();
buildPads();
syncUiFromSnapshot();
requestAnimationFrame(tickFrame);

window.__microdaw = {
  loaded,
  sys,
  session,
  getTelemetry: () => lastTel,
  isReady: () => true,
  renderOfflinePreview: (preset = "acid", frames = 2048) => loaded.exports.renderOfflinePreview(sys.alloc, preset, frames),
  stopAudio: () => session.stopAudio(),
};

if (params.get("desktop") === "1") {
  let payload;
  try {
    const pv = await loaded.exports.renderOfflinePreview(sys.alloc, "acid", 2048);
    payload = {
      ok: true,
      wasmFinite: pv.finite,
      wasmPeak: pv.peak,
      lastStep: pv.lastStep,
      frames: pv.frames,
    };
  } catch (err) {
    payload = { ok: false, error: String(err) };
  }
  await fetch("/api/ready", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}
