import { Engine } from './engine.js';
import { FILTERS, filterById, applyFilterCPU } from './presets.js';
import {
  drawObject, hitTest, handlePoints, toLocal, objectSize, drawSelection,
} from './overlay.js';

const $ = (s) => document.querySelector(s);

const el = {
  welcome: $('#welcome'),
  editor: $('#editor'),
  stage: $('#stage'),
  gl: $('#glCanvas'),
  overlay: $('#overlayCanvas'),
  tabs: $('#tabs'),
  panel: $('#panel'),
  loading: $('#loading'),
  back: $('#backBtn'),
  undo: $('#undoBtn'),
  redo: $('#redoBtn'),
  compare: $('#compareBtn'),
  exportBtn: $('#exportBtn'),
  pick: $('#pickBtn'),
  camera: $('#cameraBtn'),
  fileInput: $('#fileInput'),
  cameraInput: $('#cameraInput'),
  textSheet: $('#textSheet'),
  textInput: $('#textInput'),
  textCancel: $('#textCancel'),
  textConfirm: $('#textConfirm'),
  result: $('#result'),
  resultImg: $('#resultImg'),
  resultClose: $('#resultClose'),
  resultDownload: $('#resultDownload'),
  toast: $('#toast'),
};

/* ============================ 状态 ============================ */

const zeros = () => ({
  brightness: 0, contrast: 0, saturation: 0, temp: 0, tint: 0,
  highlights: 0, shadows: 0, sharpen: 0, vignette: 0, grain: 0,
});

const state = {
  adjust: zeros(),
  beauty: { soften: 0, whiten: 0 },
  filterId: 'none',
  filterAmt: 1,
  crop: { x: 0, y: 0, w: 1, h: 1 },
  rot: 0,
  flipH: false,
  flipV: false,
  objects: [],
};

const app = {
  engine: null,
  image: null,
  imgW: 0,
  imgH: 0,
  tab: 'adjust',
  mode: 'edit',
  selectedId: null,
  comparing: false,
  brush: { size: 34, strength: 60 },
  doodle: { color: '#ffd24a', width: 6 },
  cropRect: null,
  cropAspect: 0,
  view: { zoom: 1, panX: 0, panY: 0 },
  cur: { s: 1, tx: 0, ty: 0, cw: 1, ch: 1, ow: 1, oh: 1, dpr: 1 },
  undoStack: [],
  redoStack: [],
  dirty: false,
  exportW: 2048,
  exportQuality: 92,
  exportFormat: 'image/jpeg',
};

let idSeq = 1;
const uid = () => `o${idSeq++}`;

/* ============================ 工具 ============================ */

let toastTimer = 0;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 1700);
}

function loading(on) {
  el.loading.classList.toggle('hidden', !on);
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ============================ 尺寸与视图 ============================ */

function outSize() {
  const r = ((state.rot % 360) + 360) % 360;
  const c = state.crop;
  return r % 180 === 0 ? { w: c.w, h: c.h } : { w: c.h, h: c.w };
}

function uvMatrix() {
  const r = ((state.rot % 360) + 360) % 360;
  let m;
  if (r === 0) m = [1, 0, 0, 1];
  else if (r === 90) m = [0, -1, 1, 0];
  else if (r === 180) m = [-1, 0, 0, -1];
  else m = [0, 1, -1, 0];
  const sx = state.flipH ? -1 : 1;
  const sy = state.flipV ? -1 : 1;
  return new Float32Array([m[0] * sx, m[1] * sx, m[2] * sy, m[3] * sy]);
}

function invUvMatrix() {
  const m = uvMatrix();
  const det = m[0] * m[3] - m[2] * m[1] || 1;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det];
}

function applyM2(m, x, y) {
  return { x: m[0] * x + m[2] * y, y: m[1] * x + m[3] * y };
}

function fitScale() {
  const { w, h } = outSize();
  const cw = el.stage.clientWidth || 1;
  const ch = el.stage.clientHeight || 1;
  return Math.min((cw - 20) / w, (ch - 20) / h);
}

function computeView() {
  const cw = el.stage.clientWidth || 1;
  const ch = el.stage.clientHeight || 1;
  const { w: ow, h: oh } = outSize();
  const s = fitScale() * app.view.zoom;
  const tx = (cw - ow * s) / 2 + app.view.panX;
  const ty = (ch - oh * s) / 2 + app.view.panY;
  app.cur = { s, tx, ty, cw, ch, ow, oh, dpr: Math.min(window.devicePixelRatio || 1, 2.5) };
  return app.cur;
}

function toOut(clientX, clientY) {
  const r = el.stage.getBoundingClientRect();
  const { s, tx, ty } = app.cur;
  return { x: (clientX - r.left - tx) / s, y: (clientY - r.top - ty) / s };
}

/* ============================ 渲染 ============================ */

let rafId = 0;
function requestRender() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    render();
  });
}

function render() {
  if (!app.engine || !app.image) return;
  const c = computeView();
  const dpr = c.dpr;

  app.engine.resize(Math.round(c.cw * dpr), Math.round(c.ch * dpr));

  const ow = Math.round(c.cw * dpr);
  const oh = Math.round(c.ch * dpr);
  if (el.overlay.width !== ow || el.overlay.height !== oh) {
    el.overlay.width = ow;
    el.overlay.height = oh;
  }

  const x0 = (c.tx / c.cw) * 2 - 1;
  const y0 = 1 - (c.ty / c.ch) * 2;
  const x1 = ((c.tx + c.ow * c.s) / c.cw) * 2 - 1;
  const y1 = 1 - ((c.ty + c.oh * c.s) / c.ch) * 2;

  const flt = app.comparing ? FILTERS[0] : filterById(state.filterId);
  const amt = app.comparing ? 0 : state.filterAmt;

  app.engine.render({
    clipOrigin: [x0, y0],
    clipSize: [x1 - x0, y1 - y0],
    uvXf: uvMatrix(),
    cropScale: [state.crop.w / app.imgW, state.crop.h / app.imgH],
    cropOffset: [state.crop.x / app.imgW, state.crop.y / app.imgH],
    adjust: app.comparing ? zeros() : state.adjust,
    beauty: app.comparing ? { soften: 0, whiten: 0 } : state.beauty,
    filter: flt,
    filterAmt: app.comparing ? 0 : amt,
  });

  drawOverlay(c);
}

