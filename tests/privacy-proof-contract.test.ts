// tests/privacy-proof-contract.test.ts
import { describe, it, expect, beforeEach } from "vitest";

type Result<T> = { ok: true; value: T } | { ok: false; value: number };

const ERR_NOT_AUTHORIZED = 100;
const ERR_PROOF_REUSED = 103;
const ERR_CIRCUIT_MISMATCH = 109;
const ERR_PROOF_MALFORMED = 108;
const ERR_VERIFICATION_FAILED = 105;
const ERR_PROOF_TOO_OLD = 106;
const ERR_INVALID_PUBLIC_KEY = 104;

class PrivacyProofContractMock {
  state = {
    admin: "ST1ADMIN",
    circuitId: 1n,
    proofValidityPeriod: 1000n,
    maxProofAge: 720n,
    verifiedProofs: new Map<
      string,
      { verifiedAt: bigint; meterId: string; reading: bigint }
    >(),
    proofNonces: new Map<string, boolean>(),
    publicKeys: new Map<string, Uint8Array>(),
  };
  blockHeight = 5000n;
  caller = "ST1USER";

  reset() {
    this.state = {
      admin: "ST1ADMIN",
      circuitId: 1n,
      proofValidityPeriod: 1000n,
      maxProofAge: 720n,
      verifiedProofs: new Map(),
      proofNonces: new Map(),
      publicKeys: new Map(),
    };
    this.blockHeight = 5000n;
    this.caller = "ST1USER";
  }

  hashProofData(encrypted: Uint8Array, nonce: bigint, meterId: string): string {
    return `${encrypted.toString()}-${nonce}-${meterId}`;
  }

  setAdmin(newAdmin: string): Result<boolean> {
    if (this.caller !== this.state.admin)
      return { ok: false, value: ERR_NOT_AUTHORIZED };
    this.state.admin = newAdmin;
    return { ok: true, value: true };
  }

  updateCircuitId(newId: bigint): Result<boolean> {
    if (this.caller !== this.state.admin)
      return { ok: false, value: ERR_NOT_AUTHORIZED };
    this.state.circuitId = newId;
    return { ok: true, value: true };
  }

  registerPublicKey(pubkey: Uint8Array): Result<boolean> {
    if (pubkey.length !== 33)
      return { ok: false, value: ERR_INVALID_PUBLIC_KEY };
    this.state.publicKeys.set(this.caller, pubkey);
    return { ok: true, value: true };
  }

  verifyProof(
    encryptedReading: Uint8Array,
    zkProof: Uint8Array,
    nonce: bigint,
    plainReading: bigint,
    circuitIdInput: bigint
  ): Result<string> {
    if (encryptedReading.length < 32 || zkProof.length < 128)
      return { ok: false, value: ERR_PROOF_MALFORMED };
    if (circuitIdInput !== this.state.circuitId)
      return { ok: false, value: ERR_CIRCUIT_MISMATCH };
    if (this.blockHeight - 5000n > this.state.maxProofAge)
      return { ok: false, value: ERR_PROOF_TOO_OLD };

    const proofHash = this.hashProofData(encryptedReading, nonce, this.caller);
    if (this.state.verifiedProofs.has(proofHash))
      return { ok: false, value: ERR_PROOF_REUSED };
    const nonceKey = `${this.caller}-${nonce}`;
    if (this.state.proofNonces.get(nonceKey))
      return { ok: false, value: ERR_PROOF_REUSED };

    const simulated = this.simulateVerification(encryptedReading, plainReading);
    if (!simulated) return { ok: false, value: ERR_VERIFICATION_FAILED };

    this.state.verifiedProofs.set(proofHash, {
      verifiedAt: this.blockHeight,
      meterId: this.caller,
      reading: plainReading,
    });
    this.state.proofNonces.set(nonceKey, true);
    return { ok: true, value: proofHash };
  }

  private simulateVerification(
    encrypted: Uint8Array,
    expected: bigint
  ): boolean {
    const hash = this.simpleHash(encrypted);
    return hash === Number(expected % 256n);
  }

  private simpleHash(data: Uint8Array): number {
    return data.reduce((acc, b) => (acc + b) % 256, 0);
  }

  getAdmin(): string {
    return this.state.admin;
  }

  getCircuitId(): bigint {
    return this.state.circuitId;
  }

  isProofVerified(hash: string): boolean {
    return this.state.verifiedProofs.has(hash);
  }
}

describe("privacy-proof-contract", () => {
  let contract: PrivacyProofContractMock;

  beforeEach(() => {
    contract = new PrivacyProofContractMock();
    contract.reset();
    contract.caller = "ST1ADMIN";
  });

  it("sets new admin successfully", () => {
    const result = contract.setAdmin("ST2NEWADMIN");
    expect(result.ok).toBe(true);
    expect(contract.getAdmin()).toBe("ST2NEWADMIN");
  });

  it("rejects admin change by non-admin", () => {
    contract.caller = "ST1USER";
    const result = contract.setAdmin("ST2NEWADMIN");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_NOT_AUTHORIZED);
  });

  it("updates circuit ID", () => {
    const result = contract.updateCircuitId(2n);
    expect(result.ok).toBe(true);
    expect(contract.getCircuitId()).toBe(2n);
  });

  it("registers public key", () => {
    contract.caller = "ST1USER";
    const pubkey = new Uint8Array(33).fill(1);
    const result = contract.registerPublicKey(pubkey);
    expect(result.ok).toBe(true);
  });

  it("rejects invalid public key length", () => {
    contract.caller = "ST1USER";
    const pubkey = new Uint8Array(32);
    const result = contract.registerPublicKey(pubkey);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_PUBLIC_KEY);
  });

  it("rejects proof with wrong circuit ID", () => {
    contract.caller = "ST1USER";
    const enc = new Uint8Array(32);
    const proof = new Uint8Array(128);
    const result = contract.verifyProof(enc, proof, 1n, 100n, 999n);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_CIRCUIT_MISMATCH);
  });

  it("rejects malformed proof", () => {
    contract.caller = "ST1USER";
    const enc = new Uint8Array(10);
    const proof = new Uint8Array(10);
    const result = contract.verifyProof(enc, proof, 1n, 100n, 1n);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_PROOF_MALFORMED);
  });

  it("rejects old proof", () => {
    contract.blockHeight = 6000n;
    contract.state.maxProofAge = 500n;
    contract.caller = "ST1USER";
    const enc = new Uint8Array(32);
    const proof = new Uint8Array(128);
    const result = contract.verifyProof(enc, proof, 1n, 100n, 1n);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_PROOF_TOO_OLD);
  });

  it("simulates proof verification correctly", () => {
    contract.caller = "ST1USER";
    const enc = new Uint8Array(32).fill(4);
    const result = contract.verifyProof(enc, new Uint8Array(128), 1n, 128n, 1n);
    expect(result.ok).toBe(true);
  });
});
