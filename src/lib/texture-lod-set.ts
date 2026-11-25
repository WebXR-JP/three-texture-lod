/**
 * LODレベルごとのマテリアルバリアントの生成・検証・追従。
 *
 * @packageDocumentation
 */
import type { Material, Texture } from 'three';
import type { TextureLodLevel, TextureLodSetOptions } from './types.js';

/** スカラー比較するテクスチャ設定の一覧（wrapR を除く。r187 の Texture には存在しない）。 */
const COMPARED_PROPS = [
  'mapping',
  'channel',
  'wrapS',
  'wrapT',
  'minFilter',
  'magFilter',
  'colorSpace',
  'type',
  'format',
  'flipY',
  'anisotropy',
  'generateMipmaps',
] as const;

/**
 * テクスチャか否かを判定する。
 *
 * ADR: ライブラリは three の値を import しない方針のため `instanceof Texture` を使えない。
 * 代わりに three の Texture が持つ不変条件 `isTexture === true` でダックタイピング判定する。
 */
function isTexture(value: unknown): value is Texture {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { isTexture?: unknown }).isTexture === true
  );
}

/**
 * マテリアル上のスロット値を読み書きするための最小の構造型への変換。
 *
 * ADR: `Material` 基底型には `map` 等のスロットが存在しないため、
 * 値importなしで触れるよう `Record` へ読み替える。`as unknown as` を経由するのは、
 * `Material` と `Record<string, unknown>` 間に継承関係がなく直接の `as` が効かないためである。
 * 書き込み対象は検証済みのスロット名に限定し、任意キーへの書き込みは行わない。
 */
function slotsOf(material: Material): Partial<Record<string, unknown>> {
  return material as unknown as Partial<Record<string, unknown>>;
}

/** レベル定義を検証し、問題があれば `Error` を投げる。 */
function validateLevels(
  levels: readonly {
    readonly distance: number;
    readonly textures: Readonly<Partial<Record<string, unknown>>>;
  }[],
  hysteresis: number,
): void {
  if (levels.length < 2) {
    throw new Error(`levels は2件以上必要です: ${levels.length}件`);
  }
  if (!(hysteresis >= 0 && hysteresis < 1)) {
    throw new Error(`hysteresis は 0 以上 1 未満である必要があります: ${hysteresis}`);
  }
  for (const [index, level] of levels.entries()) {
    if (!Number.isFinite(level.distance)) {
      throw new Error(`levels[${index}].distance は有限である必要があります`);
    }
    if (index === 0) {
      if (level.distance !== 0) {
        throw new Error(`levels[0].distance は 0 である必要があります: ${level.distance}`);
      }
    } else if (!(level.distance > levels[index - 1].distance)) {
      throw new Error(
        `levels の distance は昇順（狭義単調増加）である必要があります: levels[${index - 1}]=${levels[index - 1].distance}, levels[${index}]=${level.distance}`,
      );
    }
  }
  const thresholds = levels.map((level) => level.distance);
  // ADR: 先頭バンド（i=0）は T[0]=0 のため T[0]*(1+h)=0 < T[1]*(1-h) が常に成り立ち、
  // 検証しても意味がないため i=1 から始める。仕様の「i=1..n-2」通りである。
  for (let i = 1; i < thresholds.length - 1; i++) {
    if (!(thresholds[i] * (1 + hysteresis) < thresholds[i + 1] * (1 - hysteresis))) {
      throw new Error(
        `ヒステリシスバンドが重なっています: T[${i}]=${thresholds[i]}, T[${i + 1}]=${thresholds[i + 1]}, h=${hysteresis}`,
      );
    }
  }
  const referenceSlots = Object.keys(levels[0].textures).sort();
  if (referenceSlots.length === 0) {
    throw new Error('levels[0].textures が空です。LOD対象スロットを1件以上指定してください');
  }
  for (const [index, level] of levels.entries()) {
    const slotNames = Object.keys(level.textures).sort();
    const same =
      slotNames.length === referenceSlots.length &&
      slotNames.every((name, i) => name === referenceSlots[i]);
    if (!same) {
      throw new Error(
        `全レベルでテクスチャスロット集合が一致している必要があります: levels[0]=[${referenceSlots.join(',')}], levels[${index}]=[${slotNames.join(',')}]`,
      );
    }
    for (const name of slotNames) {
      const value = (level.textures as Partial<Record<string, unknown>>)[name];
      if (!isTexture(value)) {
        throw new Error(`levels[${index}].textures.${name} は Texture である必要があります`);
      }
    }
  }
}