function drawOverlay(c) {
  const ctx = el.overlay.getContext('2d');
  ctx.setTransform(c.dpr, 0, 0, c.dpr, 0, 0);
  ctx.clearRect(0, 0, c.cw, c.ch);

  if (!app.comparing) {
    ctx.save();
    ctx.translate(c.tx, c.ty);
    ctx.scale(c.s, c.s);
    for (const o of state.objects) drawObject(ctx, o);
    const sel = state.objects.find((o) => o.id === app.selectedId);
    if (sel && app.mode === 'edit' && app.tab !== 'crop') drawSelection(ctx, sel, c.s);
    ctx.restore();
  }

  if (app.mode === 'crop' && app.cropRect) drawCropUI(ctx, c);
  if (app.mode === 'liquify') drawBrushCursor(ctx, c);
}

/* ============================ 裁剪界面 ============================ */

function resetCropRect() {
  const { w, h } = outSize();
  app.cropRect = { x: 0, y: 0, w, h };
}

function drawCropUI(ctx, c) {
  const r = app.cropRect;
  const sx = c.tx + r.x * c.s;
  const sy = c.ty + r.y * c.s;
  const sw = r.w * c.s;
  const sh = r.h * c.s;

  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,.62)';
  ctx.beginPath();
  ctx.rect(0, 0, c.cw, c.ch);
  ctx.rect(sx, sy, sw, sh);
  ctx.fill('evenodd');

  ctx.strokeStyle = 'rgba(255,255,255,.9)';
  ctx.lineWidth = 1;
  ctx.strokeRect(sx + 0.5, sy + 0.5, sw - 1, sh - 1);

  ctx.strokeStyle = 'rgba(255,255,255,.28)';
  ctx.beginPath();
  for (let i = 1; i < 3; i++) {
    ctx.moveTo(sx + (sw * i) / 3, sy);
    ctx.lineTo(sx + (sw * i) / 3, sy + sh);
    ctx.moveTo(sx, sy + (sh * i) / 3);
    ctx.lineTo(sx + sw, sy + (sh * i) / 3);
  }
  ctx.stroke();

  const L = 20;
  ctx.strokeStyle = '#ffd24a';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  const corners = [
    [sx, sy, 1, 1], [sx + sw, sy, -1, 1], [sx, sy + sh, 1, -1], [sx + sw, sy + sh, -1, -1],
  ];
  ctx.beginPath();
  for (const [x, y, dx, dy] of corners) {
    ctx.moveTo(x + dx * L, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + dy * L);
  }
  ctx.stroke();
  ctx.restore();
}

function cropHandleAt(px, py) {
  const r = app.cropRect;
  const c = app.cur;
  const x = c.tx + r.x * c.s;
  const y = c.ty + r.y * c.s;
  const w = r.w * c.s;
  const h = r.h * c.s;
  const t = 26;
  const pts = [
    ['nw', x, y], ['ne', x + w, y], ['sw', x, y + h], ['se', x + w, y + h],
    ['n', x + w / 2, y], ['s', x + w / 2, y + h], ['w', x, y + h / 2], ['e', x + w, y + h / 2],
  ];
  for (const [k, hx, hy] of pts) {
    if (Math.abs(px - hx) < t && Math.abs(py - hy) < t) return k;
  }
  if (px > x && px < x + w && py > y && py < y + h) return 'move';
  return null;
}

function updateCropDrag(kind, ox, oy, start) {
  const { w: OW, h: OH } = outSize();
  const min = 40;
  let { x, y, w, h } = start.rect;

  if (kind === 'move') {
    const dx = ox - start.ox;
    const dy = oy - start.oy;
    x = clamp(x + dx, 0, OW - w);
    y = clamp(y + dy, 0, OH - h);
  } else {
    let x0 = x, y0 = y, x1 = x + w, y1 = y + h;
    if (kind.includes('w')) x0 = clamp(ox, 0, x1 - min);
    if (kind.includes('e')) x1 = clamp(ox, x0 + min, OW);
    if (kind.includes('n')) y0 = clamp(oy, 0, y1 - min);
    if (kind.includes('s')) y1 = clamp(oy, y0 + min, OH);

    if (app.cropAspect > 0) {
      const asp = app.cropAspect;
      let nw = x1 - x0;
      let nh = y1 - y0;
      if (kind === 'n' || kind === 's') nw = nh * asp;
      else nh = nw / asp;
      if (kind.includes('w')) x0 = x1 - nw;
      else x1 = x0 + nw;
      if (kind.includes('n')) y0 = y1 - nh;
      else y1 = y0 + nh;
      if (x0 < 0) { x0 = 0; x1 = Math.min(OW, nw); }
      if (y0 < 0) { y0 = 0; y1 = Math.min(OH, nh); }
      if (x1 > OW) { x1 = OW; x0 = OW - nw; }
      if (y1 > OH) { y1 = OH; y0 = OH - nh; }
    }
    x = x0; y = y0; w = x1 - x0; h = y1 - y0;
  }
  app.cropRect = { x, y, w, h };
}

function confirmCrop() {
  const r = app.cropRect;
  if (!r) return;
  const inv = invUvMatrix();
  const { w: OW, h: OH } = outSize();
  const pts = [
    [r.x / OW, r.y / OH], [(r.x + r.w) / OW, r.y / OH],
    [(r.x + r.w) / OW, (r.y + r.h) / OH], [r.x / OW, (r.y + r.h) / OH],
  ].map(([u, v]) => {
    const t = applyM2(inv, u - 0.5, v - 0.5);
    return { x: (t.x + 0.5) * state.crop.w + state.crop.x, y: (t.y + 0.5) * state.crop.h + state.crop.y };
  });

  const minX = Math.min(...pts.map((p) => p.x));
  const maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y));
  const maxY = Math.max(...pts.map((p) => p.y));

  const nx = clamp(minX, 0, app.imgW - 8);
  const ny = clamp(minY, 0, app.imgH - 8);
  const nw = clamp(maxX - nx, 8, app.imgW - nx);
  const nh = clamp(maxY - ny, 8, app.imgH - ny);

  remapObjects(state.crop, state.rot, state.flipH, state.flipV, { x: nx, y: ny, w: nw, h: nh }, state.rot, state.flipH, state.flipV);

  state.crop = { x: nx, y: ny, w: nw, h: nh };
  app.cropRect = null;
  app.view = { zoom: 1, panX: 0, panY: 0 };
  requestRender();
}

