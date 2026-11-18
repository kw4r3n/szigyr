// expect: ok
// stage: 1
// open-question: Q029
// open-question: Q054
interface Named {
  label(): string;
}

export class Tag implements Named {
  readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  label(): string {
    return `#${this.text}`;
  }
}

export class Account {
  static readonly LIMIT: u32 = 1000;
  readonly id: u32;
  private balance: u32;

  constructor(id: u32, balance: u32) {
    this.id = id;
    this.balance = balance;
  }

  deposit(n: u32): void {
    if (this.balance + n > Account.LIMIT) {
      panic("over limit");
    }
    this.balance += n;
  }

  withdraw(n: u32): boolean {
    if (n > this.balance) {
      return false;
    }
    this.balance -= n;
    return true;
  }

  current(): u32 {
    return this.balance;
  }
}

export function show(n: Named): string {
  return n.label();
}

test("class", (t: Test) => {
  t.eq(show(new Tag("a")), "#a");
  const a = new Account(1, 100);
  a.deposit(50);
  t.ok(a.withdraw(30));
  t.ok(!a.withdraw(500));
  t.eq(a.current(), 120);
  t.eq(a.id, 1);
  t.traps("T006", () => {
    const b = new Account(2, 600);
    b.deposit(500);
  });
});
