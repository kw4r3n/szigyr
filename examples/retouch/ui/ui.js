const WIDTH = 96;
const HEIGHT = 96;

const FREQ_PARAMS = {
  blurRadius: 3,
  detailGain: 0.45,
  smoothAmount: 0.85,
  warmth: 0.12,
};

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const statsEl = document.getElementById("stats");
const toolSelect = document.getElementById("tool-select");
const btnFreqMain = document.getElementById("btn-freq-main");
const btnFreqWorker = document.getElementById("btn-freq-worker");
const btnUndo = document.getElementById("btn-undo");
const btnRedo = document.getElementById("btn-redo");
const btnReset = document.getElementById("btn-reset");

const appUrl = window.__RETOUCH_APP_URL ?? "./dist/app.js";

let sys;
let exportsApi;
let VecApi;
let session;
let painting = false;

function renderCanvasAndStats(status) {
  const rgbaVec = session.snapshotRgba(sys.alloc);
  const img = ctx.createImageData(WIDTH, HEIGHT);
  img.data.set(rgbaVec.asTypedArray());
  ctx.putImageData(img, 0, 0);

  const st = session.stats();
  const fnv = String(st.fnv64);
  const undoDepth = String(session.undoDepth());
  const redoDepth = String(session.redoDepth());
  statsEl.dataset.fnv64 = fnv;
  statsEl.dataset.undoDepth = undoDepth;
  statsEl.dataset.redoDepth = redoDepth;
  statsEl.dataset.status = status;
  statsEl.textContent = [
    `status:    ${status}`,
    `pixels:    ${st.pixels} (${WIDTH}x${HEIGHT})`,
    `minLuma:   ${st.minLuma}`,
    `maxLuma:   ${st.maxLuma}`,
    `lumaSum:   ${String(st.lumaSum)}`,
    `fnv64:     ${fnv}`,
    `undoDepth: ${undoDepth}`,
    `redoDepth: ${redoDepth}`,
  ].join("\n");
}

function strokeAtClientPoint(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const cx = Math.fround(((clientX - rect.left) / rect.width) * WIDTH);
  const cy = Math.fround(((clientY - rect.top) / rect.height) * HEIGHT);
  const stroke = {
    cx,
    cy,
    radius: Math.fround(8),
    strength: Math.fround(0.85),
    hardness: Math.fround(0.4),
  };
  const tool = toolSelect.value === "dodge"
    ? { kind: "dodge", stroke, exposure: Math.fround(0.35) }
    : { kind: "smooth", stroke };
  session.applyTool(sys.alloc, tool);
  renderCanvasAndStats(`stroke:${tool.kind}`);
}

async function init() {
  try {
    const { load } = await import(appUrl);
    const loaded = await load();
    exportsApi = loaded.exports;
    VecApi = loaded.Vec;
    sys = loaded.createSystem();
    session = exportsApi.createDemoSession(sys.alloc, WIDTH, HEIGHT);
    window.__retouch = { exports: exportsApi, Vec: VecApi, sys };
    renderCanvasAndStats("ready");
  } catch (err) {
    statsEl.dataset.status = "error";
    statsEl.textContent = `error: ${err instanceof Error ? err.message : String(err)}`;
    throw err;
  }
}

canvas.addEventListener("pointerdown", (ev) => {
  if (!session) return;
  painting = true;
  strokeAtClientPoint(ev.clientX, ev.clientY);
});

canvas.addEventListener("pointermove", (ev) => {
  if (!painting || !session) return;
  strokeAtClientPoint(ev.clientX, ev.clientY);
});

window.addEventListener("pointerup", () => {
  painting = false;
});

btnFreqMain.addEventListener("click", () => {
  if (!session) return;
  session.applyTool(sys.alloc, { kind: "frequency", params: FREQ_PARAMS });
  renderCanvasAndStats("freq:main");
});

btnFreqWorker.addEventListener("click", async () => {
  if (!session) return;
  statsEl.dataset.status = "working";
  const res = await session.runFrequencyInWorker(sys.spawn, sys.alloc, FREQ_PARAMS);
  if (res.kind === "err") {
    renderCanvasAndStats(`error:${res.error.message}`);
    return;
  }
  renderCanvasAndStats("freq:worker");
});

btnUndo.addEventListener("click", () => {
  if (!session) return;
  session.undo();
  renderCanvasAndStats("undo");
});

btnRedo.addEventListener("click", () => {
  if (!session) return;
  session.redo();
  renderCanvasAndStats("redo");
});

btnReset.addEventListener("click", () => {
  if (!session) return;
  session.dispose();
  session = exportsApi.createDemoSession(sys.alloc, WIDTH, HEIGHT);
  renderCanvasAndStats("reset");
});

init();