function remapObjects(oldCrop, oldRot, oldFH, oldFV, newCrop, newRot, newFH, newFV) {
  if (!state.objects.length) return;
  const toSrc = (ox, oy, OW, OH) => {
    let m;
    const r = ((oldRot % 360) + 360) % 360;
    if (r === 0) m = [1, 0, 0, 1];
    else if (r === 90) m = [0, -1, 1, 0];
    else if (r === 180) m = [-1, 0, 0, -1];
    else m = [0, 1, -1, 0];
    const sx = oldFH ? -1 : 1, sy = oldFV ? -1 : 1;
    const mm = [m[0] * sx, m[1] * sx, m[2] * sy, m[3] * sy];
    const det = mm[0] * mm[3] - mm[2] * mm[1] || 1;
    const inv = [mm[3] / det, -mm[1] / det, -mm[2] / det, mm[0] / det];
    const t = applyM2(inv, ox / OW - 0.5, oy / OH - 0.5);
    return { x: (t.x + 0.5) * oldCrop.w + oldCrop.x, y: (t.y + 0.5) * oldCrop.h + oldCrop.y };
  };
  const fromSrc = (sx, sy) => {
    let m;
    const r = ((newRot % 360) + 360) % 360;
    if (r === 0) m = [1, 0, 0, 1];
    else if (r === 90) m = [0, -1, 1, 0];
    else if (r === 180) m = [-1, 0, 0, -1];
    else m = [0, 1, -1, 0];
    const fx = newFH ? -1 : 1, fy = newFV ? -1 : 1;
    const mm = [m[0] * fx, m[1] * fx, m[2] * fy, m[3] * fy];
    const a = (sx - newCrop.x) / newCrop.w - 0.5;
    const b = (sy - newCrop.y) / newCrop.h - 0.5;
    const t = applyM2(mm, a, b);
    const nw = r % 180 === 0 ? newCrop.w : newCrop.h;
    const nh = r % 180 === 0 ? newCrop.h : newCrop.w;
    return { x: (t.x + 0.5) * nw, y: (t.y + 0.5) * nh };
  };

  const oldOW = oldRot % 180 === 0 ? oldCrop.w : oldCrop.h;
  const oldOH = oldRot % 180 === 0 ? oldCrop.h : oldCrop.w;

  for (const o of state.objects) {
    const src = toSrc(o.x, o.y, oldOW, oldOH);
    const p = fromSrc(src.x, src.y);
    o.x = p.x;
    o.y = p.y;
    o.rot = (o.rot || 0) + ((newRot - oldRot) * Math.PI) / 180;
  }
}

function rotateBy(deg) {
  const before = { crop: { ...state.crop }, rot: state.rot, fh: state.flipH, fv: state.flipV };
  state.rot = ((state.rot + deg) % 360 + 360) % 360;
  const { w: OW, h: OH } = outSize();
  remapObjects(before.crop, before.rot, before.fh, before.fv, state.crop, state.rot, state.flipH, state.flipV);
  app.view = { zoom: 1, panX: 0, panY: 0 };
  resetCropRect();
  requestRender();
}

function flip(axis) {
  if (axis === 'h') state.flipH = !state.flipH;
  else state.flipV = !state.flipV;
  // 镜像后对象的水平位置需要翻转
  const { w: OW } = outSize();
  for (const o of state.objects) {
    if (axis === 'h') {
      o.x = OW - o.x;
      o.rot = -(o.rot || 0);
    } else {
      o.y = outSize().h - o.y;
      o.rot = -(o.rot || 0);
    }
  }
  resetCropRect();
  requestRender();
}

/* ============================ 手势 / 指针 ============================ */

const pointers = new Map();
let gesture = null;
let pinch = null;

el.stage.addEventListener('pointerdown', (e) => {
  if (!app.image) return;
  el.stage.setPointerCapture?.(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size === 2) {
    gesture = null;
    const [a, b] = [...pointers.values()];
    pinch = {
      d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      zoom0: app.view.zoom,
      p0: toOut((a.x + b.x) / 2, (a.y + b.y) / 2),
      m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
    return;
  }
  if (pointers.size > 2) return;

  const p = toOut(e.clientX, e.clientY);

  if (app.mode === 'crop') {
    const k = cropHandleAt(e.clientX - el.stage.getBoundingClientRect().left, e.clientY - el.stage.getBoundingClientRect().top);
    if (k) {
      pushUndo();
      gesture = { type: 'crop', kind: k, start: { rect: { ...app.cropRect }, ox: p.x, oy: p.y } };
    }
    return;
  }

  if (app.mode === 'liquify') {
    gesture = { type: 'liquify', last: p, moved: false };
    return;
  }

  if (app.mode === 'doodle') {
    pushUndo();
    const obj = {
      id: uid(), kind: 'doodle', x: p.x, y: p.y, rot: 0,
      color: app.doodle.color, width: app.doodle.width, pts: [[0, 0]],
    };
    state.objects.push(obj);
    app.selectedId = null;
    gesture = { type: 'doodle', obj, last: p };
    requestRender();
    return;
  }

  // 选中对象的手柄优先
  const sel = state.objects.find((o) => o.id === app.selectedId);
  if (sel && app.tab !== 'crop') {
    const h = handlePoints(sel, app.cur.s);
    const R = 22;
    const near = (pt) => Math.hypot(pt.x - p.x, pt.y - p.y) * app.cur.s < R;
    if (near(h.rotate)) {
      pushUndo();
      gesture = { type: 'rotate', obj: sel, startAngle: Math.atan2(p.y - sel.y, p.x - sel.x), rot0: sel.rot || 0 };
      return;
    }
    for (const cp of h.corners) {
      if (near(cp)) {
        pushUndo();
        const l = toLocal(sel, p.x, p.y);
        gesture = { type: 'scale', obj: sel, size0: sel.size, d0: Math.max(6, Math.hypot(l.x, l.y)) };
        return;
      }
    }
  }

  const hit = hitTest(state.objects, p.x, p.y, app.cur.s);
  if (hit && app.mode === 'edit') {
    app.selectedId = hit.id;
    pushUndo();
    gesture = { type: 'move', obj: hit, dx: p.x - hit.x, dy: p.y - hit.y, tap: true, sx: e.clientX, sy: e.clientY };
    requestRender();
    refreshPanel();
    return;
  }

  if (app.selectedId) {
    app.selectedId = null;
    requestRender();
    refreshPanel();
  }

  gesture = { type: 'pan', sx: e.clientX, sy: e.clientY, panX: app.view.panX, panY: app.view.panY };
});

window.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) {
    updateBrushCursor(e);
    return;
  }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const z = clamp(pinch.zoom0 * (d / pinch.d0), 1, 6);
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const rect = el.stage.getBoundingClientRect();
    app.view.zoom = z;
    requestRender();
    const c = app.cur;
    const s = fitScale() * z;
    app.view.panX = (m.x - rect.left) - pinch.p0.x * s - (c.cw - c.ow * s) / 2;
    app.view.panY = (m.y - rect.top) - pinch.p0.y * s - (c.ch - c.oh * s) / 2;
    requestRender();
    return;
  }

  if (!gesture) return;
  const p = toOut(e.clientX, e.clientY);

  if (gesture.type === 'pan') {
    app.view.panX = gesture.panX + (e.clientX - gesture.sx);
    app.view.panY = gesture.panY + (e.clientY - gesture.sy);
    requestRender();
  } else if (gesture.type === 'move') {
    const o = gesture.obj;
    o.x = p.x - gesture.dx;
    o.y = p.y - gesture.dy;
    if (Math.hypot(e.clientX - gesture.sx, e.clientY - gesture.sy) > 4) gesture.tap = false;
    requestRender();
  } else if (gesture.type === 'rotate') {
    const o = gesture.obj;
    const a = Math.atan2(p.y - o.y, p.x - o.x);
    o.rot = gesture.rot0 + (a - gesture.startAngle);
    requestRender();
  } else if (gesture.type === 'scale') {
    const o = gesture.obj;
    const l = toLocal(o, p.x, p.y);
    const d = Math.max(2, Math.hypot(l.x, l.y));
    o.size = clamp((gesture.size0 * d) / gesture.d0, 6, 600);
    requestRender();
  } else if (gesture.type === 'doodle') {
    const o = gesture.obj;
    const last = gesture.last;
    const step = Math.hypot(p.x - last.x, p.y - last.y);
    if (step > 1.5 / app.cur.s) {
      o.pts.push([p.x - o.x, p.y - o.y]);
      gesture.last = p;
      requestRender();
    }
  } else if (gesture.type === 'crop') {
    updateCropDrag(gesture.kind, p.x, p.y, gesture.start);
    requestRender();
  } else if (gesture.type === 'liquify') {
    liquifyMove(p, gesture);
  }
});