/**
 * バリアント上のテクスチャ値プロパティ名を集める。
 *
 * ADR: `NodeMaterial` のテクスチャスロットは prototype 上のアクセサとして定義され、
 * `Object.keys` や `for-in` の列挙に出ない（non-enumerable）。そのためオブジェクト自身と
 * プロトタイプチェーン（`Object.prototype` を除く）を `Object.getOwnPropertyNames` で走査し、
 * getter／データプロパティの値を読んで `isTexture` のものだけを対象にする。重複は `Set` で除く。
 * 値importなしの方針のため `instanceof` は使わず、`isTexture === true` のダックタイピングで判定する。
 * getter の読み取りで例外が出るものは対象外として読み飛ばす。
 */
function texturePropertyNames(material: Material): string[] {
  const candidates = new Set<string>();
  let current: unknown = material;
  while (current !== null && current !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(current)) {
      candidates.add(name);
    }
    current = Object.getPrototypeOf(current);
  }
  const record = material as unknown as Record<string, unknown>;
  const result: string[] = [];
  for (const name of candidates) {
    let value: unknown;
    try {
      value = record[name];
    } catch {
      continue;
    }
    if (isTexture(value)) {
      result.push(name);
    }
  }
  return result;
}

/** ベクトル様（offset/repeat）の等価判定。 */
function vec2Equals(a: { readonly x: number; readonly y: number }, b: { readonly x: number; readonly y: number }): boolean {
  return a.x === b.x && a.y === b.y;
}

/**
 * 全スロットのTextureが同一オブジェクトかを比べる。
 *
 * ADR: `levels` のスロット集合一致は検証済みのため、`slots` の全キーが `===` で
 * 一致すれば同一内容とみなす。値importなしの方針のため `instanceof` は使わない。
 */
function texturesEqual(
  a: Readonly<Partial<Record<string, unknown>>>,
  b: Readonly<Partial<Record<string, unknown>>>,
  slots: readonly string[],
): boolean {
  for (const slot of slots) {
    if (a[slot] !== b[slot]) {
      return false;
    }
  }
  return true;
}

/**
 * レベル間でずれているテクスチャ設定を警告する。
 *
 * フィルタ・ラッピング・色空間等がレベル間で異なると、LOD切替の瞬間に輝度・色・継ぎ目の段差として
 * 目立つうえ、GPU側で別形式の再アップロードが発生し得る。解像度以外の見え方は全レベルで統一するのが原則であり、
 * ずれは設定ミスの可能性が高いため `console.warn` で知らせる（処理は続行する）。
 */
