"use owned";

import { dot, gain } from "./kernel.ts";

export function energy(alloc: Alloc, n: usize): f32 {
  const v = Vec.create<f32>(alloc, n);
  for (let i: usize = 0; i < n; i += 1) {
    v.push(0.5);
  }
  return dot(v, v);
}

export function boosted(alloc: Alloc, n: usize, k: f32): f32 {
  const v = Vec.create<f32>(alloc, n);
  for (let i: usize = 0; i < n; i += 1) {
    v.push(1);
  }
  gain(v, k);
  return dot(v, v);
}