function liquifyMove(p, g) {
  const dxOut = p.x - g.last.x;
  const dyOut = p.y - g.last.y;
  const { w: OW, h: OH } = outSize();
  const m = uvMatrix();
  const dOutNorm = { x: dxOut / OW, y: dyOut / OH };
  const dCropNorm = applyM2(m, dOutNorm.x, dOutNorm.y);
  const cs = { x: state.crop.w / app.imgW, y: state.crop.h / app.imgH };
  const du = dCropNorm.x * cs.x * (app.brush.strength / 100) * 1.6;
  const dv = dCropNorm.y * cs.y * (app.brush.strength / 100) * 1.6;

  const mid = { x: (p.x + g.last.x) / 2, y: (p.y + g.last.y) / 2 };
  const uv = outToTextureUV(mid.x, mid.y);
  const rOut = app.brush.size / 2 / app.cur.s;
  const rTex = rOut * 0.5 * (cs.x / OW + cs.y / OH);

  app.engine.stamp(uv.x, uv.y, du, dv, Math.max(0.004, rTex));
  g.last = p;
  g.moved = true;
  requestRender();
}

function outToTextureUV(ox, oy) {
  const { w: OW, h: OH } = outSize();
  const m = uvMatrix();
  const t = applyM2(m, ox / OW - 0.5, oy / OH - 0.5);
  return {
    x: t.x * (state.crop.w / app.imgW) + state.crop.x / app.imgW + 0.5 * (state.crop.w / app.imgW),
    y: t.y * (state.crop.h / app.imgH) + state.crop.y / app.imgH + 0.5 * (state.crop.h / app.imgH),
  };
}

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pinch && pointers.size < 2) pinch = null;
  if (gesture) {
    if (gesture.type === 'move' && gesture.tap) {
      // 单纯点选，不记录撤销
      app.undoStack.pop();
      updateHistoryButtons();
    }
    if (gesture.type === 'doodle' && gesture.obj.pts.length < 2) {
      gesture.obj.pts.push([gesture.obj.pts[0][0] + 0.6, gesture.obj.pts[0][1] + 0.6]);
    }
    gesture = null;
  }
}
window.addEventListener('pointerup', endPointer);
window.addEventListener('pointercancel', endPointer);

function updateBrushCursor(e) {
  if (app.mode !== 'liquify') return;
  const p = toOut(e.clientX, e.clientY);
  app.brushPos = p;
  requestRender();
}

function drawBrushCursor(ctx, c) {
  if (!app.brushPos) return;
  const r = app.brush.size / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(c.tx + app.brushPos.x * c.s, c.ty + app.brushPos.y * c.s, r, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,.85)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(c.tx + app.brushPos.x * c.s, c.ty + app.brushPos.y * c.s, 1.5, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,.9)';
  ctx.fill();
  ctx.restore();
}

/* ============================ 历史 ============================ */

function snapshot() {
  return JSON.stringify({
    adjust: state.adjust,
    beauty: state.beauty,
    filterId: state.filterId,
    filterAmt: state.filterAmt,
    crop: state.crop,
    rot: state.rot,
    flipH: state.flipH,
    flipV: state.flipV,
    objects: state.objects,
  });
}

function pushUndo() {
  app.undoStack.push(snapshot());
  if (app.undoStack.length > 40) app.undoStack.shift();
  app.redoStack.length = 0;
  updateHistoryButtons();
}

function restore(json) {
  const s = JSON.parse(json);
  state.adjust = s.adjust;
  state.beauty = s.beauty;
  state.filterId = s.filterId;
  state.filterAmt = s.filterAmt;
  state.crop = s.crop;
  state.rot = s.rot;
  state.flipH = s.flipH;
  state.flipV = s.flipV;
  state.objects = s.objects;
  app.selectedId = null;
  requestRender();
  refreshPanel();
}

