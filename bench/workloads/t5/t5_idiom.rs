use std::hint::black_box;
use std::time::Instant;

const N: usize = 4000000;
const RUNS: usize = 7;

#[derive(Clone, Copy)]
struct Ev { time: u32, kind: u8, value: i32 }

fn lcg(x: u32) -> u32 { x.wrapping_mul(1664525).wrapping_add(1013904223) }

fn gen(n: usize, seed: u32) -> Vec<Ev> {
    let mut x = seed;
    let mut t = 0u32;
    (0..n)
        .map(|_| {
            x = lcg(x);
            t += x >> 30;
            x = lcg(x);
            let kind = ((x >> 24) % 3) as u8;
            x = lcg(x);
            Ev { time: t, kind, value: (x >> 16) as i32 - 32768 }
        })
        .collect()
}

fn merge(a: &[Ev], b: &[Ev]) -> Vec<Ev> {
    let mut out = Vec::with_capacity(a.len() + b.len());
    let mut ia = a.iter().peekable();
    let mut ib = b.iter().peekable();
    loop {
        match (ia.peek(), ib.peek()) {
            (Some(x), Some(y)) => {
                if y.time < x.time { out.push(*ib.next().unwrap()); } else { out.push(*ia.next().unwrap()); }
            }
            (Some(_), None) => { out.extend(ia.copied()); break; }
            (None, Some(_)) => { out.extend(ib.copied()); break; }
            (None, None) => break,
        }
    }
    out
}

fn simulate(m: &[Ev]) -> u32 {
    let (mut active, mut max_active, mut cc) = (0u32, 0u32, 0i64);
    for e in m {
        match e.kind {
            0 => { active += 1; max_active = max_active.max(active); }
            1 => active = active.saturating_sub(1),
            _ => cc += e.value as i64,
        }
    }
    [m.len() as u32, max_active, (cc & 0xFFFF_FFFF) as u32]
        .iter()
        .fold(17u32, |h, &v| h.wrapping_mul(31).wrapping_add(v))
}

fn main() {
    let skipped = (0..N * 3).fold(12345u32, |x, _| lcg(x));
    let a = gen(N, 12345);
    let b = gen(N, skipped);
    let mut times = Vec::new();
    let mut sum = 0u32;
    for _ in 0..RUNS {
        let t0 = Instant::now();
        let m = merge(black_box(&a), black_box(&b));
        sum = black_box(simulate(&m));
        times.push(t0.elapsed().as_secs_f64() * 1000.0);
    }
    times.sort_by(|x, y| x.partial_cmp(y).unwrap());
    println!("task=t5 variant=rust-idiom n={} checksum={} best_ms={:.3} median_ms={:.3}", N, sum, times[0], times[3]);
}
