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

#[derive(Clone, Copy, PartialEq)]
enum Kind { Ident, Number, Symbol }

#[derive(Clone, Copy)]
struct Token { kind: Kind, start: u32, end: u32 }

fn tokenize(bytes: &[u8]) -> Vec<Token> {
    let mut out = Vec::new();
    let mut it = bytes.iter().copied().enumerate().peekable();
    while let Some((i, c)) = it.next() {
        let mut end = i + 1;
        let kind = match c {
            b' ' => continue,
            b'a'..=b'z' | b'_' => {
                while let Some(&(j, d)) = it.peek() {
                    if d.is_ascii_lowercase() || d.is_ascii_digit() || d == b'_' { end = j + 1; it.next(); } else { break; }
                }
                Kind::Ident
            }
            b'0'..=b'9' => {
                while let Some(&(j, d)) = it.peek() {
                    if d.is_ascii_digit() { end = j + 1; it.next(); } else { break; }
                }
                Kind::Number
            }
            _ => {
                if matches!(c, b'>' | b'<' | b'=' | b'!') {
                    if let Some(&(j, b'=')) = it.peek() { end = j + 1; it.next(); }
                }
                Kind::Symbol
            }
        };
        out.push(Token { kind, start: i as u32, end: end as u32 });
    }
    out
}

fn summarize(bytes: &[u8], toks: &[Token]) -> (u32, u32, u32, u32) {
    let mut counts = [0u32; 3];
    let mut sum = 0u32;
    for t in toks {
        match t.kind {
            Kind::Ident => counts[0] += 1,
            Kind::Symbol => counts[2] += 1,
            Kind::Number => {
                counts[1] += 1;
                let v = bytes[t.start as usize..t.end as usize]
                    .iter()
                    .fold(0u32, |acc, &d| acc.wrapping_mul(10).wrapping_add((d - b'0') as u32));
                sum = sum.wrapping_add(v);
            }
        }
    }
    (counts[0], counts[1], counts[2], sum)
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
    println!("task=t1 variant=rust-idiom n={} checksum={} best_ms={:.3} median_ms={:.3}", N, checksum, times[0], times[RUNS / 2]);
}