function undo() {
  if (!app.undoStack.length) return;
  app.redoStack.push(snapshot());
  restore(app.undoStack.pop());
  updateHistoryButtons();
}

function redo() {
  if (!app.redoStack.length) return;
  app.undoStack.push(snapshot());
  restore(app.redoStack.pop());
  updateHistoryButtons();
}

function updateHistoryButtons() {
  el.undo.disabled = app.undoStack.length === 0;
  el.redo.disabled = app.redoStack.length === 0;
}

/* ============================ 面板 ============================ */

const ICONS = {
  adjust: '<path d="M4 7h10M16 7h4M4 13h4M10 13h10M4 19h10M16 19h4"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="13" r="2"/><circle cx="15" cy="19" r="2"/>',
  filter: '<circle cx="12" cy="12" r="8"/><circle cx="9.5" cy="10" r="2.2"/><circle cx="14.5" cy="10" r="2.2"/><circle cx="12" cy="14.5" r="2.2"/>',
  beauty: '<circle cx="12" cy="12" r="8"/><circle cx="9" cy="10" r="1"/><circle cx="15" cy="10" r="1"/><path d="M9.5 15c.8.9 1.7 1.3 2.5 1.3s1.7-.4 2.5-1.3"/>',
  crop: '<path d="M6 3v14a1 1 0 0 0 1 1h14"/><path d="M3 6h14a1 1 0 0 1 1 1v14"/>',
  text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
  sticker: '<path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8l-6 6H6a2 2 0 0 1-2-2z"/><path d="M20 14h-4a2 2 0 0 0-2 2v4"/>',
  doodle: '<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z"/>',
  export: '<path d="M12 16V4M8 8l4-4 4 4"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
};

const TABS = [
  ['adjust', '调整'], ['filter', '滤镜'], ['beauty', '人像'], ['crop', '裁剪'],
  ['text', '文字'], ['sticker', '贴纸'], ['doodle', '涂鸦'], ['export', '导出'],
];

function buildTabs() {
  el.tabs.innerHTML = TABS.map(([id, name]) => `
    <button class="tab${id === app.tab ? ' active' : ''}" data-tab="${id}">
      <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">${ICONS[id]}</svg>
      <span>${name}</span>
    </button>`).join('');
}

el.tabs.addEventListener('click', (e) => {
  const b = e.target.closest('.tab');
  if (!b) return;
  switchTab(b.dataset.tab);
});

function switchTab(tab) {
  if (app.tab === 'crop' && tab !== 'crop') {
    app.cropRect = null;
    app.mode = 'edit';
  }
  app.tab = tab;
  if (tab === 'crop') {
    app.mode = 'crop';
    resetCropRect();
    app.selectedId = null;
  } else if (tab === 'doodle') {
    app.mode = 'doodle';
    app.selectedId = null;
  } else if (tab === 'beauty') {
    app.mode = 'edit';
  } else {
    if (app.mode !== 'liquify') app.mode = 'edit';
  }
  buildTabs();
  refreshPanel();
  requestRender();
}

function sliderRow(name, value, onChange, { min = -100, max = 100, step = 1, fmt = (v) => v, suffix = '' } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'ctl';
  wrap.innerHTML = `
    <div class="ctl-head"><span class="ctl-name">${name}</span><span class="ctl-val">${fmt(value)}${suffix}</span></div>
    <input type="range" min="${min}" max="${max}" step="${step}" value="${value}">`;
  const input = wrap.querySelector('input');
  const val = wrap.querySelector('.ctl-val');
  let touched = false;
  const sync = () => {
    const v = Number(input.value);
    val.textContent = `${fmt(v)}${suffix}`;
    val.classList.toggle('on', Math.abs(v) > 0.001);
  };
  input.addEventListener('pointerdown', () => {
    if (!touched) { pushUndo(); touched = true; }
  });
  input.addEventListener('input', () => {
    if (!touched) { pushUndo(); touched = true; }
    onChange(Number(input.value));
    sync();
    requestRender();
  });
  input.addEventListener('pointerup', () => { touched = false; });
  input.addEventListener('change', () => { touched = false; });
  return wrap;
}

