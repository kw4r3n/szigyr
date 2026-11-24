const N: usize = 16000000;
const RUNS: usize = 7;

fn lcg(x: u32) -> u32 {
    x.wrapping_mul(1664525).wrapping_add(1013904223)
}

fn sym_char(r: u32) -> u8 {
    match r {
        0 => 43, 1 => 45, 2 => 42, 3 => 47, 4 => 61, 5 => 59,
        6 => 40, 7 => 41, 8 => 123, 9 => 125, 10 => 60, 11 => 62,
        _ => 33,
    }
}

fn gen_input(n: usize) -> Vec<u8> {
    let mut v: Vec<u8> = Vec::with_capacity(n + 32);
    let mut x: u32 = 12345;
    while v.len() < n {
        if !v.is_empty() { v.push(32); }
        x = lcg(x);
        let k = (x >> 16) % 10;
        if k < 5 {
            x = lcg(x);
            let len = 1 + (x >> 16) % 8;
            for q in 0..len {
                x = lcg(x);
                if q == 0 {
                    let r = (x >> 16) % 27;
                    v.push(if r < 26 { (97 + r) as u8 } else { 95 });
                } else {
                    let r = (x >> 16) % 37;
                    v.push(if r < 26 { (97 + r) as u8 } else if r < 36 { (48 + (r - 26)) as u8 } else { 95 });
                }
            }
        } else if k < 8 {
            x = lcg(x);
            let len = 1 + (x >> 16) % 6;
            for _ in 0..len {
                x = lcg(x);
                v.push((48 + (x >> 16) % 10) as u8);
            }
        } else {
            x = lcg(x);
            let r = (x >> 16) % 17;
            if r < 13 {
                v.push(sym_char(r));
            } else {
                let t = r - 13;
                v.push(match t { 0 => 62, 1 => 60, 2 => 61, _ => 33 });
                v.push(61);
            }
        }
    }
    v
}

fn fold(a: u32, b: u32, c: u32, s: u32) -> u32 {
    let mut h: u32 = 2166136261;
    for v in [a, b, c, s] { h = (h ^ v).wrapping_mul(16777619); }
    h
}

#[derive(Clone, Copy)]
struct Tok { kind: u8, start: u32, end: u32 }

fn is_id_start(c: u8) -> bool { (c >= 97 && c <= 122) || c == 95 }
fn is_digit(c: u8) -> bool { c >= 48 && c <= 57 }

fn tokenize(bytes: &[u8]) -> Vec<Tok> {
    let mut out: Vec<Tok> = Vec::with_capacity(1024);
    let n = bytes.len();
    let mut i = 0usize;
    while i < n {
        let c = bytes[i];
        if c == 32 {
            i += 1;
        } else if is_id_start(c) {
            let mut j = i + 1;
            while j < n && (is_id_start(bytes[j]) || is_digit(bytes[j])) { j += 1; }
            out.push(Tok { kind: 0, start: i as u32, end: j as u32 });
            i = j;
        } else if is_digit(c) {
            let mut j = i + 1;
            while j < n && is_digit(bytes[j]) { j += 1; }
            out.push(Tok { kind: 1, start: i as u32, end: j as u32 });
            i = j;
        } else {
            let mut j = i + 1;
            if (c == 62 || c == 60 || c == 61 || c == 33) && j < n && bytes[j] == 61 { j += 1; }
            out.push(Tok { kind: 2, start: i as u32, end: j as u32 });
            i = j;
        }
    }
    out
}

fn summarize(bytes: &[u8], toks: &Vec<Tok>) -> (u32, u32, u32, u32) {
    let (mut a, mut b, mut s, mut sum) = (0u32, 0u32, 0u32, 0u32);
    for k in 0..toks.len() {
        let t = toks[k];
        if t.kind == 0 { a += 1; }
        else if t.kind == 1 {
            b += 1;
            let mut val: u32 = 0;
            for p in (t.start as usize)..(t.end as usize) {
                val = val.wrapping_mul(10).wrapping_add(bytes[p] as u32 - 48);
            }
            sum = sum.wrapping_add(val);
        } else { s += 1; }
    }
    (a, b, s, sum)
}

fn main() {
    use std::hint::black_box;
    let bytes = gen_input(N);
    let mut times: Vec<f64> = Vec::new();
    let mut checksum = 0u32;
    for _ in 0..RUNS {
        let t0 = std::time::Instant::now();
        let toks = tokenize(black_box(&bytes));
        let (a, b, s, sum) = summarize(black_box(&bytes), black_box(&toks));
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        black_box((&toks, a, b, s, sum));
        times.push(ms);
        checksum = fold(a, b, s, sum);
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!("task=t1 variant=rust-same n={} checksum={} best_ms={:.3} median_ms={:.3}", N, checksum, times[0], times[RUNS / 2]);
}
