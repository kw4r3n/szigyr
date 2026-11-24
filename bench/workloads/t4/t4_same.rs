use std::hint::black_box;
use std::time::Instant;
const N: usize = 8000000;

fn gen(n: usize) -> (Vec<u32>, Vec<i32>) {
    let mut x: u32 = 12345;
    let mut keys = Vec::with_capacity(n);
    let mut vals = Vec::with_capacity(n);
    for _ in 0..n {
        x = x.wrapping_mul(1664525).wrapping_add(1013904223);
        let a = x >> 16;
        x = x.wrapping_mul(1664525).wrapping_add(1013904223);
        let b = x >> 16;
        x = x.wrapping_mul(1664525).wrapping_add(1013904223);
        let c = (x >> 8) % 2000001;
        keys.push((a * b) >> 16);
        vals.push(c as i32 - 1000000);
    }
    (keys, vals)
}

fn core(keys: &[u32], vals: &[i32]) -> u32 {
    let mut offs = vec![0u32; 65537];
    let mut cur = vec![0u32; 65536];
    let mut flat = vec![0i32; keys.len()];
    for i in 0..keys.len() {
        let k = keys[i] as usize + 1;
        offs[k] += 1;
    }
    for k in 1..offs.len() {
        offs[k] += offs[k - 1];
    }
    for k in 0..cur.len() {
        cur[k] = offs[k];
    }
    for i in 0..keys.len() {
        let k = keys[i] as usize;
        let p = cur[k];
        flat[p as usize] = vals[i];
        cur[k] = p + 1;
    }
    let mut h: u32 = 0;
    for k in 0..65536usize {
        let lo = offs[k] as usize;
        let hi = offs[k + 1] as usize;
        if hi > lo {
            let mut s: i64 = 0;
            for j in lo..hi {
                s += flat[j] as i64;
            }
            h = h.wrapping_mul(31).wrapping_add(k as u32);
            h = h.wrapping_mul(31).wrapping_add(s as u32);
            h = h.wrapping_mul(31).wrapping_add((hi - lo) as u32);
        }
    }
    h
}
fn main() {
    let (keys, vals) = gen(N);
    let mut times: Vec<f64> = Vec::new();
    let mut cs = 0u32;
    for _ in 0..7 {
        let t0 = Instant::now();
        cs = core(black_box(&keys), black_box(&vals));
        black_box(cs);
        times.push(t0.elapsed().as_secs_f64() * 1000.0);
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!("task=t4 variant=rust-same n={} checksum={} best_ms={} median_ms={}", N, cs, times[0], times[3]);
}