function refreshPanel() {
  const p = el.panel;
  p.innerHTML = '';
  const t = app.tab;

  if (t === 'adjust') {
    const defs = [
      ['亮度', 'brightness'], ['对比度', 'contrast'], ['饱和度', 'saturation'],
      ['色温', 'temp'], ['色调', 'tint'], ['高光', 'highlights'],
      ['阴影', 'shadows'], ['锐化', 'sharpen'], ['暗角', 'vignette'], ['颗粒', 'grain'],
    ];
    for (const [name, key] of defs) {
      p.appendChild(sliderRow(name, Math.round(state.adjust[key] * 100), (v) => {
        state.adjust[key] = v / 100;
      }));
    }
    p.appendChild(buttonRow([['重置调整', 'ghost', () => {
      pushUndo();
      state.adjust = zeros();
      requestRender();
      refreshPanel();
    }]]));
  }

  if (t === 'filter') {
    const grid = document.createElement('div');
    grid.className = 'filter-grid';
    const thumbs = buildFilterThumbs();
    FILTERS.forEach((f, i) => {
      const item = document.createElement('div');
      item.className = `filter-item${state.filterId === f.id ? ' active' : ''}`;
      item.innerHTML = `<div class="filter-thumb"></div><span class="filter-name">${f.name}</span>`;
      item.querySelector('.filter-thumb').appendChild(thumbs[i]);
      item.addEventListener('click', () => {
        pushUndo();
        state.filterId = f.id;
        requestRender();
        refreshPanel();
      });
      grid.appendChild(item);
    });
    p.appendChild(grid);
    const amtRow = sliderRow('滤镜强度', Math.round(state.filterAmt * 100), (v) => {
      state.filterAmt = v / 100;
    }, { min: 0, max: 100, suffix: '%' });
    p.appendChild(amtRow);
  }

  if (t === 'beauty') {
    p.appendChild(sliderRow('磨皮', Math.round(state.beauty.soften * 100), (v) => {
      state.beauty.soften = v / 100;
    }, { min: 0, max: 100 }));
    p.appendChild(sliderRow('美白', Math.round(state.beauty.whiten * 100), (v) => {
      state.beauty.whiten = v / 100;
    }, { min: 0, max: 100 }));

    const isLiq = app.mode === 'liquify';
    p.appendChild(sliderRow('笔刷大小', app.brush.size, (v) => { app.brush.size = v; }, { min: 12, max: 120 }));
    p.appendChild(sliderRow('笔刷力度', app.brush.strength, (v) => { app.brush.strength = v; }, { min: 10, max: 100 }));

    const row = document.createElement('div');
    row.className = 'row';
    row.style.marginTop = '4px';
    const b1 = document.createElement('button');
    b1.className = `chip${isLiq ? ' active' : ''}`;
    b1.textContent = isLiq ? '退出液化' : '液化（瘦脸推拉）';
    b1.onclick = () => {
      app.mode = isLiq ? 'edit' : 'liquify';
      app.brushPos = null;
      requestRender();
      refreshPanel();
    };
    const b2 = document.createElement('button');
    b2.className = 'chip';
    b2.textContent = '重置液化';
    b2.onclick = () => {
      app.engine.clearLiquify();
      requestRender();
      toast('液化已重置');
    };
    row.append(b1, b2);
    p.appendChild(row);

    const tip = document.createElement('p');
    tip.className = 'ctl-name';
    tip.style.marginTop = '10px';
    tip.style.lineHeight = '1.6';
    tip.textContent = '液化用法：手指按住脸颊边缘向外或向内推，即可瘦脸；推眼睛下方可放大眼睛。每次推拉不进入撤销栈，用「重置液化」还原。';
    p.appendChild(tip);
  }

  if (t === 'crop') {
    const ratios = [['自由', 0], ['1:1', 1], ['4:3', 4 / 3], ['3:4', 3 / 4], ['16:9', 16 / 9], ['9:16', 9 / 16]];
    const row = document.createElement('div');
    row.className = 'chip-row';
    for (const [name, asp] of ratios) {
      const b = document.createElement('button');
      b.className = `chip${app.cropAspect === asp ? ' active' : ''}`;
      b.textContent = name;
      b.onclick = () => {
        app.cropAspect = asp;
        if (asp > 0 && app.cropRect) {
          const r = app.cropRect;
          const cx = r.x + r.w / 2;
          const cy = r.y + r.h / 2;
          let w = Math.min(r.w, outSize().w);
          let h = w / asp;
          if (h > outSize().h) { h = outSize().h; w = h * asp; }
          app.cropRect = {
            x: clamp(cx - w / 2, 0, outSize().w - w),
            y: clamp(cy - h / 2, 0, outSize().h - h),
            w, h,
          };
        }
        refreshPanel();
        requestRender();
      };
      row.appendChild(b);
    }
    p.appendChild(row);

    const r2 = document.createElement('div');
    r2.className = 'row';
    r2.style.marginTop = '12px';
    const mk = (label, fn) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = label;
      b.onclick = () => { pushUndo(); fn(); };
      return b;
    };
    r2.append(
      mk('↻ 右转 90°', () => rotateBy(90)),
      mk('↺ 左转 90°', () => rotateBy(-90)),
      mk('水平翻转', () => flip('h')),
      mk('垂直翻转', () => flip('v')),
    );
    p.appendChild(r2);

    p.appendChild(buttonRow([
      ['取消', 'ghost', () => {
        app.cropRect = null;
        app.mode = 'edit';
        app.tab = 'adjust';
        buildTabs();
        refreshPanel();
        requestRender();
      }],
      ['应用裁剪', 'primary', () => {
        pushUndo();
        confirmCrop();
        app.mode = 'edit';
        app.tab = 'adjust';
        buildTabs();
        refreshPanel();
        toast('已裁剪');
      }],
    ]));
  }

  if (t === 'text') {
    p.appendChild(buttonRow([['+ 添加文字', 'primary', openTextSheet]]));
    const sel = state.objects.find((o) => o.id === app.selectedId);
    if (sel && sel.kind === 'text') {
      p.appendChild(sliderRow('字号', Math.round(sel.size), (v) => {
        sel.size = v;
      }, { min: 10, max: 240 }));
      p.appendChild(colorRow(sel.color, (c) => { sel.color = c; requestRender(); }));
      p.appendChild(sliderRow('描边', Math.round(sel.stroke || 0), (v) => {
        sel.stroke = v;
      }, { min: 0, max: 20 }));
      p.appendChild(buttonRow([
        ['编辑内容', 'ghost', () => openTextSheet(sel)],
        ['删除', 'ghost', () => {
          pushUndo();
          state.objects = state.objects.filter((o) => o.id !== sel.id);
          app.selectedId = null;
          requestRender();
          refreshPanel();
        }],
      ]));
    } else {
      p.appendChild(hint('点选画面中的文字可调整字号、颜色和描边'));
    }
  }

  if (t === 'sticker') {
    const grid = document.createElement('div');
    grid.className = 'sticker-grid';
    const list = ['😀', '😂', '😍', '😎', '🥰', '😭', '😡', '👍', '👏', '❤️', '✨', '🔥',
      '⭐️', '🌈', '🌸', '🌻', '🍀', '🐱', '🐶', '🎀', '💫', '🍰', '☀️', '🌙',
      '💐', '🎈', '🎉', '🦋'];
    for (const ch of list) {
      const b = document.createElement('button');
      b.className = 'sticker-item';
      b.textContent = ch;
      b.onclick = () => {
        pushUndo();
        const { w: OW, h: OH } = outSize();
        const obj = {
          id: uid(), kind: 'sticker', ch,
          x: OW / 2, y: OH / 2, rot: 0,
          size: Math.min(OW, OH) * 0.22,
        };
        state.objects.push(obj);
        app.selectedId = obj.id;
        requestRender();
        toast('已添加，可直接拖动');
      };
      grid.appendChild(b);
    }
    p.appendChild(grid);
    p.appendChild(hint('添加后可用手指拖动，拖角上的圆点缩放'));
  }

  if (t === 'doodle') {
    p.appendChild(colorRow(app.doodle.color, (c) => { app.doodle.color = c; }, true));
    p.appendChild(sliderRow('笔触粗细', app.doodle.width, (v) => { app.doodle.width = v; }, { min: 1, max: 40 }));
    p.appendChild(buttonRow([
      ['清空涂鸦', 'ghost', () => {
        pushUndo();
        state.objects = state.objects.filter((o) => o.kind !== 'doodle');
        requestRender();
        refreshPanel();
      }],
    ]));
    p.appendChild(hint('直接在画面上滑动即可手写、圈重点'));
  }

  if (t === 'export') {
    const opts = [['1080', 1080], ['2048', 2048], ['原图', 0]];
    const row = document.createElement('div');
    row.className = 'chip-row';
    for (const [name, w] of opts) {
      const b = document.createElement('button');
      b.className = `chip${app.exportW === w ? ' active' : ''}`;
      b.textContent = name === '原图' ? `原图 (${Math.round(outSize().w)}px)` : `${name}px`;
      b.onclick = () => { app.exportW = w; refreshPanel(); };
      row.appendChild(b);
    }
    p.appendChild(row);

    p.appendChild(sliderRow('画质', app.exportQuality, (v) => { app.exportQuality = v; }, { min: 60, max: 100 }));

    const fmt = document.createElement('div');
    fmt.className = 'chip-row';
    fmt.style.marginTop = '8px';
    for (const [name, mime] of [['JPG', 'image/jpeg'], ['PNG', 'image/png'], ['WebP', 'image/webp']]) {
      const b = document.createElement('button');
      b.className = `chip${app.exportFormat === mime ? ' active' : ''}`;
      b.textContent = name;
      b.onclick = () => { app.exportFormat = mime; refreshPanel(); };
      fmt.appendChild(b);
    }
    p.appendChild(fmt);

    p.appendChild(buttonRow([['保存到手机', 'primary', doExport]]));
    p.appendChild(hint('导出不带任何水印。iPhone 上若下载受限，可在结果页长按图片保存。'));
  }
}

