use std::hint::black_box;
use std::time::Instant;

const N: usize = 800000;

struct Node {
    key: i32,
    left: Option<Box<Node>>,
    right: Option<Box<Node>>,
}

fn gen_keys(n: usize) -> Vec<i32> {
    let mut x: u32 = 12345;
    (0..n)
        .map(|_| {
            x = x.wrapping_mul(1664525).wrapping_add(1013904223);
            (x >> 1) as i32 - 1073741824
        })
        .collect()
}

fn insert(root: &mut Option<Box<Node>>, key: i32) {
    let mut cur = root;
    while let Some(node) = cur {
        cur = if key < node.key { &mut node.left } else { &mut node.right };
    }
    *cur = Some(Box::new(Node { key, left: None, right: None }));
}

fn core(keys: &[i32]) -> u32 {
    let mut root: Option<Box<Node>> = None;
    for &k in keys {
        insert(&mut root, k);
    }
    let mut sum: i64 = 0;
    let mut levels: u32 = 0;
    let mut stack: Vec<(&Node, u32)> = Vec::new();
    if let Some(r) = root.as_deref() {
        stack.push((r, 0));
    }
    while let Some((node, d)) = stack.pop() {
        levels = levels.max(d + 1);
        if d % 2 == 0 {
            sum += node.key as i64;
        }
        for child in [&node.left, &node.right] {
            if let Some(c) = child.as_deref() {
                stack.push((c, d + 1));
            }
        }
    }
    ((sum & 0xFFFF_FFFF) as u32) ^ levels
    // note: tree drop is recursive; depth is small for random keys
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
    println!("task=t3 variant=rust-idiom n={} checksum={} best_ms={:.3} median_ms={:.3}", N, checksum, times[0], times[3]);
}
