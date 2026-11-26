import type { WebGPURenderer } from 'three/webgpu';

/** デモが実際に描画に使っている GPU の識別情報。 */
export interface GpuInfo {
  backend: 'webgpu' | 'webgl';
  /** WebGPU はアダプタの `vendor architecture`、WebGL は `UNMASKED_RENDERER_WEBGL` の文字列。 */
  adapter: string;
  /** SwiftShader などのソフトウェア実装で描画しているとき true。 */
  software: boolean;
}

// WebGL にはフォールバック判定の API がないため、既知のソフトウェアラスタライザ名で判定する。
// Chrome の SwiftShader と Mesa の llvmpipe / softpipe が対象。
const SOFTWARE_GL_RENDERER = /SwiftShader|llvmpipe|softpipe/i;

/**
 * renderer が使っているバックエンドと GPU を返す。`renderer.init()` 完了後に呼ぶ。
 *
 * WebGPU は `GPUDevice.adapterInfo` を読むため、別途 adapter を要求したときと違って
 * renderer 自身のデバイスの情報になる。
 */
export function describeGpu(renderer: WebGPURenderer): GpuInfo {
  // `device` / `gl` は three の型定義に公開されていないため構造で読む。
  const backend = renderer.backend as unknown as {
    isWebGPUBackend?: boolean;
    device: GPUDevice;
    gl: WebGL2RenderingContext;
  };
  if (backend.isWebGPUBackend === true) {
    const info = backend.device.adapterInfo;
    return {
      backend: 'webgpu',
      adapter: `${info.vendor} ${info.architecture}`,
      software: info.isFallbackAdapter,
    };
  }
  const gl = backend.gl;
  // Firefox は拡張を非推奨にしており、`RENDERER` 自体が丸めた実名を返す。
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const adapter = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  return { backend: 'webgl', adapter, software: SOFTWARE_GL_RENDERER.test(adapter) };
}

/** HUD 表示用の 1 行表記（例: `webgpu (nvidia ampere)`）。 */
export function gpuLabel(gpu: GpuInfo): string {
  return `${gpu.backend} (${gpu.adapter}${gpu.software ? ', software' : ''})`;
}
