//! Constant product curve math — ported from spl-samm constant_product.rs.
//!
//! Core invariant: source_reserve × destination_reserve = k
//! All amounts are u128 to match the Solana implementation exactly.

use serde::{Deserialize, Serialize};

#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct SwapResult {
    pub source_amount_swapped: u128,
    pub destination_amount_swapped: u128,
}

/// Output-based swap: user specifies exact destination amount, returns source needed.
///
/// Ported from constant_product.rs:swap_revert.
/// Uses ceiling division on the source side so the pool invariant is never reduced.
///
/// Formula:
///   invariant = source_reserve × destination_reserve
///   new_dest  = destination_reserve − destination_amount
///   new_src   = ceil(invariant / new_dest)
///   source_in = new_src − source_reserve
pub fn swap_revert(
    destination_amount: u128,
    swap_source_amount: u128,
    swap_destination_amount: u128,
) -> Option<SwapResult> {
    if destination_amount == 0 || swap_source_amount == 0 || swap_destination_amount == 0 {
        return None;
    }
    if destination_amount >= swap_destination_amount {
        return None; // cannot drain the entire reserve
    }

    let invariant = swap_source_amount.checked_mul(swap_destination_amount)?;
    let new_swap_destination_amount = swap_destination_amount.checked_sub(destination_amount)?;

    let mut new_swap_source_amount = invariant.checked_div(new_swap_destination_amount)?;
    // Ceiling division: if there is a remainder, round source up to protect the pool.
    if new_swap_source_amount.checked_mul(new_swap_destination_amount)? != invariant {
        new_swap_source_amount = new_swap_source_amount.checked_add(1)?;
    }

    let source_amount_swapped = new_swap_source_amount.checked_sub(swap_source_amount)?;
    let destination_amount_swapped = destination_amount; // always equals what was requested

    if destination_amount_swapped == 0 {
        return None;
    }

    Some(SwapResult {
        source_amount_swapped,
        destination_amount_swapped,
    })
}

/// Input-based swap: user specifies exact source amount, returns destination received.
///
/// Ported from constant_product.rs:swap.
/// Uses ceiling division on the new destination reserve, meaning the pool retains
/// slightly more — the user receives the floor of what the invariant entitles them to.
///
/// Formula:
///   invariant     = source_reserve × destination_reserve
///   new_src       = source_reserve + source_amount
///   new_dest      = ceil(invariant / new_src)   ← pool keeps more (safe rounding)
///   destination_out = destination_reserve − new_dest
pub fn swap(
    source_amount: u128,
    swap_source_amount: u128,
    swap_destination_amount: u128,
) -> Option<SwapResult> {
    if source_amount == 0 || swap_source_amount == 0 || swap_destination_amount == 0 {
        return None;
    }

    let invariant = swap_source_amount.checked_mul(swap_destination_amount)?;
    let new_swap_source_amount = swap_source_amount.checked_add(source_amount)?;

    // Ceiling division: pool retains ceil(k / new_src) — slightly more than floor.
    let mut new_swap_destination_amount = invariant.checked_div(new_swap_source_amount)?;
    if new_swap_destination_amount.checked_mul(new_swap_source_amount)? < invariant {
        new_swap_destination_amount = new_swap_destination_amount.checked_add(1)?;
    }

    let destination_amount_swapped =
        swap_destination_amount.checked_sub(new_swap_destination_amount)?;

    if destination_amount_swapped == 0 {
        return None;
    }

    Some(SwapResult {
        source_amount_swapped: source_amount,
        destination_amount_swapped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── swap_revert tests (match rust-verification.test.js exactly) ────────────

    #[test]
    fn swap_revert_basic() {
        // invariant = 100_000_000
        // new_dest = 9_900, new_src = ceil(100_000_000 / 9_900) = ceil(10_101.01) = 10_102
        // source_needed = 10_102 − 10_000 = 102
        let r = swap_revert(100, 10_000, 10_000).unwrap();
        assert_eq!(r.source_amount_swapped, 102);
        assert_eq!(r.destination_amount_swapped, 100);
    }

    #[test]
    fn swap_revert_ceiling_division_applied() {
        // invariant = 100_000_000
        // new_dest = 9_667, new_src = ceil(100_000_000 / 9_667) = ceil(10_344.46) = 10_345
        // source_needed = 10_345 − 10_000 = 345
        let r = swap_revert(333, 10_000, 10_000).unwrap();
        assert_eq!(r.source_amount_swapped, 345);
    }

    #[test]
    fn swap_revert_no_ceiling_needed() {
        // invariant = 100_000_000
        // new_dest = 5_000, new_src = 100_000_000 / 5_000 = 20_000 (exact)
        // source_needed = 20_000 − 10_000 = 10_000
        let r = swap_revert(5_000, 10_000, 10_000).unwrap();
        assert_eq!(r.source_amount_swapped, 10_000);
    }

    #[test]
    fn swap_revert_invariant_maintained_or_increased() {
        let source_reserve = 50_000u128;
        let dest_reserve = 30_000u128;
        let output_wanted = 1_000u128;

        let r = swap_revert(output_wanted, source_reserve, dest_reserve).unwrap();

        let old_invariant = source_reserve * dest_reserve;
        let new_invariant =
            (source_reserve + r.source_amount_swapped) * (dest_reserve - r.destination_amount_swapped);

        assert!(
            new_invariant >= old_invariant,
            "invariant decreased: {} < {}",
            new_invariant,
            old_invariant
        );
    }

    #[test]
    fn swap_revert_unequal_reserves() {
        let r = swap_revert(1_000, 50_000, 30_000).unwrap();
        assert!(r.source_amount_swapped > 0);
    }

    #[test]
    fn swap_revert_none_when_draining_full_reserve() {
        assert!(swap_revert(10_000, 10_000, 10_000).is_none());
    }

    #[test]
    fn swap_revert_none_on_zero_destination() {
        assert!(swap_revert(0, 10_000, 10_000).is_none());
    }

    // ── swap tests ─────────────────────────────────────────────────────────────

    #[test]
    fn swap_basic_equal_reserves() {
        // source_reserve = dest_reserve = 10_000, adding 100
        // invariant = 100_000_000
        // new_src = 10_100
        // new_dest = ceil(100_000_000 / 10_100) = ceil(9_900.99) = 9_901
        // dest_out = 10_000 − 9_901 = 99
        let r = swap(100, 10_000, 10_000).unwrap();
        assert_eq!(r.source_amount_swapped, 100);
        assert!(r.destination_amount_swapped > 0);
    }

    #[test]
    fn swap_invariant_maintained() {
        let src_reserve = 10_000u128;
        let dst_reserve = 10_000u128;
        let source_in = 500u128;

        let r = swap(source_in, src_reserve, dst_reserve).unwrap();

        let old_invariant = src_reserve * dst_reserve;
        let new_invariant =
            (src_reserve + r.source_amount_swapped) * (dst_reserve - r.destination_amount_swapped);

        assert!(
            new_invariant >= old_invariant,
            "swap: invariant decreased: {} < {}",
            new_invariant,
            old_invariant
        );
    }

    #[test]
    fn swap_none_on_zero_source() {
        assert!(swap(0, 10_000, 10_000).is_none());
    }
}
