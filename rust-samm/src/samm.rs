//! Full SAMM swap orchestration — combines curve math with fee calculation.
//!
//! Two entry points:
//!   `swap_samm`       — uses the Rust original fee formula (matches spl-samm base.rs)
//!   `swap_samm_paper` — uses the research paper formula (matches deployed Solidity contracts)

use serde::{Deserialize, Serialize};
use crate::{curve, fees};

#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct SwapResult {
    /// Total source tokens the user must pay (base + trade_fee + owner_fee)
    pub amount_in: u128,
    /// Destination tokens the user receives
    pub amount_out: u128,
    /// Dynamic SAMM fee charged in source tokens
    pub trade_fee: u128,
    /// Owner fee charged in source tokens
    pub owner_fee: u128,
    /// Raw base swap amount before fees
    pub source_amount_swapped: u128,
}

/// Full SAMM swap using the **Rust original** fee formula.
///
/// Ported from base.rs:SwapCurve::swap_samm.
/// Step 1: calculate trade fee via `calculate_fee_samm`
/// Step 2: calculate owner fee via `owner_trading_fee`
/// Step 3: calculate base input needed via `swap_revert` (constant product)
/// Step 4: total_in = base_swap + trade_fee + owner_fee
pub fn swap_samm(
    output_amount: u128,
    swap_source_amount: u128,
    swap_destination_amount: u128,
    trade_fee_numerator: u128,
    trade_fee_denominator: u128,
    owner_fee_numerator: u128,
    owner_fee_denominator: u128,
) -> Option<SwapResult> {
    // Fees are calculated on the output amount (output-based AMM).
    let trade_fee = fees::calculate_fee_samm(
        output_amount,
        swap_destination_amount,
        swap_source_amount,
        trade_fee_numerator,
        trade_fee_denominator,
    )?;

    let owner_fee = fees::owner_trading_fee(
        output_amount,
        owner_fee_numerator,
        owner_fee_denominator,
    )?;

    // Base amount of source tokens needed to receive `output_amount` destination tokens
    // (without any fees — pure constant product math).
    let curve_result = curve::swap_revert(
        output_amount,
        swap_source_amount,
        swap_destination_amount,
    )?;

    let source_amount_swapped = curve_result.source_amount_swapped;
    let amount_in = source_amount_swapped
        .checked_add(trade_fee)?
        .checked_add(owner_fee)?;

    Some(SwapResult {
        amount_in,
        amount_out: output_amount,
        trade_fee,
        owner_fee,
        source_amount_swapped,
    })
}

/// Full SAMM swap using the **research paper** fee formula.
///
/// This matches the deployed Solidity contracts (`SAMMPool._calculateSwapSAMM`).
/// All fee parameters are scaled by 1_000_000 (same as Solidity SCALE_FACTOR).
pub fn swap_samm_paper(
    output_amount: u128,
    swap_source_amount: u128,
    swap_destination_amount: u128,
    beta1: i128,
    rmin: u128,
    rmax: u128,
    owner_fee_numerator: u128,
    owner_fee_denominator: u128,
) -> Option<SwapResult> {
    let trade_fee = fees::calculate_fee_paper(
        output_amount,
        swap_destination_amount,
        swap_source_amount,
        beta1,
        rmin,
        rmax,
    );

    let owner_fee = fees::owner_trading_fee(
        output_amount,
        owner_fee_numerator,
        owner_fee_denominator,
    )?;

    let curve_result = curve::swap_revert(
        output_amount,
        swap_source_amount,
        swap_destination_amount,
    )?;

    let source_amount_swapped = curve_result.source_amount_swapped;
    let amount_in = source_amount_swapped
        .checked_add(trade_fee)?
        .checked_add(owner_fee)?;

    Some(SwapResult {
        amount_in,
        amount_out: output_amount,
        trade_fee,
        owner_fee,
        source_amount_swapped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fees::{BETA1_DEFAULT, RMIN_DEFAULT, RMAX_DEFAULT};

    // ── swap_samm tests (match rust-verification.test.js Full SAMM Swap block) ─

    #[test]
    fn swap_samm_complete_flow() {
        // Matches "complete SAMM swap flow" test case
        // output=1000, reserves=100_000, trade=0.25%, owner=0.1%
        let r = swap_samm(1_000, 100_000, 100_000, 25, 10_000, 10, 10_000).unwrap();

        assert_eq!(r.amount_out, 1_000);
        assert!(r.amount_in > 1_000, "must pay more than output due to fees + price impact");
        assert!(r.trade_fee > 0);
        assert_eq!(r.owner_fee, 1); // (1000 × 10) / 10_000 = 1
        assert_eq!(r.amount_in, r.source_amount_swapped + r.trade_fee + r.owner_fee);
    }

    #[test]
    fn swap_samm_total_decomposition_holds() {
        // Invariant: amount_in = base + trade_fee + owner_fee — always.
        for (out, src, dst) in [(500u128, 50_000, 50_000), (1_000, 200_000, 100_000)] {
            let r = swap_samm(out, src, dst, 25, 10_000, 10, 10_000).unwrap();
            assert_eq!(r.amount_in, r.source_amount_swapped + r.trade_fee + r.owner_fee);
        }
    }

    #[test]
    fn swap_samm_larger_trade_higher_absolute_fee() {
        let small = swap_samm(100, 100_000, 100_000, 25, 10_000, 0, 1).unwrap();
        let large = swap_samm(10_000, 100_000, 100_000, 25, 10_000, 0, 1).unwrap();
        assert!(large.trade_fee > small.trade_fee);
    }

    #[test]
    fn swap_samm_small_trade_higher_fee_pct() {
        // Rust formula: small trades pay higher % fee than large trades.
        let small = swap_samm(100, 100_000, 100_000, 25, 10_000, 0, 1).unwrap();
        let large = swap_samm(10_000, 100_000, 100_000, 25, 10_000, 0, 1).unwrap();
        let small_bps = small.trade_fee * 10_000 / small.amount_out;
        let large_bps = large.trade_fee * 10_000 / large.amount_out;
        assert!(small_bps > large_bps, "small={small_bps} bps, large={large_bps} bps");
    }

    #[test]
    fn swap_samm_none_on_impossible_swap() {
        // Cannot drain the full reserve
        assert!(swap_samm(100_000, 100_000, 100_000, 25, 10_000, 0, 1).is_none());
    }

    // ── swap_samm_paper tests ────────────────────────────────────────────────

    #[test]
    fn swap_samm_paper_complete_flow() {
        let r = swap_samm_paper(
            1_000, 100_000, 100_000,
            BETA1_DEFAULT, RMIN_DEFAULT, RMAX_DEFAULT,
            10, 10_000,
        ).unwrap();

        assert_eq!(r.amount_out, 1_000);
        assert!(r.amount_in > 1_000);
        assert_eq!(r.amount_in, r.source_amount_swapped + r.trade_fee + r.owner_fee);
    }

    #[test]
    fn swap_samm_paper_total_decomposition_holds() {
        let r = swap_samm_paper(
            5_000, 200_000, 200_000,
            BETA1_DEFAULT, RMIN_DEFAULT, RMAX_DEFAULT,
            0, 1,
        ).unwrap();
        assert_eq!(r.amount_in, r.source_amount_swapped + r.trade_fee + r.owner_fee);
    }

    #[test]
    fn swap_samm_paper_none_on_impossible_swap() {
        assert!(swap_samm_paper(
            100_000, 100_000, 100_000,
            BETA1_DEFAULT, RMIN_DEFAULT, RMAX_DEFAULT,
            0, 1,
        ).is_none());
    }
}
