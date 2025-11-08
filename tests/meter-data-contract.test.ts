// tests/meter-data-contract.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { buffCV, uintCV, trueCV, falseCV } from "@stacks/transactions";

type Result<T> = { ok: true; value: T } | { ok: false; value: number };
type MeterInfo = {
  settlementId: bigint;
  lastReading: bigint;
  registeredAt: bigint;
  active: boolean;
};
type Submission = {
  encryptedReading: Uint8Array;
  zkProof: Uint8Array;
  submittedAt: bigint;
  verified: boolean;
  readingValue: bigint;
};
type PeriodMeta = {
  startBlock: bigint;
  endBlock: bigint;
  totalSubmissions: bigint;
  verifiedCount: bigint;
  status: string;
};

const ERR_NOT_AUTHORIZED = 100;
const ERR_INVALID_PROOF = 101;
const ERR_ALREADY_SUBMITTED = 102;
const ERR_METER_NOT_REGISTERED = 103;
const ERR_PERIOD_CLOSED = 104;
const ERR_PROOF_VERIFICATION_FAILED = 106;
const ERR_READING_TOO_HIGH = 107;

class MeterDataContractMock {
  state = {
    currentPeriod: 0n,
    periodDuration: 144n,
    maxReadingDelta: 1_000_000n,
    proofVerifier: "ST2PROOF",
    meterRegistrations: new Map<string, MeterInfo>(),
    usageSubmissions: new Map<string, Submission>(),
    periodMetadata: new Map<number, PeriodMeta>(),
  };
  blockHeight = 1000n;
  caller = "ST1USER";
  proofVerificationResult = true;

  reset() {
    this.state = {
      currentPeriod: 0n,
      periodDuration: 144n,
      maxReadingDelta: 1_000_000n,
      proofVerifier: "ST2PROOF",
      meterRegistrations: new Map(),
      usageSubmissions: new Map(),
      periodMetadata: new Map(),
    };
    this.blockHeight = 1000n;
    this.caller = "ST1USER";
    this.proofVerificationResult = true;
  }

  registerMeter(settlementId: bigint): Result<boolean> {
    const key = this.caller;
    if (this.state.meterRegistrations.has(key))
      return { ok: false, value: ERR_METER_NOT_REGISTERED };
    this.state.meterRegistrations.set(key, {
      settlementId,
      lastReading: 0n,
      registeredAt: this.blockHeight,
      active: true,
    });
    return { ok: true, value: true };
  }

  submitUsageProof(
    encryptedReading: Uint8Array,
    zkProof: Uint8Array,
    plainReading: bigint
  ): Result<boolean> {
    const period = this.state.currentPeriod;
    const key = `${this.caller}-${period}`;
    const meter = this.state.meterRegistrations.get(this.caller);
    if (!meter || !meter.active)
      return { ok: false, value: ERR_METER_NOT_REGISTERED };
    if (this.state.usageSubmissions.has(key))
      return { ok: false, value: ERR_ALREADY_SUBMITTED };
    if (!this.state.periodMetadata.has(Number(period)))
      return { ok: false, value: ERR_PERIOD_CLOSED };
    const meta = this.state.periodMetadata.get(Number(period))!;
    if (meta.status !== "active")
      return { ok: false, value: ERR_PERIOD_CLOSED };
    if (plainReading < meter.lastReading)
      return { ok: false, value: ERR_READING_TOO_HIGH };
    if (plainReading - meter.lastReading > this.state.maxReadingDelta)
      return { ok: false, value: ERR_READING_TOO_HIGH };
    if (!this.proofVerificationResult)
      return { ok: false, value: ERR_PROOF_VERIFICATION_FAILED };

    this.state.usageSubmissions.set(key, {
      encryptedReading,
      zkProof,
      submittedAt: this.blockHeight,
      verified: true,
      readingValue: plainReading,
    });
    this.state.meterRegistrations.set(this.caller, {
      ...meter,
      lastReading: plainReading,
    });
    const updated = {
      ...meta,
      totalSubmissions: meta.totalSubmissions + 1n,
      verifiedCount: meta.verifiedCount + 1n,
    };
    this.state.periodMetadata.set(Number(period), updated);
    return { ok: true, value: true };
  }

  advancePeriod(): Result<bigint> {
    if (this.caller !== this.state.proofVerifier)
      return { ok: false, value: ERR_NOT_AUTHORIZED };
    const period = this.state.currentPeriod;
    const meta = this.state.periodMetadata.get(Number(period));
    if (meta)
      this.state.periodMetadata.set(Number(period), {
        ...meta,
        status: "closed",
      });
    this.state.currentPeriod += 1n;
    this.state.periodMetadata.set(Number(this.state.currentPeriod), {
      startBlock: this.blockHeight,
      endBlock: this.blockHeight + this.state.periodDuration,
      totalSubmissions: 0n,
      verifiedCount: 0n,
      status: "active",
    });
    return { ok: true, value: this.state.currentPeriod };
  }