function warnOnMismatchedSettings(
  levels: readonly {
    readonly textures: Readonly<Partial<Record<string, Texture>>>;
  }[],
): void {
  const slotNames = Object.keys(levels[0].textures);
  const reference = levels[0].textures as Partial<Record<string, Texture>>;
  for (const slot of slotNames) {
    const base = reference[slot];
    if (base === undefined) {
      continue;
    }
    const mismatched: string[] = [];
    for (let i = 1; i < levels.length; i++) {
      const other = (levels[i].textures as Partial<Record<string, Texture>>)[slot];
      if (other === undefined) {
        continue;
      }
      for (const prop of COMPARED_PROPS) {
        if (!Object.is(base[prop], other[prop])) {
          mismatched.push(`${prop}（levels[0]=${String(base[prop])}, levels[${i}]=${String(other[prop])}）`);
        }
      }
      const baseUv = base as Texture & {
        offset: { readonly x: number; readonly y: number };
        repeat: { readonly x: number; readonly y: number };
        rotation: number;
      };
      const otherUv = other as Texture & {
        offset: { readonly x: number; readonly y: number };
        repeat: { readonly x: number; readonly y: number };
        rotation: number;
      };
      if (!vec2Equals(baseUv.offset, otherUv.offset)) {
        mismatched.push(`offset（levels[0]=(${baseUv.offset.x},${baseUv.offset.y}), levels[${i}]=(${otherUv.offset.x},${otherUv.offset.y})）`);
      }
      if (!vec2Equals(baseUv.repeat, otherUv.repeat)) {
        mismatched.push(`repeat（levels[0]=(${baseUv.repeat.x},${baseUv.repeat.y}), levels[${i}]=(${otherUv.repeat.x},${otherUv.repeat.y})）`);
      }
      if (!Object.is(baseUv.rotation, otherUv.rotation)) {
        mismatched.push(`rotation（levels[0]=${baseUv.rotation}, levels[${i}]=${otherUv.rotation}）`);
      }
      // ADR: `wrapR` は3次元テクスチャ系にのみ存在するため、どちらかに存在するときだけ比べる。
      // 仕様の比較項目を落とさず、2次元テクスチャの通常利用では誤検知しないための措置である。
      // `as` は値importなしで任意プロパティへ触れるための手段である。
      const baseWrapR = (base as unknown as { wrapR?: unknown }).wrapR;
      const otherWrapR = (other as unknown as { wrapR?: unknown }).wrapR;
      if (('wrapR' in base || 'wrapR' in other) && !Object.is(baseWrapR, otherWrapR)) {
        mismatched.push(`wrapR（levels[0]=${String(baseWrapR)}, levels[${i}]=${String(otherWrapR)}）`);
      }
    }
    if (mismatched.length > 0) {
      const unique = [...new Set(mismatched)];
      console.warn(
        `[three-texture-lod] スロット "${slot}" のテクスチャ設定がレベル間でずれています: ${unique.join('; ')}。` +
          '解像度以外の見え方は全レベルで統一してください。ずれがあるとLOD切替時に輝度・色・継ぎ目の段差として目立ちます。',
      );
    }
  }
}

/**
 * 1メッシュ分のLOD定義。レベルごとに事前生成したマテリアルバリアントを保持する。
 *
 * バリアント方式の理由: 実測で、テクスチャ解像度を変えても描画パイプラインは再生成されず、
 * バリアント間で1本のパイプラインを共有できることを確認済みである。
 * そのため実行時の差し替えは `mesh.material` への代入だけで済み、シェーダ再コンパイルは起きない。
 *
 * @typeParam M - 対象マテリアルの型。
 */
export class TextureLodSet<M extends Material = Material> {
  /** 複製元マテリアル。生成後に変更されることはない。 */
  readonly baseMaterial: M;
  /** レベル定義。 */
  readonly levels: readonly TextureLodLevel<M>[];
  /** ヒステリシス幅。レベル定義とバンドは不可分であり、マネージャではなくsetが保持する。 */
  readonly hysteresis: number;
  /** `levels` から導出した境界配列。`thresholds[i]` はレベル `i` の開始距離。 */
  readonly thresholds: readonly number[];
  /**
   * グループごとの実体マテリアル。添字は生成順（先頭レベル番号の昇順）である。
   *
   * ADR: 全スロットのTextureが同一（`===`）のレベルは同じマテリアルを共有する。
   * 持たないTierを最大テクスチャの繰り返しで補う想定のため、重複バリアントを作ると
   * 切替・常駐・描画状態が増えるだけで見え方は変わらない。共有により実体を減らす。
   */
  private readonly groupMaterials: M[];
  /** レベル番号からグループ添字への写像。`variant()` の解決に使う。 */
  private readonly groupIndexOfLevel: readonly number[];
  /** レベル番号から属するグループの先頭レベル番号への写像。 */
  private readonly canonicalOfLevel: readonly number[];
  /** 実行時のスロット名一覧。`Object.keys` で採取した文字列として保持する。 */
  private readonly slots: readonly string[];