function hint(text) {
  const d = document.createElement('p');
  d.className = 'ctl-name';
  d.style.marginTop = '10px';
  d.style.lineHeight = '1.6';
  d.textContent = text;
  return d;
}

function buttonRow(items) {
  const row = document.createElement('div');
  row.className = 'row';
  row.style.marginTop = '12px';
  for (const [label, kind, fn] of items) {
    const b = document.createElement('button');
    b.className = `btn btn-${kind}`;
    b.style.flex = '1';
    b.textContent = label;
    b.onclick = fn;
    row.appendChild(b);
  }
  return row;
}

function colorRow(current, onPick, small = false) {
  const colors = ['#ffffff', '#000000', '#ff453a', '#ff9f0a', '#ffd60a', '#32d74b', '#0a84ff', '#bf5af2', '#ff375f'];
  const row = document.createElement('div');
  row.className = 'swatches';
  row.style.marginTop = small ? '2px' : '10px';
  for (const c of colors) {
    const b = document.createElement('button');
    b.className = `swatch${current === c ? ' active' : ''}`;
    b.style.background = c;
    b.onclick = () => {
      onPick(c);
      [...row.children].forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      requestRender();
    };
    row.appendChild(b);
  }
  return row;
}

function buildFilterThumbs() {
  const size = 64;
  const base = document.createElement('canvas');
  base.width = size;
  base.height = size;
  const ctx = base.getContext('2d');
  const img = app.image;
  const iw = app.imgW;
  const ih = app.imgH;
  const side = Math.min(iw, ih);
  ctx.drawImage(img, (iw - side) / 2, (ih - side) / 2, side, side, 0, 0, size, size);
  const src = ctx.getImageData(0, 0, size, size);

  return FILTERS.map((f) => {
    const cv = document.createElement('canvas');
    cv.width = size;
    cv.height = size;
    const c2 = cv.getContext('2d');
    if (f.id === 'none') {
      c2.putImageData(src, 0, 0);
    } else {
      const data = new Uint8ClampedArray(src.data);
      applyFilterCPU(data, f, 1);
      c2.putImageData(new ImageData(data, size, size), 0, 0);
    }
    return cv;
  });
}

/* ============================ 文字输入 ============================ */

let editingId = null;

function openTextSheet(obj) {
  editingId = obj ? obj.id : null;
  el.textInput.value = obj ? obj.text : '';
  el.textSheet.classList.remove('hidden');
  setTimeout(() => el.textInput.focus(), 60);
}

el.textCancel.onclick = () => {
  el.textSheet.classList.add('hidden');
};

el.textConfirm.onclick = () => {
  const txt = el.textInput.value.trim();
  el.textSheet.classList.add('hidden');
  if (!txt) return;
  pushUndo();
  if (editingId) {
    const o = state.objects.find((x) => x.id === editingId);
    if (o) o.text = txt;
  } else {
    const { w: OW, h: OH } = outSize();
    const obj = {
      id: uid(), kind: 'text', text: txt,
      x: OW / 2, y: OH / 2, rot: 0,
      size: Math.min(OW, OH) * 0.09,
      color: '#ffffff', stroke: 0, strokeColor: '#000000',
    };
    state.objects.push(obj);
    app.selectedId = obj.id;
  }
  editingId = null;
  requestRender();
  refreshPanel();
};

/* ============================ 导入 / 导出 ============================ */

el.pick.onclick = () => el.fileInput.click();
el.camera.onclick = () => el.cameraInput.click();
el.fileInput.onchange = (e) => handleFile(e.target.files[0]);
el.cameraInput.onchange = (e) => handleFile(e.target.files[0]);

el.stage.addEventListener('dragover', (e) => e.preventDefault());
el.stage.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f) handleFile(f);
});

async function handleFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    toast('请选择图片文件');
    return;
  }
  loading(true);
  try {
    let bmp;
    try {
      bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      bmp = await loadViaImg(file);
    }
    await startEditing(bmp);
  } catch (err) {
    console.error(err);
    toast('这张图打不开，试试 JPG 或 PNG');
  } finally {
    loading(false);
  }
}

function loadViaImg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
    img.src = url;
  });
}

