// tests/billing-contract.test.ts
import { describe, it, expect, beforeEach } from "vitest";

type Result<T> = { ok: true; value: T } | { ok: false; value: number };
type Bill = {
  usage: bigint;
  amountDue: bigint;
  calculatedAt: bigint;
  paid: boolean;
  settlementId: bigint;
};
type PeriodTotals = {
  totalUsage: bigint;
  totalBilled: bigint;
  billCount: bigint;
};

const ERR_NOT_AUTHORIZED = 100;
const ERR_METER_NOT_REGISTERED = 101;
const ERR_PERIOD_NOT_CLOSED = 102;
const ERR_BILL_ALREADY_CALCULATED = 103;
const ERR_ZERO_USAGE = 108;
const ERR_RATE_NOT_SET = 109;

class BillingContractMock {
  state = {
    admin: "ST1ADMIN",
    ratePerUnit: 150n,
    currency: "STX",
    settlementRates: new Map<bigint, bigint>(),
    userBills: new Map<string, Bill>(),
    periodTotals: new Map<bigint, PeriodTotals>(),
  };
  blockHeight = 2000n;
  caller = "ST1USER";
  meterData = {
    getMeterInfo: (id: string): any => {
      if (id === "ST1USER") return { settlementId: 1n, active: true };
      if (id === "ST2USER") return { settlementId: 2n, active: true };
      return null;
    },
    getSubmission: (id: string, period: bigint): any => {
      if (id === "ST1USER" && period === 5n) return { readingValue: 100n };
      if (id === "ST2USER" && period === 5n) return { readingValue: 200n };
      return null;
    },
    getPeriodInfo: (period: bigint): any => {
      if (period === 5n) return { status: "closed" };
      return { status: "active" };
    },
  };

  reset() {
    this.state = {
      admin: "ST1ADMIN",
      ratePerUnit: 150n,
      currency: "STX",
      settlementRates: new Map(),
      userBills: new Map(),
      periodTotals: new Map(),
    };
    this.blockHeight = 2000n;
    this.caller = "ST1USER";
  }

  setAdmin(newAdmin: string): Result<boolean> {
    if (this.caller !== this.state.admin)
      return { ok: false, value: ERR_NOT_AUTHORIZED };
    this.state.admin = newAdmin;
    return { ok: true, value: true };
  }

  setGlobalRate(rate: bigint): Result<boolean> {
    if (this.caller !== this.state.admin)
      return { ok: false, value: ERR_NOT_AUTHORIZED };
    if (rate === 0n) return { ok: false, value: 103 };
    this.state.ratePerUnit = rate;
    return { ok: true, value: true };
  }

  setSettlementRate(settlementId: bigint, rate: bigint): Result<boolean> {
    if (this.caller !== this.state.admin)
      return { ok: false, value: ERR_NOT_AUTHORIZED };
    if (rate === 0n) return { ok: false, value: 103 };
    this.state.settlementRates.set(settlementId, rate);
    return { ok: true, value: true };
  }

  calculateBill(
    meterId: string,
    period: bigint
  ): Result<{ usage: bigint; amount: bigint }> {
    const meter = this.meterData.getMeterInfo(meterId);
    if (!meter || !meter.active)
      return { ok: false, value: ERR_METER_NOT_REGISTERED };
    const key = `${meterId}-${period}`;
    if (this.state.userBills.has(key))
      return { ok: false, value: ERR_BILL_ALREADY_CALCULATED };
    if (this.meterData.getPeriodInfo(period).status !== "closed")
      return { ok: false, value: ERR_PERIOD_NOT_CLOSED };

    const usage =
      this.meterData.getSubmission(meterId, period)?.readingValue ?? 0n;
    if (usage === 0n) return { ok: false, value: ERR_ZERO_USAGE };

    const rate =
      this.state.settlementRates.get(meter.settlementId) ??
      this.state.ratePerUnit;
    if (rate === undefined) return { ok: false, value: ERR_RATE_NOT_SET };
    const amount = usage * rate;

    this.state.userBills.set(key, {
      usage,
      amountDue: amount,
      calculatedAt: this.blockHeight,
      paid: false,
      settlementId: meter.settlementId,
    });

    const totalKey = period;
    const existing = this.state.periodTotals.get(totalKey) ?? {
      totalUsage: 0n,
      totalBilled: 0n,
      billCount: 0n,
    };
    this.state.periodTotals.set(totalKey, {
      totalUsage: existing.totalUsage + usage,
      totalBilled: existing.totalBilled + amount,
      billCount: existing.billCount + 1n,
    });

    return { ok: true, value: { usage, amount } };
  }

