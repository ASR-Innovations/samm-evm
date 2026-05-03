//! SAMM Math CLI
//!
//! Usage:
//!   samm <subcommand> '<json>'
//!
//! Subcommands:
//!   swap-samm        Full swap (Rust original fee formula)
//!   swap-samm-paper  Full swap (research paper fee formula — matches deployed Solidity)
//!   fee-samm         Fee only (Rust original)
//!   fee-paper        Fee only (research paper)
//!   swap-revert      Curve math only (no fees)
//!
//! All output is JSON on stdout. Errors go to stderr as {"error":"..."} with exit code 1.

use samm_math::{
    curve,
    fees::{self, BETA1_DEFAULT, RMIN_DEFAULT, RMAX_DEFAULT},
    samm,
};
use serde::{Deserialize, Serialize};
use std::process;

// ── Input schemas ─────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct SwapSammInput {
    output_amount: u128,
    source_reserve: u128,
    dest_reserve: u128,
    trade_fee_num: u128,
    trade_fee_denom: u128,
    #[serde(default)]
    owner_fee_num: u128,
    #[serde(default = "default_one")]
    owner_fee_denom: u128,
}

#[derive(Deserialize)]
struct SwapSammPaperInput {
    output_amount: u128,
    source_reserve: u128,
    dest_reserve: u128,
    #[serde(default = "default_beta1")]
    beta1: i128,
    #[serde(default = "default_rmin")]
    rmin: u128,
    #[serde(default = "default_rmax")]
    rmax: u128,
    #[serde(default)]
    owner_fee_num: u128,
    #[serde(default = "default_one")]
    owner_fee_denom: u128,
}

#[derive(Deserialize)]
struct FeeSammInput {
    output_amount: u128,
    output_reserve: u128,
    input_reserve: u128,
    fee_numerator: u128,
    fee_denominator: u128,
}

#[derive(Deserialize)]
struct FeePaperInput {
    output_amount: u128,
    output_reserve: u128,
    input_reserve: u128,
    #[serde(default = "default_beta1")]
    beta1: i128,
    #[serde(default = "default_rmin")]
    rmin: u128,
    #[serde(default = "default_rmax")]
    rmax: u128,
}

#[derive(Deserialize)]
struct SwapRevertInput {
    destination_amount: u128,
    source_reserve: u128,
    dest_reserve: u128,
}

// ── Output schemas ────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct FeeOutput {
    fee: u128,
}

#[derive(Serialize)]
struct SwapRevertOutput {
    source_amount_swapped: u128,
    destination_amount_swapped: u128,
}

#[derive(Serialize)]
struct ErrorOutput {
    error: String,
}

// ── Defaults ──────────────────────────────────────────────────────────────────

fn default_one() -> u128 { 1 }
fn default_beta1() -> i128 { BETA1_DEFAULT }
fn default_rmin() -> u128 { RMIN_DEFAULT }
fn default_rmax() -> u128 { RMAX_DEFAULT }

// ── Helpers ───────────────────────────────────────────────────────────────────

fn err(msg: &str) -> ! {
    let out = serde_json::to_string(&ErrorOutput { error: msg.to_string() }).unwrap();
    eprintln!("{out}");
    process::exit(1);
}

fn print_json<T: Serialize>(val: &T) {
    println!("{}", serde_json::to_string(val).unwrap());
}

// ── Main ──────────────────────────────────────────────────────────────────────

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        err("usage: samm <subcommand> '<json>'");
    }

    let subcommand = &args[1];
    let json_input = &args[2];

    match subcommand.as_str() {
        "swap-samm" => {
            let input: SwapSammInput =
                serde_json::from_str(json_input).unwrap_or_else(|e| err(&e.to_string()));
            let result = samm::swap_samm(
                input.output_amount,
                input.source_reserve,
                input.dest_reserve,
                input.trade_fee_num,
                input.trade_fee_denom,
                input.owner_fee_num,
                input.owner_fee_denom,
            )
            .unwrap_or_else(|| err("swap_samm: arithmetic overflow or invalid input"));
            print_json(&result);
        }

        "swap-samm-paper" => {
            let input: SwapSammPaperInput =
                serde_json::from_str(json_input).unwrap_or_else(|e| err(&e.to_string()));
            let result = samm::swap_samm_paper(
                input.output_amount,
                input.source_reserve,
                input.dest_reserve,
                input.beta1,
                input.rmin,
                input.rmax,
                input.owner_fee_num,
                input.owner_fee_denom,
            )
            .unwrap_or_else(|| err("swap_samm_paper: arithmetic overflow or invalid input"));
            print_json(&result);
        }

        "fee-samm" => {
            let input: FeeSammInput =
                serde_json::from_str(json_input).unwrap_or_else(|e| err(&e.to_string()));
            let fee = fees::calculate_fee_samm(
                input.output_amount,
                input.output_reserve,
                input.input_reserve,
                input.fee_numerator,
                input.fee_denominator,
            )
            .unwrap_or_else(|| err("fee-samm: arithmetic overflow"));
            print_json(&FeeOutput { fee });
        }

        "fee-paper" => {
            let input: FeePaperInput =
                serde_json::from_str(json_input).unwrap_or_else(|e| err(&e.to_string()));
            let fee = fees::calculate_fee_paper(
                input.output_amount,
                input.output_reserve,
                input.input_reserve,
                input.beta1,
                input.rmin,
                input.rmax,
            );
            print_json(&FeeOutput { fee });
        }

        "swap-revert" => {
            let input: SwapRevertInput =
                serde_json::from_str(json_input).unwrap_or_else(|e| err(&e.to_string()));
            let result = curve::swap_revert(
                input.destination_amount,
                input.source_reserve,
                input.dest_reserve,
            )
            .unwrap_or_else(|| err("swap-revert: arithmetic overflow or invalid input"));
            print_json(&SwapRevertOutput {
                source_amount_swapped: result.source_amount_swapped,
                destination_amount_swapped: result.destination_amount_swapped,
            });
        }

        unknown => err(&format!("unknown subcommand: {unknown}")),
    }
}
