use std::hint::black_box;
use std::time::Instant;
const VOCAB: u32 = 200000;
const N_DEFAULT: usize = 4000000;
fn lcg(x: u32) -> u32 { x.wrapping_mul(1664525).wrapping_add(1013904223) }
fn build(n: usize) -> Vec<u8> {
    let mut buf: Vec<u8> = Vec::with_capacity(n * 9);
    let mut x: u32 = 12345;
    for i in 0..n {
        x = lcg(x);
        let mut id = (x >> 14) % VOCAB;
        x = lcg(x);
        let b = (x >> 14) % VOCAB;
        if b < id { id = b; }
        x = lcg(x);
        let c = (x >> 14) % VOCAB;
        if c < id { id = c; }
        let mut s = id.wrapping_mul(2654435761).wrapping_add(12345);
        s = lcg(s);
        let len = 1 + (s >> 29);
        if i > 0 { buf.push(32); }
        for _ in 0..len {
            s = lcg(s);
            buf.push((97 + (s >> 16) % 26) as u8);
        }
    }
    buf
}
fn fold(out: &[u32; 7]) -> u32 {
    let mut h: u32 = 0;
    for &v in out.iter() { h = h.wrapping_mul(16777619).wrapping_add(v); }
    h
}
fn report(variant: &str, n: usize, sum: u32, times: &mut Vec<f64>) {
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!("task=t2 variant={} n={} checksum={} best_ms={} median_ms={}", variant, n, sum, times[0], times[3]);
}
fn top3_insert(t: &mut [(u32, u32); 3], c: u32, o: u32) {
    for k in 0..3 {
        if c > t[k].0 || (c == t[k].0 && o < t[k].1) {
            for j in (k + 1..3).rev() { t[j] = t[j - 1]; }
            t[k] = (c, o);
            return;
        }
    }
}
use std::collections::HashMap;
fn count_words(buf: &[u8]) -> [u32; 7] {
    let mut map: HashMap<&[u8], (u32, u32)> = HashMap::new();
    let mut pos: usize = 0;
    for w in buf.split(|&b| b == b' ') {
        let e = map.entry(w).or_insert((pos as u32, 0));
        e.1 += 1;
        pos += w.len() + 1;
    }
    let mut t = [(0u32, 0u32); 3];
    for &(o, c) in map.values() { top3_insert(&mut t, c, o); }
    [map.len() as u32, t[0].0, t[0].1, t[1].0, t[1].1, t[2].0, t[2].1]
}
fn main() {
    let n: usize = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(N_DEFAULT);
    let buf = build(n);
    let mut out = [0u32; 7];
    let mut times: Vec<f64> = Vec::new();
    for _ in 0..7 {
        let t0 = Instant::now();
        out = count_words(black_box(&buf));
        black_box(&out);
        times.push(t0.elapsed().as_secs_f64() * 1000.0);
    }
    report("rust-idiom", n, fold(&out), &mut times);
}
