/**
 * 一人称ロジック（視点と移動）の仕様テスト。three は使わず、
 * 座標系の向き・速度・範囲の契約だけを検証する。
 */
import { describe, expect, it } from 'vitest';
import {
  FIRST_PERSON_TUNING,
  applyLook,
  createFirstPersonState,
  stepFirstPerson,
  type FirstPersonInput,
} from './first-person.js';

/** 指定入力で十分な時間だけ進め、定常速度を測る。壁に届かない短時間で収束させる。 */
function settleSpeed(input: FirstPersonInput, yaw = 0): { vx: number; vz: number } {
  const state = createFirstPersonState(0, 0, yaw, 0);
  for (let i = 0; i < 120; i++) stepFirstPerson(state, 1 / 60, input);
  return { vx: state.vx, vz: state.vz };
}

describe('first-person', () => {
  it('初期状態は目線の高さで速度 0', () => {
    const state = createFirstPersonState(1, 2, 0.3, 0.1);
    expect(state.x).toBe(1);
    expect(state.z).toBe(2);
    expect(state.y).toBe(FIRST_PERSON_TUNING.eyeHeight);
    expect(state.vx).toBe(0);
    expect(state.vz).toBe(0);
  });

  it('W 前進で -z、S で +z へ進む', () => {
    const forward = createFirstPersonState(0, 0);
    stepFirstPerson(forward, 1, { forward: 1, right: 0, sprint: false });
    expect(forward.z).toBeLessThan(0);
    expect(forward.x).toBeCloseTo(0, 12);

    const back = createFirstPersonState(0, 0);
    stepFirstPerson(back, 1, { forward: -1, right: 0, sprint: false });
    expect(back.z).toBeGreaterThan(0);
  });

  it('yaw=π/2 では W で -x へ進む', () => {
    const state = createFirstPersonState(0, 0, Math.PI / 2, 0);
    stepFirstPerson(state, 1, { forward: 1, right: 0, sprint: false });
    expect(state.x).toBeLessThan(0);
    expect(state.z).toBeCloseTo(0, 9);
  });

  it('斜め入力でも定常速度は speed に一致する', () => {
    const straight = settleSpeed({ forward: 1, right: 0, sprint: false });
    expect(Math.hypot(straight.vx, straight.vz)).toBeCloseTo(FIRST_PERSON_TUNING.speed, 6);
    const diagonal = settleSpeed({ forward: 1, right: 1, sprint: false });
    expect(Math.hypot(diagonal.vx, diagonal.vz)).toBeCloseTo(FIRST_PERSON_TUNING.speed, 6);
  });

  it('Shift では sprintSpeed に近づく', () => {
    const speed = settleSpeed({ forward: 1, right: 0, sprint: true });
    expect(Math.hypot(speed.vx, speed.vz)).toBeCloseTo(FIRST_PERSON_TUNING.sprintSpeed, 6);
  });

  it('マウス右移動で yaw が減り、上移動で pitch が増える', () => {
    const state = createFirstPersonState(0, 0);
    applyLook(state, 100, 0);
    expect(state.yaw).toBeCloseTo(-100 * FIRST_PERSON_TUNING.mouseSensitivity, 12);
    applyLook(state, 0, -100);
    expect(state.pitch).toBeCloseTo(100 * FIRST_PERSON_TUNING.mouseSensitivity, 12);
  });

  it('pitch は ±maxPitch で止まる', () => {
    const up = createFirstPersonState(0, 0);
    applyLook(up, 0, -100000);
    expect(up.pitch).toBe(FIRST_PERSON_TUNING.maxPitch);
    const down = createFirstPersonState(0, 0);
    applyLook(down, 0, 100000);
    expect(down.pitch).toBe(-FIRST_PERSON_TUNING.maxPitch);
  });

  it('範囲外へ進まず、はみ出した軸の速度は 0 になる', () => {
    const east = createFirstPersonState(FIRST_PERSON_TUNING.maxX, 0, 0, 0);
    stepFirstPerson(east, 1, { forward: 0, right: 1, sprint: false });
    expect(east.x).toBe(FIRST_PERSON_TUNING.maxX);
    expect(east.vx).toBe(0);

    const north = createFirstPersonState(0, FIRST_PERSON_TUNING.minZ, 0, 0);
    stepFirstPerson(north, 1, { forward: 1, right: 0, sprint: true });
    expect(north.z).toBe(FIRST_PERSON_TUNING.minZ);
    expect(north.vz).toBe(0);
  });

  it('dt=0 では位置も速度も変わらない', () => {
    const state = createFirstPersonState(3, 4, 0.2, 0.1);
    stepFirstPerson(state, 0, { forward: 1, right: 1, sprint: true });
    expect(state.x).toBe(3);
    expect(state.z).toBe(4);
    expect(state.vx).toBe(0);
    expect(state.vz).toBe(0);
  });
});