  /**
   * @param options - 生成オプション（検証・バリアント生成を即時に行う）。
   * @throws `Error` — レベル定義・ヒステリシス・スロット集合の検証に失敗した場合。
   * @throws `Error` — スロット名がマテリアルに存在しない場合。
   * @throws `Error` — `createVariant` の戻り値が base と同一、またはマテリアルでない場合。
   */
  constructor(options: TextureLodSetOptions<M>) {
    const hysteresis = options.hysteresis ?? 0.1;
    validateLevels(options.levels, hysteresis);
    warnOnMismatchedSettings(options.levels);
    this.baseMaterial = options.material;
    this.levels = options.levels;
    this.hysteresis = hysteresis;
    this.thresholds = options.levels.map((level) => level.distance);
    this.slots = Object.keys(options.levels[0].textures);
    // ADR: 未知のスロット名は代入も退避・復元も無言で捨てられ、LODが効いていないことに気づけない。
    // 生成時に存在確認して失敗させる。`in` はプロトタイプも見るため、
    // アクセサで定義された NodeMaterial 系のスロットも通る。
    for (const slot of this.slots) {
      if (!(slot in options.material)) {
        throw new Error(`マテリアルにスロット "${slot}" が存在しません`);
      }
    }
    // ADR: バリアント生成はコンストラクタ内で即時に行う。
    // 遅延生成にすると初回切替フレームで clone・コンパイルが走りスパイクになるため、
    // 登録時に前倒しで確保する。メモリと立上りコストのトレードオフは前者を選ぶ。
    // ADR: 同一内容（全スロットのTextureが `===`）のレベルはグループ化し、実体を1つだけ作る。
    // 比較は先頭出現順に行い、グループの代表は先頭レベルとする。非連続の一致も同一グループに
    // まとめ、名前と `canonicalLevel` は最小・最大で表す。実運用では末尾の繰り返しを想定する。
    const groups: { start: number; end: number }[] = [];
    const groupIndexOfLevel: number[] = new Array<number>(options.levels.length);
    for (let i = 0; i < options.levels.length; i++) {
      let found = -1;
      for (let g = 0; g < groups.length; g++) {
        if (texturesEqual(options.levels[groups[g].start].textures, options.levels[i].textures, this.slots)) {
          found = g;
          break;
        }
      }
      if (found >= 0) {
        groupIndexOfLevel[i] = found;
        groups[found].end = i;
      } else {
        groupIndexOfLevel[i] = groups.length;
        groups.push({ start: i, end: i });
      }
    }
    this.groupIndexOfLevel = groupIndexOfLevel;
    this.canonicalOfLevel = groupIndexOfLevel.map((g) => groups[g].start);
    this.groupMaterials = groups.map((group) => {
      if (options.createVariant !== undefined) {
        const created = options.createVariant(
          options.material,
          options.levels[group.start],
          group.start,
        );
        // ADR: フックの戻り値が base と同一だと全レベルが同一マテリアルになり、
        // マテリアルでなければ `variant()` の呼び出し側が壊れる。生成時に失敗させる。
        // `instanceof` ではなく `isMaterial` で判定するのは、値importなしの方針のためである。
        // 検証はグループごと（先頭レベル番号で1回）に行い、共有後の重複呼び出しはしない。
        if (created === options.material || (created as unknown as { isMaterial?: unknown }).isMaterial !== true) {
          throw new Error(`createVariant は base とは別のマテリアルを返す必要があります（レベル ${group.start}）`);
        }
        return created;
      }
      const variant = options.material.clone();
      const target = slotsOf(variant);
      const textures = options.levels[group.start].textures as Readonly<Partial<Record<string, Texture>>>;
      for (const slot of this.slots) {
        const texture = textures[slot];
        // ADR: 検証済みのため `undefined` は来ないはずだが、型上は任意キー読みで
        // `undefined` になり得る。無言の代入でスロットを壊さないよう弾く。
        if (texture !== undefined) {
          target[slot] = texture;
        }
      }
      const baseName = options.material.name !== '' ? options.material.name : 'material';
      variant.name =
        group.start === group.end
          ? `${baseName}#lod${group.start}`
          : `${baseName}#lod${group.start}-${group.end}`;
      return variant;
    });
  }

