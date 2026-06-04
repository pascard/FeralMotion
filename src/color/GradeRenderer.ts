import { FRAG, VERT } from './shader';
import { GradeParams } from './types';

/** Minimal WebGL2 renderer that uploads a video/image frame as a texture and
 * draws it through the grading shader onto its canvas. One instance per canvas
 * (preview + a separate full-res one for export). */
export class GradeRenderer {
  readonly gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private tex: WebGLTexture;
  private u: Record<string, WebGLUniformLocation | null> = {};

  constructor(public canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', {
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    }) as WebGL2RenderingContext;
    if (!gl) throw new Error('WebGL2 non disponible sur cet appareil.');
    this.gl = gl;

    this.prog = this.build(VERT, FRAG);
    gl.useProgram(this.prog);

    // full-screen triangle-strip quad
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const names = [
      'uTex','uResolution','uTime','uTemp','uTint','uExposure','uContrast','uShadows',
      'uHighlights','uSaturation','uVibrance','uTeal','uFade','uVignette','uGrain',
      'uLetterbox','uToneMap',
    ];
    for (const n of names) this.u[n] = gl.getUniformLocation(this.prog, n);
    gl.uniform1i(this.u.uTex, 0);
  }

  resize(w: number, h: number) {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  render(source: TexImageSource, w: number, h: number, p: GradeParams, time = 0) {
    const gl = this.gl;
    this.resize(w, h);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source as any);
    } catch {
      return; // frame not ready
    }

    gl.uniform2f(this.u.uResolution, w, h);
    gl.uniform1f(this.u.uTime, time);
    gl.uniform1f(this.u.uTemp, p.temp);
    gl.uniform1f(this.u.uTint, p.tint);
    gl.uniform1f(this.u.uExposure, p.exposure);
    gl.uniform1f(this.u.uContrast, p.contrast);
    gl.uniform1f(this.u.uShadows, p.shadows);
    gl.uniform1f(this.u.uHighlights, p.highlights);
    gl.uniform1f(this.u.uSaturation, p.saturation);
    gl.uniform1f(this.u.uVibrance, p.vibrance);
    gl.uniform1f(this.u.uTeal, p.tealOrange);
    gl.uniform1f(this.u.uFade, p.fade);
    gl.uniform1f(this.u.uVignette, p.vignette);
    gl.uniform1f(this.u.uGrain, p.grain);
    gl.uniform1f(this.u.uLetterbox, p.letterbox);
    gl.uniform1i(this.u.uToneMap, p.toneMap);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private build(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error('Shader: ' + gl.getShaderInfoLog(s));
      }
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('Program: ' + gl.getProgramInfoLog(prog));
    }
    return prog;
  }

  /** Free the WebGL context (contexts are a scarce resource — must release). */
  dispose() {
    try {
      this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      /* ignore */
    }
  }
}
