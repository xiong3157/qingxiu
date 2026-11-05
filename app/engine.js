import { MESH_VERT, BASE_FRAG, STAMP_VERT, STAMP_FRAG } from './shaders.js';

const MESH_SEG = 96;
const DISP_SIZE = 512;
const DISP_AMP = 0.055;

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('浏览器不支持 WebGL2，请使用较新版本的 Chrome / Safari / Edge');
    this.gl = gl;

    this.progBase = this._program(MESH_VERT, BASE_FRAG, 'base');
    this.progStamp = this._program(STAMP_VERT, STAMP_FRAG, 'stamp');

    this.tex = null;
    this.imgW = 0;
    this.imgH = 0;

    this._initMesh();
    this._initQuad();
    this._initDisp();

    this.u = this._collect(this.progBase, [
      'uClipOrigin', 'uClipSize', 'uUvXf', 'uCropScale', 'uCropOffset',
      'uDisp', 'uDispAmp', 'uDispOn',
      'uTex', 'uTexel',
      'uBrightness', 'uContrast', 'uSaturation', 'uTemp', 'uTint',
      'uHighlights', 'uShadows', 'uSharpen', 'uVignette', 'uGrain',
      'uSoften', 'uWhiten',
      'uFilterMat', 'uFilterGamma', 'uFilterLift', 'uFilterAmt',
    ]);

    this.us = this._collect(this.progStamp, [
      'uPrev', 'uCenter', 'uDelta', 'uRadius', 'uAspect',
    ]);

    this.hasLiquify = false;
  }

  _program(vsSrc, fsSrc, label) {
    const gl = this.gl;
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        throw new Error(`[${label}] 着色器编译失败: ${log}`);
      }
      return sh;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`[${label}] 着色器链接失败: ${gl.getProgramInfoLog(prog)}`);
    }
    return prog;
  }

  _collect(prog, names) {
    const gl = this.gl;
    const out = {};
    for (const n of names) out[n] = gl.getUniformLocation(prog, n);
    return out;
  }

  _initMesh() {
    const gl = this.gl;
    const n = MESH_SEG;
    const N = n + 1;
    const pos = new Float32Array(N * N * 2);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = (j * N + i) * 2;
        pos[k] = i / n;
        pos[k + 1] = j / n;
      }
    }
    const idx = new Uint32Array(n * n * 6);
    let p = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = j * N + i;
        const b = a + 1;
        const c = a + N;
        const d = c + 1;
        idx[p++] = a; idx[p++] = c; idx[p++] = b;
        idx[p++] = b; idx[p++] = c; idx[p++] = d;
      }
    }
    this.vaoMesh = gl.createVertexArray();
    gl.bindVertexArray(this.vaoMesh);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.meshCount = idx.length;
  }

  _initQuad() {
    const gl = this.gl;
    this.vaoQuad = gl.createVertexArray();
    gl.bindVertexArray(this.vaoQuad);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  _initDisp() {
    const gl = this.gl;
    this.disp = [];
    for (let i = 0; i < 2; i++) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, DISP_SIZE, DISP_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      this.disp.push({ tex, fbo });
    }
    this.dispCur = 0;
    this.clearLiquify();
  }

  clearLiquify() {
    const gl = this.gl;
    for (let i = 0; i < 2; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.disp[i].fbo);
      gl.viewport(0, 0, DISP_SIZE, DISP_SIZE);
      gl.clearColor(0.5, 0.5, 0.5, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.hasLiquify = false;
  }

  setImage(source, w, h) {
    const gl = this.gl;
    if (this.tex) gl.deleteTexture(this.tex);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.tex = tex;
    this.imgW = w;
    this.imgH = h;
    this.clearLiquify();
  }

  maxTextureSize() {
    return this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE);
  }

  resize(w, h) {
    const c = this.canvas;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
  }

  // 在位移贴图上盖一个笔刷印章
  stamp(uvX, uvY, du, dv, radiusUv) {
    const gl = this.gl;
    const src = this.dispCur;
    const dst = 1 - src;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.disp[dst].fbo);
    gl.viewport(0, 0, DISP_SIZE, DISP_SIZE);
    gl.disable(gl.BLEND);
    gl.useProgram(this.progStamp);
    gl.bindVertexArray(this.vaoQuad);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.disp[src].tex);
    gl.uniform1i(this.us.uPrev, 0);
    gl.uniform2f(this.us.uCenter, uvX, uvY);
    gl.uniform2f(this.us.uDelta, du, dv);
    gl.uniform1f(this.us.uRadius, radiusUv);
    gl.uniform1f(this.us.uAspect, this.imgH > 0 ? this.imgW / this.imgH : 1);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.dispCur = dst;
    this.hasLiquify = true;
  }

  render(view) {
    const gl = this.gl;
    const c = this.canvas;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, c.width, c.height);
    gl.clearColor(0.078, 0.078, 0.09, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (!this.tex) return;

    const u = this.u;
    const a = view.adjust;
    const f = view.filter;

    gl.useProgram(this.progBase);
    gl.bindVertexArray(this.vaoMesh);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(u.uTex, 0);
    gl.uniform2f(u.uTexel, 1 / this.imgW, 1 / this.imgH);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.disp[this.dispCur].tex);
    gl.uniform1i(u.uDisp, 1);
    gl.uniform1f(u.uDispAmp, DISP_AMP);
    gl.uniform1f(u.uDispOn, this.hasLiquify ? 1 : 0);

    gl.uniform2f(u.uClipOrigin, view.clipOrigin[0], view.clipOrigin[1]);
    gl.uniform2f(u.uClipSize, view.clipSize[0], view.clipSize[1]);
    gl.uniformMatrix2fv(u.uUvXf, false, view.uvXf);
    gl.uniform2f(u.uCropScale, view.cropScale[0], view.cropScale[1]);
    gl.uniform2f(u.uCropOffset, view.cropOffset[0], view.cropOffset[1]);

    gl.uniform1f(u.uBrightness, a.brightness);
    gl.uniform1f(u.uContrast, a.contrast);
    gl.uniform1f(u.uSaturation, a.saturation);
    gl.uniform1f(u.uTemp, a.temp);
    gl.uniform1f(u.uTint, a.tint);
    gl.uniform1f(u.uHighlights, a.highlights);
    gl.uniform1f(u.uShadows, a.shadows);
    gl.uniform1f(u.uSharpen, a.sharpen);
    gl.uniform1f(u.uVignette, a.vignette);
    gl.uniform1f(u.uGrain, a.grain);

    gl.uniform1f(u.uSoften, view.beauty.soften);
    gl.uniform1f(u.uWhiten, view.beauty.whiten);

    gl.uniformMatrix3fv(u.uFilterMat, false, f.mat);
    gl.uniform3fv(u.uFilterGamma, f.gamma);
    gl.uniform3fv(u.uFilterLift, f.lift);
    gl.uniform1f(u.uFilterAmt, view.filterAmt);

    gl.drawElements(gl.TRIANGLES, this.meshCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }
}
