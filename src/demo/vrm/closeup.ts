/**
 * 対象アバターの上半身（首〜腰、肩まわり）を画面右下の小窓に拡大表示するクローズアップビュー。
 *
 * 通常の構図ではアバター 1 体が画面上 200px 程度しかなく、L0 と L4 の差がピクセル以下に埋もれる。
 * 小窓では服の柄や縫い目をおおむね等倍（1 テクセル ≒ 1 画素）で映し、選択レベルの粗さを目で確かめられるようにする。
 * 顔より服のほうが模様が細かく、解像度の差がわかりやすい。
 *
 * LOD のレベル選択はメインカメラだけで行い、このカメラは選択に関与しない。
 * 小窓に映るのはメインカメラ基準で選ばれたレベルそのものになる。
 */
import { PerspectiveCamera, Vector3, type Object3D, type WebGPURenderer } from 'three/webgpu';

/** 枠取りの基準にする raw ボーン。どちらも VRM の必須ボーン。 */
export interface CloseupTarget {
  readonly head: Object3D;
  readonly hips: Object3D;
}

export interface CloseupView {
  /**
   * メイン描画の後に呼び、小窓へ描画する。`target` が null のときは描かない。
   * `hidden` は小窓に写り込ませないオブジェクト（頭上ラベルなど）で、描画中だけ非表示にする。
   */
  render(
    renderer: WebGPURenderer,
    scene: Object3D,
    mainCamera: PerspectiveCamera,
    target: CloseupTarget | null,
    hidden: readonly Object3D[],
  ): void;
  setEnabled(enabled: boolean): void;
  setCaption(text: string): void;
}

// 小窓の一辺（CSS px）。1080p で GUI（右上、高さ約 460px）と重ならない大きさ。
const MAX_SIZE = 560;
// 画面に対する小窓の最大比率。小さいウィンドウで主画面を覆いすぎないための値。
const MAX_SCREEN_RATIO = 0.55;
const MARGIN = 16;
// 画面下端のヒント行（`#hint`）を避ける余白
const BOTTOM_MARGIN = 40;
// 頭ボーン（首の付け根）〜腰ボーンの間で、枠の中心を置く位置（0 = 腰, 1 = 首）。
// 首からスカート上端までが収まり、顎が入らない位置（目視で調整）。
const CENTER_T = 0.52;
// 首〜腰の長さに対する枠の高さの倍率。肩まわりと腕の付け根が左右に収まる値（目視で調整）。
const FIELD_PER_TORSO = 1.05;
// 対象からカメラまでの距離（m）。望遠にして遠近の歪みを抑えつつ、near で体を切らない距離。
const DISTANCE = 1.6;

export function createCloseupView(): CloseupView {
  const camera = new PerspectiveCamera(30, 1, 0.05, 50);
  const head = new Vector3();
  const focus = new Vector3();
  const direction = new Vector3();

  const frame = document.createElement('div');
  Object.assign(frame.style, {
    position: 'fixed',
    right: `${MARGIN}px`,
    bottom: `${BOTTOM_MARGIN}px`,
    boxSizing: 'border-box',
    border: '2px solid rgba(230, 241, 255, 0.85)',
    borderRadius: '4px',
    pointerEvents: 'none',
    display: 'none',
  });
  const caption = document.createElement('div');
  Object.assign(caption.style, {
    position: 'absolute',
    left: '8px',
    top: '6px',
    padding: '2px 8px',
    borderRadius: '4px',
    background: 'rgba(8, 14, 22, 0.75)',
    color: '#e6f1ff',
    font: '600 15px ui-monospace, Menlo, Consolas, monospace',
  });
  frame.append(caption);
  document.body.append(frame);

  let enabled = false;

  return {
    render(renderer, scene, mainCamera, target, hidden) {
      frame.style.display = enabled && target ? '' : 'none';
      if (!enabled || !target) return;
      const size = Math.min(
        MAX_SIZE,
        Math.floor(Math.min(window.innerWidth, window.innerHeight) * MAX_SCREEN_RATIO),
      );
      frame.style.width = `${size}px`;
      frame.style.height = `${size}px`;
      const x = window.innerWidth - MARGIN - size;
      const y = window.innerHeight - BOTTOM_MARGIN - size;

      // 体格の違うモデルでも同じ範囲が映るよう、首〜腰の実長から画角を決める。
      target.head.getWorldPosition(head);
      target.hips.getWorldPosition(focus);
      const fieldHeight = head.distanceTo(focus) * FIELD_PER_TORSO;
      focus.lerp(head, CENTER_T);
      camera.fov = (2 * Math.atan(fieldHeight / 2 / DISTANCE) * 180) / Math.PI;
      camera.updateProjectionMatrix();

      // メインカメラ側から望遠で覗く。メイン画面と同じ向きの体が映り、どのアバターを拡大しているか対応が取れる。
      direction.subVectors(mainCamera.position, focus).normalize();
      camera.position.copy(focus).addScaledVector(direction, DISTANCE);
      camera.lookAt(focus);

      const visibility = hidden.map((object) => object.visible);
      for (const object of hidden) object.visible = false;
      renderer.setScissorTest(true);
      renderer.setScissor(x, y, size, size);
      renderer.setViewport(x, y, size, size);
      renderer.render(scene, camera);
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
      hidden.forEach((object, index) => {
        object.visible = visibility[index];
      });
    },
    setEnabled(value) {
      enabled = value;
    },
    setCaption(text) {
      caption.textContent = text;
    },
  };
}