  /**
   * レベル番号に対応するマテリアルバリアントを返す。
   *
   * 同じTexture集合のレベルは同じマテリアルを共有する。
   * 持たないTierを最大テクスチャの繰り返しで補う想定のため、
   * 見え方が変わらない重複バリアントを作らないための措置である。
   *
   * @param level - レベル番号。`0 <= level < levels.length`。
   * @returns そのレベルのマテリアル（内部保持の実体であり、複製ではない）。
   * 同一内容のレベルでは同じ実体を返す。
   * @throws `RangeError` — `level` が範囲外の場合。
   */
  variant(level: number): M {
    if (!Number.isInteger(level) || level < 0 || level >= this.levels.length) {
      throw new RangeError(`level は 0 以上 ${this.levels.length} 未満である必要があります: ${level}`);
    }
    return this.groupMaterials[this.groupIndexOfLevel[level] as number];
  }

  /**
   * そのレベルが属するグループの先頭レベル番号を返す。
   *
   * 同じTexture集合のレベルは同じマテリアルを共有するため、
   * `variant(level)` は `variant(canonicalLevel(level))` と同じ実体になる。
   *
   * @param level - レベル番号。`0 <= level < levels.length`。
   * @returns 属するグループの先頭レベル番号。
   * @throws `RangeError` — `level` が範囲外の場合。
   */
  canonicalLevel(level: number): number {
    if (!Number.isInteger(level) || level < 0 || level >= this.levels.length) {
      throw new RangeError(`level は 0 以上 ${this.levels.length} 未満である必要があります: ${level}`);
    }
    return this.canonicalOfLevel[level] as number;
  }

