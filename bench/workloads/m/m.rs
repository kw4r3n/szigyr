use std::hint::black_box;
use std::time::Instant;
fn line(name: &str, n: u64, ms: f64, chk: u64) {
    println!("micro={} backend=rust n={} total_ms={:.3} per_op_ns={:.3} chk={}", name, n, ms, ms * 1e6 / n as f64, chk);
}
fn main() {
    let t = Instant::now();
    let mut sum: u32 = 0;
    for i in 0..black_box(1_000_000u32) {
        let mut v: Vec<u32> = Vec::with_capacity(16);
        for j in 0..16u32 { v.push(i.wrapping_add(j)); }
        for x in &v { sum = sum.wrapping_add(*x); }
        black_box(&v);
    }
    line("alloc_small", 1_000_000, t.elapsed().as_secs_f64() * 1e3, black_box(sum) as u64);
    let t = Instant::now();
    let mut v: Vec<u32> = Vec::with_capacity(16);
    for i in 0..black_box(20_000_000u32) { v.push(i); }
    let r = v[v.len() - 1].wrapping_add(v.len() as u32);
    line("push_grow", 20_000_000, t.elapsed().as_secs_f64() * 1e3, black_box(r) as u64);
    let small: Vec<f32> = (0..16u32).map(|i| (i % 7) as f32).collect();
    let t = Instant::now();
    let mut f = 0f64;
    for _ in 0..1_000_000 { f += black_box(&small[..])[0] as f64; }
    line("call_slice_small", 1_000_000, t.elapsed().as_secs_f64() * 1e3, black_box(f) as u64);
    let big: Vec<f32> = (0..4_000_000u32).map(|i| (i % 7) as f32).collect();
    let t = Instant::now();
    let mut f = 0f64;
    for _ in 0..200 { f += black_box(&big[..])[0] as f64; }
    line("call_slice_large", 200, t.elapsed().as_secs_f64() * 1e3, black_box(f) as u64);
}
