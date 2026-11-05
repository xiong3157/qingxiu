// 叠加图层：文字 / 贴纸 / 涂鸦
// 坐标统一使用「输出图像像素」（裁剪旋转后的坐标系）

const FONT_STACK = '"PingFang SC","Noto Sans SC","Microsoft YaHei",system-ui,sans-serif';

const measureCanvas = document.createElement('canvas');
const measureCtx = measureCanvas.getContext('2d');

export function fontStr(obj) {
  return `${obj.bold ? 600 : 400} ${obj.size}px ${FONT_STACK}`;
}

export function objectSize(obj) {
  if (obj.kind === 'text') {
    measureCtx.font = fontStr(obj);
    const lines = (obj.text || ' ').split('\n');
    let w = 1;
    for (const ln of lines) w = Math.max(w, measureCtx.measureText(ln || ' ').width);
    return { w, h: lines.length * obj.size * 1.26 };
  }
  if (obj.kind === 'sticker') return { w: obj.size, h: obj.size };
  if (obj.kind === 'doodle') {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of obj.pts) {
      x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]);
      x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
    }
    if (!isFinite(x0)) return { w: 1, h: 1 };
    return { w: Math.max(1, x1 - x0) + obj.width, h: Math.max(1, y1 - y0) + obj.width };
  }
  return { w: 10, h: 10 };
}

export function drawObject(ctx, obj) {
  if (obj.kind === 'doodle') {
    drawDoodle(ctx, obj);
    return;
  }
  ctx.save();
  ctx.translate(obj.x, obj.y);
  if (obj.rot) ctx.rotate(obj.rot);

  if (obj.kind === 'text') {
    ctx.font = fontStr(obj);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lines = (obj.text || '').split('\n');
    const lh = obj.size * 1.26;
    const y0 = -((lines.length - 1) * lh) / 2;
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    lines.forEach((ln, i) => {
      const y = y0 + i * lh;
      if (obj.stroke > 0) {
        ctx.lineWidth = obj.stroke;
        ctx.strokeStyle = obj.strokeColor || '#000';
        ctx.strokeText(ln, 0, y);
      }
      ctx.fillStyle = obj.color || '#fff';
      ctx.fillText(ln, 0, y);
    });
  } else if (obj.kind === 'sticker') {
    ctx.font = `${obj.size}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(obj.ch, 0, 0);
  }
  ctx.restore();
}

function drawDoodle(ctx, obj) {
  const pts = obj.pts;
  if (!pts.length) return;
  ctx.save();
  ctx.translate(obj.x, obj.y);
  if (obj.rot) ctx.rotate(obj.rot);
  ctx.strokeStyle = obj.color;
  ctx.lineWidth = obj.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  if (pts.length === 1) {
    ctx.arc(pts[0][0], pts[0][1], obj.width / 2, 0, Math.PI * 2);
  } else {
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2;
      const my = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last[0], last[1]);
  }
  ctx.stroke();
  ctx.restore();
}

// 把屏幕坐标点换算到对象本地坐标（去旋转）
export function toLocal(obj, x, y) {
  const dx = x - obj.x;
  const dy = y - obj.y;
  const c = Math.cos(-(obj.rot || 0));
  const s = Math.sin(-(obj.rot || 0));
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

export function hitTest(objects, x, y, s) {
  const pad = 8 / s;
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i];
    if (o.hidden) continue;
    const p = toLocal(o, x, y);
    const { w, h } = objectSize(o);
    if (o.kind === 'doodle') {
      if (p.x > -w / 2 - pad && p.x < w / 2 + pad && p.y > -h / 2 - pad && p.y < h / 2 + pad) return o;
    } else if (Math.abs(p.x) < w / 2 + pad && Math.abs(p.y) < h / 2 + pad) {
      return o;
    }
  }
  return null;
}

export function handlePoints(obj, s) {
  const { w, h } = objectSize(obj);
  const rot = obj.rot || 0;
  const c = Math.cos(rot), si = Math.sin(rot);
  const off = 26 / s;
  const raw = [
    [-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2],
  ];
  const corners = raw.map(([lx, ly]) => ({
    x: obj.x + lx * c - ly * si,
    y: obj.y + lx * si + ly * c,
  }));
  const ry = -h / 2 - off;
  const rotate = { x: obj.x + 0 * c - ry * si, y: obj.y + 0 * si + ry * c };
  return { corners, rotate };
}

export function drawSelection(ctx, obj, s) {
  const { w, h } = objectSize(obj);
  const hs = 7 / s;
  ctx.save();
  ctx.translate(obj.x, obj.y);
  if (obj.rot) ctx.rotate(obj.rot);

  ctx.strokeStyle = 'rgba(255,210,74,.95)';
  ctx.lineWidth = 1.2 / s;
  ctx.setLineDash([5 / s, 4 / s]);
  ctx.strokeRect(-w / 2, -h / 2, w, h);
  ctx.setLineDash([]);

  const off = 26 / s;
  ctx.beginPath();
  ctx.moveTo(0, -h / 2);
  ctx.lineTo(0, -h / 2 - off + hs * 1.4);
  ctx.strokeStyle = 'rgba(255,210,74,.8)';
  ctx.lineWidth = 1.2 / s;
  ctx.stroke();

  ctx.fillStyle = '#ffd24a';
  const corners = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
  for (const [x, y] of corners) {
    ctx.beginPath();
    ctx.arc(x, y, hs, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(0, -h / 2 - off, hs * 1.15, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,210,74,1)';
  ctx.lineWidth = 1.6 / s;
  ctx.stroke();

  ctx.restore();
}
