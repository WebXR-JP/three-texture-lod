/**
 * Origin Private File System（OPFS）を退避先にする {@link TexturePixelStore}。
 *
 * @packageDocumentation
 */
import type { TexturePixelStore } from './texture-spill-cache.js';

/**
 * OPFS 上にこのページ専用の退避ディレクトリを作り、ストアとして返す。
 *
 * ディレクトリは `<directoryName>/<ランダムなセッションID>` に作り、1キーを1ファイルに書く。
 * 開くときに、閉じたページが残したセッションディレクトリを削除する。
 *
 * @param directoryName - OPFS 直下に作る親ディレクトリ名。同じオリジンの別用途と重ならない名前にする。
 * 省略時は `'three-texture-lod'`。
 * @returns 書き込み・読み出しに使えるストア。
 * @throws `Promise` の拒否 — OPFS または Web Locks API を使えない環境（非セキュアコンテキスト等）の場合。
 * @remarks
 * 使用中のセッションは Web Locks のロックで示す。ロックはページが閉じるまで保持するため、
 * 同じページで複数回呼ぶとセッションディレクトリが呼び出し回数分残る。ページごとに1回だけ呼ぶこと。
 */
export async function openOpfsPixelStore(
  directoryName = 'three-texture-lod',
): Promise<TexturePixelStore> {
  const root = await navigator.storage.getDirectory();
  const parent = await root.getDirectoryHandle(directoryName, { create: true });
  const sessionId = crypto.randomUUID();
  // ADR: セッションディレクトリは必ずロック取得後に作る。掃除側は「一覧→ロック照会」の順で
  // 調べるため、一覧に載ったディレクトリの持ち主は照会時点で必ずロックを持っている。
  await holdLock(lockNameOf(directoryName, sessionId));
  await removeStaleSessions(parent, directoryName);
  const directory = await parent.getDirectoryHandle(sessionId, { create: true });
  return {
    async write(key, bytes) {
      const handle = await directory.getFileHandle(key, { create: true });
      const writable = await handle.createWritable();
      try {
        await writable.write(bytes);
        await writable.close();
      } catch (error) {
        // 途中まで書いた一時ファイルを残さないよう破棄してから失敗を伝える。
        await writable.abort();
        throw error;
      }
    },
    async read(key) {
      const handle = await directory.getFileHandle(key);
      const file = await handle.getFile();
      return file.arrayBuffer();
    },
  };
}

function lockNameOf(directoryName: string, sessionId: string): string {
  return `${directoryName}/${sessionId}`;
}

/** ロックを取得し、ページが閉じるまで保持する。取得できた時点で解決する。 */
function holdLock(name: string): Promise<void> {
  return new Promise((acquired) => {
    void navigator.locks.request(name, () => {
      acquired();
      return new Promise<never>(() => {});
    });
  });
}

/** ロックを持つページがないセッションディレクトリを削除する。 */
async function removeStaleSessions(
  parent: FileSystemDirectoryHandle,
  directoryName: string,
): Promise<void> {
  const names: string[] = [];
  for await (const name of parent.keys()) {
    names.push(name);
  }
  const snapshot = await navigator.locks.query();
  const active = new Set((snapshot.held ?? []).map((lock) => lock.name));
  for (const name of names) {
    if (active.has(lockNameOf(directoryName, name))) {
      continue;
    }
    try {
      await parent.removeEntry(name, { recursive: true });
    } catch (error) {
      // 同時に開いた別ページが先に消した場合は目的を果たしているため無視する。
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) {
        throw error;
      }
    }
  }
}
