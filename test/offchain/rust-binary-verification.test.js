const { expect } = require("chai");
const { execSync } = require("child_process");
const path = require("path");

/**
 * Cross-verification: calls the compiled Rust binary and asserts its JSON output
 * matches the same formulas implemented in rust-verification.test.js.
 *
 * The binary must be built before running these tests:
 *   cd rust-samm && cargo build --release
 */

const BINARY = path.resolve(__dirname, "../../rust-samm/target/release/samm");

function callBinary(subcommand, params) {
  const json = JSON.stringify(params);
  try {
    const out = execSync(`"${BINARY}" ${subcommand} '${json}'`, {
      encoding: "utf8",
      timeout: 5000,
    });
    return JSON.parse(out.trim());
  } catch (e) {
    throw new Error(`Binary call failed: ${e.stderr || e.message}`);
  }
}

// ── Helpers matching the JS formulas from rust-verification.test.js ──────────

function jsSwapRevert(destinationAmount, swapSourceAmount, swapDestinationAmount) {
  const invariant = swapSourceAmount * swapDestinationAmount;
  const newSwapDestinationAmount = swapDestinationAmount - destinationAmount;
  let newSwapSourceAmount = invariant / newSwapDestinationAmount;
  if (newSwapSourceAmount * newSwapDestinationAmount !== invariant) {
    newSwapSourceAmount += 1n;
  }
  return {
    source_amount_swapped: newSwapSourceAmount - swapSourceAmount,
    destination_amount_swapped: destinationAmount,
  };
}