  markBillPaid(meterId: string, period: bigint): Result<boolean> {
    const key = `${meterId}-${period}`;
    const bill = this.state.userBills.get(key);
    if (!bill) return { ok: false, value: 105 };
    if (bill.paid) return { ok: false, value: ERR_BILL_ALREADY_CALCULATED };
    this.state.userBills.set(key, { ...bill, paid: true });
    return { ok: true, value: true };
  }

  getUserBill(meterId: string, period: bigint): Bill | null {
    return this.state.userBills.get(`${meterId}-${period}`) ?? null;
  }

  getPeriodTotals(period: bigint): PeriodTotals | null {
    return this.state.periodTotals.get(period) ?? null;
  }
}

describe("billing-contract", () => {
  let contract: BillingContractMock;

  beforeEach(() => {
    contract = new BillingContractMock();
    contract.reset();
    contract.caller = "ST1ADMIN";
    contract.setSettlementRate(1n, 200n);
  });

  it("sets global rate", () => {
    const result = contract.setGlobalRate(175n);
    expect(result.ok).toBe(true);
    expect(contract.state.ratePerUnit).toBe(175n);
  });

  it("calculates bill with settlement rate", () => {
    contract.caller = "ST1USER";
    const result = contract.calculateBill("ST1USER", 5n);
    expect(result.ok).toBe(true);
    expect(result.value.amount).toBe(200n * 100n); // 200 rate * 100 usage
  });

  it("falls back to global rate", () => {
    contract.caller = "ST2USER";
    const result = contract.calculateBill("ST2USER", 5n);
    expect(result.ok).toBe(true);
    expect(result.value.amount).toBe(150n * 200n);
  });

  it("rejects bill if period not closed", () => {
    contract.caller = "ST1USER";
    const result = contract.calculateBill("ST1USER", 6n);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_PERIOD_NOT_CLOSED);
  });

  it("rejects duplicate bill calculation", () => {
    contract.caller = "ST1USER";
    contract.calculateBill("ST1USER", 5n);
    const result = contract.calculateBill("ST1USER", 5n);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_BILL_ALREADY_CALCULATED);
  });

  it("tracks period totals", () => {
    contract.caller = "ST1USER";
    contract.calculateBill("ST1USER", 5n);
    contract.caller = "ST2USER";
    contract.calculateBill("ST2USER", 5n);
    const totals = contract.getPeriodTotals(5n);
    expect(totals?.totalUsage).toBe(300n);
    expect(totals?.totalBilled).toBe(200n * 100n + 150n * 200n);
    expect(totals?.billCount).toBe(2n);
  });

  it("marks bill as paid", () => {
    contract.caller = "ST1USER";
    contract.calculateBill("ST1USER", 5n);
    const result = contract.markBillPaid("ST1USER", 5n);
    expect(result.ok).toBe(true);
    const bill = contract.getUserBill("ST1USER", 5n);
    expect(bill?.paid).toBe(true);
  });

  it("rejects payment for non-existent bill", () => {
    const result = contract.markBillPaid("ST1USER", 5n);
    expect(result.ok).toBe(false);
  });

  it("rejects zero usage", () => {
    contract.caller = "ST1USER";
    contract.meterData.getSubmission = () => null;
    const result = contract.calculateBill("ST1USER", 5n);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_ZERO_USAGE);
  });
});
