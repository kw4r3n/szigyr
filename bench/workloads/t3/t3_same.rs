use std::hint::black_box;
use std::time::Instant;

const N: usize = 800000;

fn gen_keys(n: usize) -> Vec<i32> {
    let mut v = Vec::with_capacity(n);
    let mut x: u32 = 12345;
    for _ in 0..n {
        x = x.wrapping_mul(1664525).wrapping_add(1013904223);
        v.push((x >> 1) as i32 - 1073741824);
    }
    v
}

fn core(keys: &[i32]) -> u32 {
    let n = keys.len();
    let mut left = vec![-1i32; n];
    let mut right = vec![-1i32; n];
    for i in 1..n {
        let k = keys[i];
        let mut cur = 0usize;
        loop {
            if k < keys[cur] {
                let l = left[cur];
                if l < 0 { left[cur] = i as i32; break; }
                cur = l as usize;
            } else {
                let r = right[cur];
                if r < 0 { right[cur] = i as i32; break; }
                cur = r as usize;
            }
        }
    }
    let mut nodes: Vec<u32> = Vec::with_capacity(64);
    let mut depths: Vec<u32> = Vec::with_capacity(64);
    let mut sum: i64 = 0;
    let mut levels: u32 = 0;
    if n > 0 { nodes.push(0); depths.push(0); }
    while !nodes.is_empty() {
        let nd = nodes.pop();
        let dp = depths.pop();
        if let (Some(nd), Some(dp)) = (nd, dp) {
            let node = nd as usize;
            if dp + 1 > levels { levels = dp + 1; }
            if dp % 2 == 0 { sum += keys[node] as i64; }
            let l = left[node];
            let r = right[node];
            if l >= 0 { nodes.push(l as u32); depths.push(dp + 1); }
            if r >= 0 { nodes.push(r as u32); depths.push(dp + 1); }
        }
    }
    let low = (sum & 4294967295) as u32;
    low ^ levels
}

fn main() {
    let keys = gen_keys(N);
    let mut times = Vec::new();
    let mut checksum = 0u32;
    for _ in 0..7 {
        let t0 = Instant::now();
        checksum = black_box(core(black_box(&keys)));
        times.push(t0.elapsed().as_secs_f64() * 1000.0);
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!("task=t3 variant=rust-same n={} checksum={} best_ms={:.3} median_ms={:.3}", N, checksum, times[0], times[3]);
}