function jsFeeSamm(outputAmount, outputReserve, inputReserve, feeNumerator, feeDenominator) {
  if (feeNumerator === 0n || outputAmount === 0n) return 0n;
  const maxFeeNumerator = feeNumerator * 5n;
  const tmp = (outputAmount * 12n * feeDenominator) / (10n * outputReserve);
  if (tmp + feeNumerator > maxFeeNumerator) {
    return (outputAmount * feeNumerator * inputReserve) / (outputReserve * feeDenominator);
  }
  return (outputAmount * (maxFeeNumerator - tmp) * inputReserve) / (outputReserve * feeDenominator);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Rust Binary Cross-Verification", function () {
  this.timeout(10_000);

  before(function () {
    try {
      execSync(`test -f "${BINARY}"`);
    } catch (_) {
      this.skip(); // binary not built — skip gracefully
    }
  });

  // ── swap-revert ────────────────────────────────────────────────────────────

  describe("swap-revert", function () {
    const cases = [
      { desc: "basic (source=102)", dest: 100n, src: 10_000n, dst: 10_000n },
      { desc: "ceiling div (source=345)", dest: 333n, src: 10_000n, dst: 10_000n },
      { desc: "exact division (source=10000)", dest: 5_000n, src: 10_000n, dst: 10_000n },
      { desc: "unequal reserves", dest: 1_000n, src: 50_000n, dst: 30_000n },
    ];

    cases.forEach(({ desc, dest, src, dst }) => {
      it(`should match JS: ${desc}`, function () {
        const expected = jsSwapRevert(dest, src, dst);
        const actual = callBinary("swap-revert", {
          destination_amount: Number(dest),
          source_reserve: Number(src),
          dest_reserve: Number(dst),
        });

        expect(BigInt(actual.source_amount_swapped)).to.equal(expected.source_amount_swapped);
        expect(BigInt(actual.destination_amount_swapped)).to.equal(expected.destination_amount_swapped);
      });
    });

    it("should maintain k invariant", function () {
      const src = 50_000n, dst = 30_000n, out = 1_000n;
      const { source_amount_swapped } = callBinary("swap-revert", {
        destination_amount: Number(out),
        source_reserve: Number(src),
        dest_reserve: Number(dst),
      });
      const oldK = src * dst;
      const newK = (src + BigInt(source_amount_swapped)) * (dst - out);
      expect(newK >= oldK).to.be.true;
    });
  });

  // ── fee-samm ──────────────────────────────────────────────────────────────

  describe("fee-samm", function () {
    const cases = [
      { desc: "zero fee_num returns 0",    out: 1_000n, oRes: 10_000n, iRes: 10_000n, num: 0n, denom: 10_000n },
      { desc: "zero output returns 0",     out: 0n,     oRes: 10_000n, iRes: 10_000n, num: 25n, denom: 10_000n },
      { desc: "large pool small trade",    out: 100n,   oRes: 1_000_000n, iRes: 1_000_000n, num: 25n, denom: 10_000n },
      { desc: "small pool large trade",    out: 1_000n, oRes: 10_000n, iRes: 10_000n, num: 25n, denom: 10_000n },
      { desc: "boundary case",             out: 1_000n, oRes: 30_000n, iRes: 30_000n, num: 25n, denom: 10_000n },
      { desc: "unequal reserves (2× input)", out: 500n, oRes: 20_000n, iRes: 40_000n, num: 25n, denom: 10_000n },
    ];

    cases.forEach(({ desc, out, oRes, iRes, num, denom }) => {
      it(`should match JS: ${desc}`, function () {
        const expected = jsFeeSamm(out, oRes, iRes, num, denom);
        const actual = callBinary("fee-samm", {
          output_amount: Number(out),
          output_reserve: Number(oRes),
          input_reserve: Number(iRes),
          fee_numerator: Number(num),
          fee_denominator: Number(denom),
        });
        expect(BigInt(actual.fee)).to.equal(expected);
      });
    });
  });

  // ── swap-samm (full flow) ─────────────────────────────────────────────────

  describe("swap-samm full flow", function () {
    it("should match JS: complete flow (output=1000, reserves=100k)", function () {
      const out = 1_000n, src = 100_000n, dst = 100_000n;
      const tradeNum = 25n, tradeDenom = 10_000n;
      const ownerNum = 10n, ownerDenom = 10_000n;

      // JS calculation
      const tradeFee = jsFeeSamm(out, dst, src, tradeNum, tradeDenom);
      const ownerFee = (out * ownerNum) / ownerDenom;
      const { source_amount_swapped } = jsSwapRevert(out, src, dst);
      const expectedAmountIn = source_amount_swapped + tradeFee + ownerFee;

      // Rust binary
      const actual = callBinary("swap-samm", {
        output_amount: Number(out),
        source_reserve: Number(src),
        dest_reserve: Number(dst),
        trade_fee_num: Number(tradeNum),
        trade_fee_denom: Number(tradeDenom),
        owner_fee_num: Number(ownerNum),
        owner_fee_denom: Number(ownerDenom),
      });

      expect(BigInt(actual.amount_out)).to.equal(out);
      expect(BigInt(actual.amount_in)).to.equal(expectedAmountIn);
      expect(BigInt(actual.trade_fee)).to.equal(tradeFee);
      expect(BigInt(actual.owner_fee)).to.equal(ownerFee);
      expect(BigInt(actual.source_amount_swapped)).to.equal(source_amount_swapped);
    });

    it("should satisfy: amount_in = base + trade_fee + owner_fee", function () {
      for (const [out, src, dst] of [[500, 50_000, 50_000], [2_000, 200_000, 100_000]]) {
        const r = callBinary("swap-samm", {
          output_amount: out, source_reserve: src, dest_reserve: dst,
          trade_fee_num: 25, trade_fee_denom: 10_000,
          owner_fee_num: 10, owner_fee_denom: 10_000,
        });
        expect(r.amount_in).to.equal(r.source_amount_swapped + r.trade_fee + r.owner_fee);
      }
    });

    it("should satisfy: paper formula amount_in = base + trade_fee + owner_fee", function () {
      const r = callBinary("swap-samm-paper", {
        output_amount: 1_000, source_reserve: 100_000, dest_reserve: 100_000,
        owner_fee_num: 10, owner_fee_denom: 10_000,
      });
      expect(r.amount_in).to.equal(r.source_amount_swapped + r.trade_fee + r.owner_fee);
    });
  });

  // ── Both formulas on the same input ──────────────────────────────────────

  describe("formula comparison", function () {
    it("both formulas produce valid positive amount_in", function () {
      const params = {
        output_amount: 1_000, source_reserve: 100_000, dest_reserve: 100_000,
        trade_fee_num: 25, trade_fee_denom: 10_000,
        owner_fee_num: 0, owner_fee_denom: 1,
      };
      const rust = callBinary("swap-samm", params);
      const paper = callBinary("swap-samm-paper", {
        output_amount: params.output_amount,
        source_reserve: params.source_reserve,
        dest_reserve: params.dest_reserve,
        owner_fee_num: 0, owner_fee_denom: 1,
      });

      expect(rust.amount_in).to.be.gt(0);
      expect(paper.amount_in).to.be.gt(0);
      // Base swap (curve math) is identical — fees are the only difference
      expect(rust.source_amount_swapped).to.equal(paper.source_amount_swapped);

      console.log(`      Rust  trade_fee: ${rust.trade_fee}`);
      console.log(`      Paper trade_fee: ${paper.trade_fee}`);
      console.log(`      (Paper uses 18-dec normalized inputs in Solidity → 0 at this int scale)`);
    });
  });
});