  /**
   * LOD対象スロット以外の設定を `baseMaterial` から全バリアントへ反映し直す。
   *
   * 各バリアントのテクスチャ値を退避して null にし、`variant.copy(base)` で取り込んだ後に復元する。
   * 色・ラフネス等の後付け調整をバリアントへ波及させるための手段である。
   * 正常終了時のみ `needsUpdate = true` によりシェーダの再ビルドが走る。
   * 同一内容のレベルはマテリアルを共有するため、ユニークな実体ごとに1回だけ行う。
   *
   * @remarks
   * `createVariant` で独自ノードを組んだバリアントも `base` の内容で上書きするため、
   * フック利用時はこの呼び出しでカスタム分が消えることに注意する。
   * 取り込みに失敗した場合は例外をそのまま投げ、`needsUpdate` は変えず、
   * 名前とテクスチャ値は退避値へ戻す。
   */
  syncFromBase(): void {
    for (const v of this.groupMaterials) {
      const record = v as unknown as Record<string, unknown>;
      const baseRecord = this.baseMaterial as unknown as Record<string, unknown>;
      // ADR: three r187 の NodeMaterial.copy は、コピー先の値が真で `.copy` を持つ全プロパティに
      // `this[p].copy(source[p])` と深いコピーを呼ぶ。LOD対象外（normalMap 等）も含めて
      // バリアント上のテクスチャ値をすべて一旦 null にし、通常代入の経路に逃がす。
      // こうしないと、base と共有する Texture への自己 copy で `version` が上がって毎回再アップロードされたり、
      // base 側の差し替えで旧テクスチャの中身が上書き（利用者のテクスチャ破壊）されたり、
      // base 側が null だと `copy(null)` で例外になる。
      // classic Material の `copy` は単なる代入のため、この手順でも挙動は変わらない。
      const lodTextureProps = texturePropertyNames(v);
      const nullTargets = new Set<string>([...lodTextureProps, ...this.slots]);
      const stashed = new Map<string, unknown>();
      for (const prop of nullTargets) {
        try {
          stashed.set(prop, record[prop]);
        } catch {
          stashed.set(prop, undefined);
        }
        try {
          record[prop] = null;
        } catch {
          // 読み取り専用アクセサ等はここでは無視し、copy 側の挙動に任せる。
        }
      }
      const name = v.name;
      let succeeded = false;
      try {
        v.copy(this.baseMaterial);
        succeeded = true;
      } finally {
        // ADR: copy の成否にかかわらず名前と LOD スロットは必ず復元する。
        // バリアント名の `#lod<i>` 接尾辞はデバッグ時の識別子であり、維持する。
        // 個別代入は try-catch で包み、1件の失敗で後続の復元が止まらないようにする。
        // LOD スロットは常に退避値へ戻す。LOD対象外は、成功時は base に存在するものだけ
        // copy 結果（null 含む）を採用し、base に存在しないものは退避値へ戻す。
        // 失敗時は null のまま残ったものだけ退避値へ戻し、部分適用の痕跡を残さない。
        for (const slot of this.slots) {
          if (stashed.has(slot)) {
            try {
              record[slot] = stashed.get(slot);
            } catch {
              // 復元できない場合はそのままとし、後続の復元を続ける。
            }
          }
        }
        if (succeeded) {
          for (const prop of lodTextureProps) {
            if (this.slots.includes(prop)) {
              continue;
            }
            let hasBase = false;
            try {
              hasBase = baseRecord[prop] !== undefined;
            } catch {
              hasBase = true;
            }
            if (!hasBase) {
              try {
                record[prop] = stashed.get(prop);
              } catch {
                // 復元できない場合はそのままとし、後続の復元を続ける。
              }
            }
          }
        } else {
          for (const prop of nullTargets) {
            if (this.slots.includes(prop)) {
              continue;
            }
            let current: unknown;
            try {
              current = record[prop];
            } catch {
              continue;
            }
            if (current === null) {
              try {
                record[prop] = stashed.get(prop);
              } catch {
                // 復元できない場合はそのままとし、後続の復元を続ける。
              }
            }
          }
        }
        try {
          v.name = name;
        } catch {
          // 名前の復元に失敗しても例外は元のまま伝える。
        }
        if (succeeded) {
          v.needsUpdate = true;
        }
      }
    }
  }

  /**
   * バリアントのマテリアルを破棄する。テクスチャは破棄しない。
   *
   * 同一内容のレベルはマテリアルを共有するため、ユニークな実体ごとに1回だけ破棄する。
   * テクスチャの寿命はマネージャの常駐管理または利用者が持つ。
   */
  dispose(): void {
    for (const v of this.groupMaterials) {
      v.dispose();
    }
  }
}

/**
 * {@link TextureLodSet} を生成する。
 *
 * @param options - 生成オプション。
 * @returns 検証済み・バリアント生成済みのセット。
 * @throws `Error` — レベル定義・ヒステリシス・スロット集合の検証に失敗した場合。
 * @throws `Error` — スロット名がマテリアルに存在しない場合。
 * @throws `Error` — `createVariant` の戻り値が base と同一、またはマテリアルでない場合。
 */
export function createTextureLodSet<M extends Material>(options: TextureLodSetOptions<M>): TextureLodSet<M> {
  return new TextureLodSet(options);
}