async function startEditing(bmp) {
  if (!app.engine) {
    app.engine = new Engine(el.gl);
  }
  let w = bmp.width;
  let h = bmp.height;
  const limit = Math.min(4096, app.engine.maxTextureSize());

  if (Math.max(w, h) > limit || Math.max(w, h) > 4096) {
    const k = limit / Math.max(w, h);
    const cv = document.createElement('canvas');
    cv.width = Math.round(w * k);
    cv.height = Math.round(h * k);
    const cx = cv.getContext('2d');
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(bmp, 0, 0, cv.width, cv.height);
    const scaled = await createImageBitmap(cv);
    app.image = scaled;
    w = cv.width;
    h = cv.height;
  } else {
    app.image = bmp;
  }

  app.imgW = w;
  app.imgH = h;
  app.engine.setImage(app.image, w, h);

  state.adjust = zeros();
  state.beauty = { soften: 0, whiten: 0 };
  state.filterId = 'none';
  state.filterAmt = 1;
  state.crop = { x: 0, y: 0, w, h };
  state.rot = 0;
  state.flipH = false;
  state.flipV = false;
  state.objects = [];
  app.selectedId = null;
  app.mode = 'edit';
  app.tab = 'adjust';
  app.view = { zoom: 1, panX: 0, panY: 0 };
  app.undoStack = [];
  app.redoStack = [];
  app.cropAspect = 0;
  app.exportW = Math.min(2048, Math.round(w)) >= 2048 ? 2048 : 0;

  el.welcome.classList.add('hidden');
  el.editor.classList.remove('hidden');
  buildTabs();
  refreshPanel();
  updateHistoryButtons();

  requestAnimationFrame(() => {
    requestRender();
  });
}

async function doExport() {
  if (!app.image) return;
  loading(true);
  await new Promise((r) => setTimeout(r, 30));
  try {
    const { w: OW, h: OH } = outSize();
    let tw = app.exportW === 0 ? OW : Math.min(app.exportW, OW);
    if (app.exportW === 0 && Math.max(OW, OH) > 4096) {
      const k = 4096 / Math.max(OW, OH);
      tw = Math.round(OW * k);
    }
    const k = tw / OW;
    const th = Math.round(OH * k);

    const prevW = el.gl.width;
    const prevH = el.gl.height;
    app.engine.resize(tw, th);
    app.engine.render({
      clipOrigin: [-1, 1],
      clipSize: [2, -2],
      uvXf: uvMatrix(),
      cropScale: [state.crop.w / app.imgW, state.crop.h / app.imgH],
      cropOffset: [state.crop.x / app.imgW, state.crop.y / app.imgH],
      adjust: state.adjust,
      beauty: state.beauty,
      filter: filterById(state.filterId),
      filterAmt: state.filterAmt,
    });

    const out = document.createElement('canvas');
    out.width = tw;
    out.height = th;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, tw, th);
    ctx.drawImage(el.gl, 0, 0, tw, th);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    for (const o of state.objects) drawObject(ctx, o);

    app.engine.resize(prevW, prevH);
    requestRender();

    const mime = state.objects.length && app.exportFormat === 'image/jpeg' ? 'image/jpeg' : app.exportFormat;
    const blob = await new Promise((res) => out.toBlob(res, mime, app.exportQuality / 100));
    if (!blob) throw new Error('export failed');

    const url = URL.createObjectURL(blob);
    el.resultImg.src = url;
    el.resultDownload.href = url;
    const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
    el.resultDownload.download = `qingxiu-${Date.now()}.${ext}`;
    el.result.classList.remove('hidden');
  } catch (err) {
    console.error(err);
    toast('导出失败，试试降低尺寸');
  } finally {
    loading(false);
  }
}

el.exportBtn.onclick = doExport;
el.resultClose.onclick = () => el.result.classList.add('hidden');

/* ============================ 顶部操作 ============================ */

el.back.onclick = () => {
  el.editor.classList.add('hidden');
  el.welcome.classList.remove('hidden');
  app.selectedId = null;
  app.mode = 'edit';
};

el.undo.onclick = undo;
el.redo.onclick = redo;

const startCompare = (e) => {
  if (!app.image) return;
  e.preventDefault();
  app.comparing = true;
  requestRender();
};
const endCompare = () => {
  if (!app.comparing) return;
  app.comparing = false;
  requestRender();
};
el.compare.addEventListener('pointerdown', startCompare);
window.addEventListener('pointerup', endCompare);
window.addEventListener('pointercancel', endCompare);

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
  }
  if (e.key === 'Escape' && !el.textSheet.classList.contains('hidden')) {
    el.textSheet.classList.add('hidden');
  }
});

window.addEventListener('resize', () => requestRender());
if (window.ResizeObserver) new ResizeObserver(() => requestRender()).observe(el.stage);

document.addEventListener('gesturestart', (e) => e.preventDefault());

/* ============================ 启动 ============================ */

buildTabs();
refreshPanel();
updateHistoryButtons();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// 开发预览：地址后加 #demo 会载入一张生成图，方便在没有相册的环境里验证界面
if (location.hash.startsWith('#demo')) {
  const cv = document.createElement('canvas');
  cv.width = 900;
  cv.height = 1200;
  const c = cv.getContext('2d');
  const g = c.createLinearGradient(0, 0, 0, 1200);
  g.addColorStop(0, '#2b3a55');
  g.addColorStop(0.45, '#7d5a6b');
  g.addColorStop(1, '#d9a066');
  c.fillStyle = g;
  c.fillRect(0, 0, 900, 1200);

  const rg = c.createRadialGradient(450, 520, 40, 450, 560, 420);
  rg.addColorStop(0, 'rgba(255,232,214,.95)');
  rg.addColorStop(1, 'rgba(255,232,214,0)');
  c.fillStyle = rg;
  c.fillRect(0, 80, 900, 900);

  c.fillStyle = '#f2c8a8';
  c.beginPath();
  c.ellipse(450, 500, 150, 190, 0, 0, Math.PI * 2);
  c.fill();

  c.fillStyle = '#3a2b2b';
  c.beginPath();
  c.ellipse(450, 360, 160, 120, 0, Math.PI, Math.PI * 2);
  c.fill();

  c.fillStyle = '#2b2b33';
  c.beginPath();
  c.moveTo(450, 700);
  c.quadraticCurveTo(250, 780, 190, 1200);
  c.lineTo(710, 1200);
  c.quadraticCurveTo(650, 780, 450, 700);
  c.fill();

  c.fillStyle = '#1f1f24';
  c.beginPath();
  c.arc(400, 500, 15, 0, Math.PI * 2);
  c.arc(500, 500, 15, 0, Math.PI * 2);
  c.fill();

  c.strokeStyle = '#b06a5a';
  c.lineWidth = 8;
  c.beginPath();
  c.arc(450, 600, 52, 0.25, Math.PI - 0.25);
  c.stroke();

  createImageBitmap(cv).then((bmp) => {
    startEditing(bmp).then(() => {
      const m = location.hash.match(/tab=(\w+)/);
      if (m) switchTab(m[1]);
    });
  });
}
