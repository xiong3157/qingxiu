// 滤镜预设：统一用 3x3 颜色矩阵 + gamma + 抬升量描述，
// 这样 GPU 只需要一个着色器就能跑完全部预设。

const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];

const mul = (a, b) => {
  const o = new Array(9).fill(0);
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 3; r++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += a[k * 3 + r] * b[c * 3 + k];
      o[c * 3 + r] = s;
    }
  }
  return o;
};

const saturate = (s) => {
  const lr = 0.2126, lg = 0.7152, lb = 0.0722;
  return [
    lr + s * (1 - lr), lr - s * lr, lr - s * lr,
    lg - s * lg, lg + s * (1 - lg), lg - s * lg,
    lb - s * lb, lb - s * lb, lb + s * (1 - lb),
  ];
};

const diag = (r, g, b) => [r, 0, 0, 0, g, 0, 0, 0, b];

const sepia = (a) => {
  const s = [
    0.393, 0.349, 0.272,
    0.769, 0.686, 0.534,
    0.189, 0.168, 0.131,
  ];
  const o = new Array(9);
  for (let i = 0; i < 9; i++) o[i] = I[i] * (1 - a) + s[i] * a;
  return o;
};

export const FILTERS = [
  { id: 'none', name: '原图', mat: I, gamma: [1, 1, 1], lift: [0, 0, 0] },
  {
    id: 'clean', name: '清透',
    mat: mul(saturate(1.12), diag(1.02, 1.01, 1.0)), gamma: [1.02, 1.0, 0.99], lift: [0.008, 0.008, 0.010],
  },
  {
    id: 'film', name: '胶片',
    mat: mul(saturate(0.92), diag(1.04, 1.0, 0.98)), gamma: [1.05, 1.02, 0.99], lift: [0.020, 0.016, 0.018],
  },
  {
    id: 'warm', name: '暖阳',
    mat: mul(saturate(1.05), diag(1.07, 1.01, 0.93)), gamma: [1.0, 1.0, 1.02], lift: [0.014, 0.006, 0.0],
  },
  {
    id: 'cool', name: '冷调',
    mat: mul(saturate(0.98), diag(0.94, 1.0, 1.09)), gamma: [1.01, 1.0, 0.99], lift: [0.0, 0.004, 0.016],
  },
  {
    id: 'mono', name: '黑白',
    mat: mul(saturate(0), diag(1.04, 1.04, 1.04)), gamma: [1.02, 1.02, 1.02], lift: [0, 0, 0],
  },
  {
    id: 'retro', name: '怀旧',
    mat: mul(sepia(0.66), saturate(0.9)), gamma: [1.04, 1.0, 0.95], lift: [0.02, 0.014, 0.006],
  },
  {
    id: 'fade', name: '褪色',
    mat: mul(saturate(0.84), diag(0.96, 0.96, 0.97)), gamma: [1.0, 1.0, 1.0], lift: [0.048, 0.046, 0.050],
  },
  {
    id: 'cream', name: '奶油',
    mat: mul(saturate(0.95), diag(1.05, 1.02, 0.97)), gamma: [0.98, 0.99, 1.0], lift: [0.036, 0.032, 0.026],
  },
  {
    id: 'forest', name: '森林',
    mat: mul(saturate(1.02), diag(0.94, 1.05, 0.95)), gamma: [1.02, 1.0, 1.02], lift: [0.0, 0.010, 0.004],
  },
  {
    id: 'sakura', name: '樱粉',
    mat: mul(saturate(1.04), diag(1.06, 0.97, 1.03)), gamma: [0.99, 1.0, 0.99], lift: [0.026, 0.014, 0.022],
  },
  {
    id: 'night', name: '夜色',
    mat: mul(saturate(0.94), diag(0.96, 0.99, 1.06)), gamma: [1.10, 1.04, 0.98], lift: [0.0, 0.006, 0.020],
  },
  {
    id: 'sunset', name: '落日',
    mat: mul(saturate(1.1), diag(1.12, 1.0, 0.86)), gamma: [0.98, 0.99, 1.02], lift: [0.030, 0.010, 0.0],
  },
  {
    id: 'steel', name: '冷硬',
    mat: mul(saturate(0.78), diag(0.96, 1.0, 1.04)), gamma: [1.06, 1.04, 1.0], lift: [0.0, 0.008, 0.018],
  },
  {
    id: 'peach', name: '蜜桃',
    mat: mul(saturate(1.08), diag(1.09, 0.99, 0.98)), gamma: [0.97, 0.99, 1.0], lift: [0.034, 0.020, 0.016],
  },
];

export const filterById = (id) => FILTERS.find((f) => f.id === id) || FILTERS[0];

// 缩略图用：在 CPU 上跑同一套参数
export function applyFilterCPU(data, f, amount = 1) {
  const m = f.mat, g = f.gamma, l = f.lift;
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i] / 255, gr = data[i + 1] / 255, b = data[i + 2] / 255;
    const nr = m[0] * r + m[3] * gr + m[6] * b + l[0];
    const ng = m[1] * r + m[4] * gr + m[7] * b + l[1];
    const nb = m[2] * r + m[5] * gr + m[8] * b + l[2];
    r = Math.pow(Math.min(1, Math.max(0, nr)), g[0]);
    gr = Math.pow(Math.min(1, Math.max(0, ng)), g[1]);
    b = Math.pow(Math.min(1, Math.max(0, nb)), g[2]);
    data[i] = Math.round((data[i] / 255 * (1 - amount) + r * amount) * 255);
    data[i + 1] = Math.round((data[i + 1] / 255 * (1 - amount) + gr * amount) * 255);
    data[i + 2] = Math.round((data[i + 2] / 255 * (1 - amount) + b * amount) * 255);
  }
}