  getCurrentPeriod(): bigint {
    return this.state.currentPeriod;
  }

  getMeterInfo(meterId: string): MeterInfo | null {
    return this.state.meterRegistrations.get(meterId) || null;
  }

  getSubmission(meterId: string, period: bigint): Submission | null {
    return this.state.usageSubmissions.get(`${meterId}-${period}`) || null;
  }

  getPeriodInfo(period: bigint): PeriodMeta | null {
    return this.state.periodMetadata.get(Number(period)) || null;
  }
}

describe("meter-data-contract", () => {
  let contract: MeterDataContractMock;

  beforeEach(() => {
    contract = new MeterDataContractMock();
    contract.reset();
    contract.state.periodMetadata.set(0, {
      startBlock: 1000n,
      endBlock: 1144n,
      totalSubmissions: 0n,
      verifiedCount: 0n,
      status: "active",
    });
  });

  it("registers a meter successfully", () => {
    const result = contract.registerMeter(5n);
    expect(result.ok).toBe(true);
    const info = contract.getMeterInfo("ST1USER");
    expect(info?.settlementId).toBe(5n);
    expect(info?.active).toBe(true);
  });

  it("rejects double registration", () => {
    contract.registerMeter(1n);
    const result = contract.registerMeter(2n);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_METER_NOT_REGISTERED);
  });

  it("submits valid usage proof", () => {
    contract.registerMeter(1n);
    const enc = new Uint8Array(32).fill(1);
    const proof = new Uint8Array(128).fill(2);
    const result = contract.submitUsageProof(enc, proof, 500n);
    expect(result.ok).toBe(true);
    const sub = contract.getSubmission("ST1USER", 0n);
    expect(sub?.readingValue).toBe(500n);
    expect(sub?.verified).toBe(true);
    const meter = contract.getMeterInfo("ST1USER");
    expect(meter?.lastReading).toBe(500n);
  });

  it("rejects submission without registration", () => {
    const enc = new Uint8Array(32);
    const proof = new Uint8Array(128);
    const result = contract.submitUsageProof(enc, proof, 100n);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_METER_NOT_REGISTERED);
  });

  it("rejects duplicate submission in same period", () => {
    contract.registerMeter(1n);
    const enc = new Uint8Array(32).fill(1);
    const proof = new Uint8Array(128).fill(2);
    contract.submitUsageProof(enc, proof, 200n);
    const result = contract.submitUsageProof(enc, proof, 300n);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_ALREADY_SUBMITTED);
  });

  it("rejects reading exceeding max delta", () => {
    contract.registerMeter(1n);
    const enc = new Uint8Array(32);
    const proof = new Uint8Array(128);
    const result = contract.submitUsageProof(enc, proof, 2_000_000n);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_READING_TOO_HIGH);
  });

  it("rejects submission when ZK proof fails", () => {
    contract.registerMeter(1n);
    contract.proofVerificationResult = false;
    const enc = new Uint8Array(32);
    const proof = new Uint8Array(128);
    const result = contract.submitUsageProof(enc, proof, 100n);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_PROOF_VERIFICATION_FAILED);
  });

  it("advances period correctly", () => {
    contract.caller = "ST2PROOF";
    const result = contract.advancePeriod();
    expect(result.ok).toBe(true);
    expect(result.value).toBe(1n);
    expect(contract.getCurrentPeriod()).toBe(1n);
    const oldMeta = contract.getPeriodInfo(0n);
    expect(oldMeta?.status).toBe("closed");
    const newMeta = contract.getPeriodInfo(1n);
    expect(newMeta?.status).toBe("active");
  });

  it("rejects period advance by non-verifier", () => {
    const result = contract.advancePeriod();
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_NOT_AUTHORIZED);
  });

  it("tracks period submissions accurately", () => {
    contract.registerMeter(1n);
    contract.caller = "ST2USER";
    contract.registerMeter(2n);
    contract.caller = "ST1USER";
    const enc = new Uint8Array(32).fill(1);
    const proof = new Uint8Array(128).fill(2);
    contract.submitUsageProof(enc, proof, 100n);
    contract.caller = "ST2USER";
    contract.submitUsageProof(enc, proof, 200n);
    const meta = contract.getPeriodInfo(0n);
    expect(meta?.totalSubmissions).toBe(2n);
    expect(meta?.verifiedCount).toBe(2n);
  });
});
