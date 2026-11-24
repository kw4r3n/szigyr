use std::hint::black_box;
use std::time::Instant;

const N: usize = 4000000;
const RUNS: usize = 7;

#[derive(Clone, Copy)]
struct Ev { time: u32, kind: u8, value: i32 }

fn lcg(x: u32) -> u32 { x.wrapping_mul(1664525).wrapping_add(1013904223) }

fn skip(seed: u32, steps: usize) -> u32 {
    let mut x = seed;
    for _ in 0..steps { x = lcg(x); }
    x
}

fn gen(n: usize, seed: u32) -> Vec<Ev> {
    let mut v = Vec::with_capacity(n);
    let mut x = seed;
    let mut t: u32 = 0;
    for _ in 0..n {
        x = lcg(x);
        t += x >> 30;
        x = lcg(x);
        let kind = ((x >> 24) % 3) as u8;
        x = lcg(x);
        let value = (x >> 16) as i32 - 32768;
        v.push(Ev { time: t, kind, value });
    }
    v
}

fn merge(a: &[Ev], b: &[Ev]) -> Vec<Ev> {
    let mut out = Vec::with_capacity(a.len() + b.len());
    let mut i = 0;
    let mut j = 0;
    while i < a.len() && j < b.len() {
        if b[j].time < a[i].time { out.push(b[j]); j += 1; } else { out.push(a[i]); i += 1; }
    }
    while i < a.len() { out.push(a[i]); i += 1; }
    while j < b.len() { out.push(b[j]); j += 1; }
    out
}

fn simulate(m: &[Ev]) -> u32 {
    let mut active: u32 = 0;
    let mut max_active: u32 = 0;
    let mut cc: i64 = 0;
    for i in 0..m.len() {
        let e = m[i];
        if e.kind == 0 {
            active += 1;
            if active > max_active { max_active = active; }
        } else if e.kind == 1 {
            if active > 0 { active -= 1; }
        } else {
            cc += e.value as i64;
        }
    }
    let mut h: u32 = 17;
    h = h.wrapping_mul(31).wrapping_add(m.len() as u32);
    h = h.wrapping_mul(31).wrapping_add(max_active);
    h = h.wrapping_mul(31).wrapping_add((cc & 4294967295) as u32);
    h
}

fn run_core(a: &[Ev], b: &[Ev]) -> u32 {
    let m = merge(a, b);
    simulate(&m)
}

fn main() {
    let a = gen(N, 12345);
    let b = gen(N, skip(12345, N * 3));
    let mut times = Vec::new();
    let mut sum = 0u32;
    for _ in 0..RUNS {
        let t0 = Instant::now();
        sum = black_box(run_core(black_box(&a), black_box(&b)));
        times.push(t0.elapsed().as_secs_f64() * 1000.0);
    }
    times.sort_by(|x, y| x.partial_cmp(y).unwrap());
    println!("task=t5 variant=rust-same n={} checksum={} best_ms={:.3} median_ms={:.3}", N, sum, times[0], times[3]);
}
