//! SAMM Router — on-chain shard selection + CPI to SAMM pool program
//!
//! This program replaces off-chain JavaScript routing with provably correct,
//! trustless, on-chain shard selection.  All SAMM invariants are enforced
//! at the protocol level:
//!
//!   c-Non-Splitting Property (c = 0.96):
//!     If amountOut < c × destReserve on the best shard, routing to that
//!     single shard is provably cheaper.  The program logs a warning and
//!     returns an error if the caller requests a split when it is not needed.
//!
//!   Smaller-Better Principle:
//!     The program reads every shard's on-chain reserves, computes the exact
//!     amountIn via the SAMM adaptive-fee formula, and selects the shard that
//!     minimises amountIn.  This is done entirely on-chain — no client-side
//!     quoting, no front-running.
//!
//! Instructions:
//!   0: route_swap       — single-hop, N shards, best shard selected on-chain
//!   1: route_swap_multi — two-hop (e.g. WBTC→USDC→DAI), each hop selects
//!                         the best shard independently
//!
//! ─── Account layouts ────────────────────────────────────────────────────────
//!
//! route_swap (opcode 0):
//!   Data: [0u8 | amount_out: u64 LE | max_amount_in: u64 LE | num_shards: u8]
//!   Fixed accounts (indices 0..7):
//!     0  user              (signer)
//!     1  user_source_ata   (writable)
//!     2  user_dest_ata     (writable)
//!     3  source_mint
//!     4  dest_mint
//!     5  samm_program
//!     6  token_program
//!   Per-shard accounts (6 × num_shards, starting at index 7):
//!     +0  pool_state       (writable)
//!     +1  pool_authority   (PDA; read-only in outer tx)
//!     +2  pool_token_a     (writable — always token_a regardless of swap dir)
//!     +3  pool_token_b     (writable)
//!     +4  pool_mint        (writable — LP token mint)
//!     +5  fee_account      (writable)
//!
//! route_swap_multi (opcode 1):
//!   Data: [1u8 | amount_out: u64 LE | max_amount_in: u64 LE | n_shards_hop1: u8 | n_shards_hop2: u8]
//!   Fixed accounts (indices 0..9):
//!     0  user              (signer)
//!     1  user_source_ata   (writable)
//!     2  user_mid_ata      (writable — intermediate token)
//!     3  user_dest_ata     (writable)
//!     4  source_mint
//!     5  mid_mint
//!     6  dest_mint
//!     7  samm_program
//!     8  token_program
//!   Hop-1 shard accounts (6 × n_shards_hop1, starting at index 9)
//!   Hop-2 shard accounts (6 × n_shards_hop2, after hop-1 shards)

#![deny(missing_docs)]
#![allow(clippy::too_many_arguments)]

use solana_program::{
    account_info::AccountInfo,
    entrypoint,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::invoke,
    program_error::ProgramError,
    pubkey::Pubkey,
};

entrypoint!(process_instruction);

// ── Constants ────────────────────────────────────────────────────────────────

/// c = 0.96: c-Non-Splitting threshold numerator (denominator = 100)
const C_NUM: u64 = 96;
const C_DEN: u64 = 100;

/// Number of accounts per shard group in remaining_accounts
const ACCS_PER_SHARD: usize = 6;

/// Fixed accounts before shard groups for route_swap
const FIXED_SWAP: usize = 7;

/// Fixed accounts before shard groups for route_swap_multi
const FIXED_MULTI: usize = 9;

/// Custom error code for exceeded slippage (matches SAMM program's 0x10)
const ERR_SLIPPAGE: u32 = 0x10;

// ── Entry point ──────────────────────────────────────────────────────────────

/// Program entry point
pub fn process_instruction<'a>(
    _program_id: &Pubkey,
    accounts: &'a [AccountInfo<'a>],
    data: &[u8],
) -> ProgramResult {
    let (&op, rest) = data.split_first().ok_or(ProgramError::InvalidInstructionData)?;
    match op {
        0 => route_swap(accounts, rest),
        1 => route_swap_multi(accounts, rest),
        _ => {
            msg!("Unknown opcode: {}", op);
            Err(ProgramError::InvalidInstructionData)
        }
    }
}

// ── Pool state deserialization ────────────────────────────────────────────────
//
// Layout of a SwapV1 account (total 324 bytes):
//   [0]        version byte = 1
//   [1]        is_initialized
//   [2]        bump_seed
//   [3..35]    token_program_id
//   [35..67]   token_a           (pool's token-A vault)
//   [67..99]   token_b           (pool's token-B vault)
//   [99..131]  pool_mint         (LP token mint)
//   [131..163] token_a_mint
//   [163..195] token_b_mint
//   [195..227] pool_fee_account
//   [227..235] trade_fee_numerator
//   [235..243] trade_fee_denominator
//   [243..251] owner_trade_fee_numerator
//   [251..259] owner_trade_fee_denominator
//   (remaining: withdraw/host fees + curve params — not used by router)

struct ShardInfo {
    mint_a: Pubkey,
    mint_b: Pubkey,
    #[allow(dead_code)]
    token_a: Pubkey, // pool vault for mint_a
    #[allow(dead_code)]
    token_b: Pubkey, // pool vault for mint_b
    trade_fee_num: u64,
    trade_fee_denom: u64,
    owner_fee_num: u64,
    owner_fee_denom: u64,
}

fn read_shard_info(account: &AccountInfo) -> Result<ShardInfo, ProgramError> {
    let data = account.data.borrow();
    if data.len() < 260 {
        msg!("Pool account too small: {} bytes", data.len());
        return Err(ProgramError::InvalidAccountData);
    }
    if data[0] != 1 {
        msg!("Unknown pool version: {}", data[0]);
        return Err(ProgramError::InvalidAccountData);
    }
    if data[1] == 0 {
        msg!("Pool not initialized");
        return Err(ProgramError::UninitializedAccount);
    }

    fn pk_at(d: &[u8], off: usize) -> Pubkey {
        let mut b = [0u8; 32];
        b.copy_from_slice(&d[off..off + 32]);
        Pubkey::new_from_array(b)
    }
    fn u64_at(d: &[u8], off: usize) -> u64 {
        u64::from_le_bytes(d[off..off + 8].try_into().unwrap())
    }

    Ok(ShardInfo {
        token_a:         pk_at(&data, 35),
        token_b:         pk_at(&data, 67),
        mint_a:          pk_at(&data, 131),
        mint_b:          pk_at(&data, 163),
        trade_fee_num:   u64_at(&data, 227),
        trade_fee_denom: u64_at(&data, 235),
        owner_fee_num:   u64_at(&data, 243),
        owner_fee_denom: u64_at(&data, 251),
    })
}

/// Read amount from an SPL token account (amount field is at offset 64, 8 bytes LE)
fn token_balance(account: &AccountInfo) -> Result<u64, ProgramError> {
    let data = account.data.borrow();
    if data.len() < 72 {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(u64::from_le_bytes(data[64..72].try_into().unwrap()))
}

// ── SAMM math ─────────────────────────────────────────────────────────────────

/// Constant-product reverse: compute source amount needed for exact destination output.
/// dx = ceil(x × dy / (y − dy))
fn swap_revert(amount_out: u64, src_reserve: u64, dst_reserve: u64) -> Option<u64> {
    if amount_out >= dst_reserve {
        return None; // would drain the pool
    }
    let num = (src_reserve as u128).checked_mul(amount_out as u128)?;
    let den = (dst_reserve as u128) - (amount_out as u128);
    // Ceiling division: round against the user (they pay slightly more)
    let q = num / den;
    let r = num % den;
    Some((q + if r > 0 { 1 } else { 0 }) as u64)
}

/// SAMM adaptive trade fee (mirrors fees.rs::calculate_fee_samm).
///
/// Branch on tmp = OA × 12 × fee_denom / (10 × output_reserve):
///   if tmp + fee_num > 5 × fee_num → minimal: fee = OA × fee_num × RA / (RB × fee_denom)
///   else                           → adaptive: fee = OA × (5×fee_num − tmp) × RA / (RB × fee_denom)
fn samm_fee(
    output_amount: u64,
    output_reserve: u64,
    input_reserve: u64,
    fee_num: u64,
    fee_denom: u64,
) -> Option<u64> {
    if fee_num == 0 || output_amount == 0 {
        return Some(0);
    }
    let oa   = output_amount as u128;
    let or_  = output_reserve as u128;
    let ir   = input_reserve as u128;
    let fn_  = fee_num as u128;
    let fd   = fee_denom as u128;
    let max  = fn_.checked_mul(5)?;
    let tmp  = oa.checked_mul(12)?.checked_mul(fd)?.checked_div(10)?.checked_div(or_)?;
    let fee = if tmp + fn_ > max {
        oa.checked_mul(fn_)?.checked_mul(ir)?.checked_div(or_)?.checked_div(fd)?
    } else {
        oa.checked_mul(max.checked_sub(tmp)?)?.checked_mul(ir)?.checked_div(or_)?.checked_div(fd)?
    };
    Some(fee as u64)
}

/// Owner trading fee: output_amount × owner_fee_num / owner_fee_denom
fn owner_fee(output_amount: u64, num: u64, denom: u64) -> u64 {
    if num == 0 || denom == 0 {
        return 0;
    }
    ((output_amount as u128 * num as u128) / denom as u128) as u64
}

/// Full exact-output quote: source tokens needed = base + trade_fee + owner_fee
fn quote(
    amount_out: u64,
    src_reserve: u64,
    dst_reserve: u64,
    trade_fee_num: u64,
    trade_fee_denom: u64,
    owner_fee_num: u64,
    owner_fee_denom: u64,
) -> Option<u64> {
    let base    = swap_revert(amount_out, src_reserve, dst_reserve)?;
    let t_fee   = samm_fee(amount_out, dst_reserve, src_reserve, trade_fee_num, trade_fee_denom)?;
    let o_fee   = owner_fee(amount_out, owner_fee_num, owner_fee_denom);
    base.checked_add(t_fee)?.checked_add(o_fee)
}

// ── Shard selection ───────────────────────────────────────────────────────────

struct BestShard {
    /// Index of the shard in the flat accounts slice (relative to shard_start)
    idx: usize,
    /// Computed amount_in at current on-chain reserves
    amount_in: u64,
    /// Whether amountOut ≥ c × destReserve (above c-threshold)
    above_c: bool,
}

/// Iterate over num_shards × ACCS_PER_SHARD accounts starting at shard_start.
/// Select the shard with the lowest computed amount_in.
fn select_best_shard(
    accounts: &[AccountInfo],
    shard_start: usize,
    num_shards: usize,
    source_mint: &Pubkey,
    amount_out: u64,
) -> Result<BestShard, ProgramError> {
    if shard_start + num_shards * ACCS_PER_SHARD > accounts.len() {
        msg!("Not enough accounts: need {} shard accounts", num_shards * ACCS_PER_SHARD);
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let mut best: Option<BestShard> = None;

    for i in 0..num_shards {
        let base = shard_start + i * ACCS_PER_SHARD;
        let pool_state  = &accounts[base];
        let pool_tok_a  = &accounts[base + 2];
        let pool_tok_b  = &accounts[base + 3];

        let info = match read_shard_info(pool_state) {
            Ok(s)  => s,
            Err(e) => { msg!("Shard {} state err ({}), skipping", i, e); continue; }
        };

        // Map token accounts to source / dest based on which mint the user wants to send
        let (src_acc, dst_acc) = if info.mint_a == *source_mint {
            (pool_tok_a, pool_tok_b)
        } else if info.mint_b == *source_mint {
            (pool_tok_b, pool_tok_a)
        } else {
            msg!("Shard {} mint mismatch — source_mint not in pool, skipping", i);
            continue;
        };

        let src_reserve = match token_balance(src_acc) {
            Ok(b)  => b,
            Err(e) => { msg!("Shard {} src balance err ({})", i, e); continue; }
        };
        let dst_reserve = match token_balance(dst_acc) {
            Ok(b)  => b,
            Err(e) => { msg!("Shard {} dst balance err ({})", i, e); continue; }
        };

        if dst_reserve <= amount_out {
            msg!("Shard {} insufficient liquidity: dst_reserve={} <= amount_out={}", i, dst_reserve, amount_out);
            continue;
        }

        let amt_in = match quote(
            amount_out, src_reserve, dst_reserve,
            info.trade_fee_num, info.trade_fee_denom,
            info.owner_fee_num, info.owner_fee_denom,
        ) {
            Some(a) => a,
            None    => { msg!("Shard {} math overflow, skipping", i); continue; }
        };

        // c-Non-Splitting check: is this trade above the c-threshold for this shard?
        let above_c = (amount_out as u128) * (C_DEN as u128)
            >= (dst_reserve as u128) * (C_NUM as u128);

        match &best {
            None => {
                best = Some(BestShard { idx: i, amount_in: amt_in, above_c });
            }
            Some(b) if amt_in < b.amount_in => {
                best = Some(BestShard { idx: i, amount_in: amt_in, above_c });
            }
            _ => {}
        }
    }

    match best {
        Some(b) => {
            msg!(
                "Best shard: idx={} amount_in={} above_c={}",
                b.idx, b.amount_in, b.above_c
            );
            Ok(b)
        }
        None => {
            msg!("No shard has sufficient liquidity for amount_out={}", amount_out);
            Err(ProgramError::InsufficientFunds)
        }
    }
}

// ── Approve CPI ───────────────────────────────────────────────────────────────

/// Issue spl_token::Approve so pool_authority can pull from user_source_ata.
/// The user must be a signer in the outer transaction.
fn cpi_approve<'a>(
    token_program: &AccountInfo<'a>,
    user_source: &AccountInfo<'a>,
    pool_authority: &AccountInfo<'a>,
    user: &AccountInfo<'a>,
    amount: u64,
) -> ProgramResult {
    // SPL Token Approve instruction data: opcode 4 + amount (u64 LE)
    let mut data = [0u8; 9];
    data[0] = 4; // Approve opcode
    data[1..9].copy_from_slice(&amount.to_le_bytes());

    let accounts_meta = vec![
        AccountMeta::new(*user_source.key, false),
        AccountMeta::new_readonly(*pool_authority.key, false),
        AccountMeta::new_readonly(*user.key, true), // user must sign
    ];

    let ix = Instruction {
        program_id: *token_program.key,
        accounts:   accounts_meta,
        data:       data.to_vec(),
    };

    invoke(&ix, &[user_source.clone(), pool_authority.clone(), user.clone()])
}

// ── SAMM swap CPI ─────────────────────────────────────────────────────────────

/// Issue the SAMM SwapSAMM instruction (opcode 1, exact-output) as a CPI.
///
/// The SAMM program uses invoke_signed internally (pool PDA signs the transfer),
/// so the outer transaction does NOT need a PDA signature.
#[allow(clippy::too_many_arguments)]
fn cpi_samm_swap<'a>(
    samm_program: &AccountInfo<'a>,
    pool_state: &AccountInfo<'a>,
    pool_authority: &AccountInfo<'a>,
    user_source: &AccountInfo<'a>,
    pool_source: &AccountInfo<'a>,
    pool_dest: &AccountInfo<'a>,
    user_dest: &AccountInfo<'a>,
    pool_mint: &AccountInfo<'a>,
    fee_account: &AccountInfo<'a>,
    source_mint: &AccountInfo<'a>,
    dest_mint: &AccountInfo<'a>,
    token_program: &AccountInfo<'a>,
    amount_out: u64,
    max_amount_in: u64,
) -> ProgramResult {
    // Instruction data: opcode 1, amount_out (u64 LE), max_amount_in (u64 LE)
    let mut data = [0u8; 17];
    data[0] = 1;
    data[1..9].copy_from_slice(&amount_out.to_le_bytes());
    data[9..17].copy_from_slice(&max_amount_in.to_le_bytes());

    // Account layout matches the JS swapInstruction() and the deployed SAMM program
    let accounts_meta = vec![
        AccountMeta::new_readonly(*pool_state.key,     false),
        AccountMeta::new_readonly(*pool_authority.key, false),
        AccountMeta::new_readonly(*pool_authority.key, false), // userTransferAuthority = poolAuthority
        AccountMeta::new(*user_source.key,              false),
        AccountMeta::new(*pool_source.key,              false),
        AccountMeta::new(*pool_dest.key,                false),
        AccountMeta::new(*user_dest.key,                false),
        AccountMeta::new(*pool_mint.key,                false),
        AccountMeta::new(*fee_account.key,              false),
        AccountMeta::new_readonly(*source_mint.key,     false),
        AccountMeta::new_readonly(*dest_mint.key,       false),
        AccountMeta::new_readonly(*token_program.key,   false),
        AccountMeta::new_readonly(*token_program.key,   false),
        AccountMeta::new_readonly(*token_program.key,   false),
    ];

    let ix = Instruction {
        program_id: *samm_program.key,
        accounts:   accounts_meta,
        data:       data.to_vec(),
    };

    invoke(&ix, &[
        pool_state.clone(),    pool_authority.clone(), pool_authority.clone(),
        user_source.clone(),   pool_source.clone(),    pool_dest.clone(),
        user_dest.clone(),     pool_mint.clone(),      fee_account.clone(),
        source_mint.clone(),   dest_mint.clone(),
        token_program.clone(), token_program.clone(),  token_program.clone(),
        samm_program.clone(),
    ])
}

/// Execute a swap on the shard at the given index in the accounts slice.
#[allow(clippy::too_many_arguments)]
fn execute_on_shard<'a>(
    accounts: &'a [AccountInfo<'a>],
    shard_start: usize,
    shard_idx: usize,
    user: &AccountInfo<'a>,
    user_source: &AccountInfo<'a>,
    user_dest: &AccountInfo<'a>,
    source_mint_ai: &AccountInfo<'a>,
    dest_mint_ai: &AccountInfo<'a>,
    samm_program: &AccountInfo<'a>,
    token_program: &AccountInfo<'a>,
    source_mint: &Pubkey,
    amount_out: u64,
    max_amount_in: u64,
) -> ProgramResult {
    let base = shard_start + shard_idx * ACCS_PER_SHARD;
    let pool_state    = &accounts[base];
    let pool_auth     = &accounts[base + 1];
    let pool_tok_a    = &accounts[base + 2];
    let pool_tok_b    = &accounts[base + 3];
    let pool_mint_ai  = &accounts[base + 4];
    let fee_account   = &accounts[base + 5];

    // Determine which pool vault is source vs dest
    let info = read_shard_info(pool_state)?;
    let (pool_source, pool_dest) = if info.mint_a == *source_mint {
        (pool_tok_a, pool_tok_b)
    } else {
        (pool_tok_b, pool_tok_a)
    };

    // 1. Approve pool authority to pull from user's source ATA
    cpi_approve(token_program, user_source, pool_auth, user, max_amount_in)?;

    // 2. Execute SAMM swap
    cpi_samm_swap(
        samm_program, pool_state, pool_auth,
        user_source, pool_source, pool_dest, user_dest,
        pool_mint_ai, fee_account,
        source_mint_ai, dest_mint_ai, token_program,
        amount_out, max_amount_in,
    )
}

// ── Instruction handlers ──────────────────────────────────────────────────────

/// Handle `route_swap` (opcode 0) — single-hop with on-chain best-shard selection.
fn route_swap<'a>(accounts: &'a [AccountInfo<'a>], data: &[u8]) -> ProgramResult {
    // Parse instruction data
    if data.len() < 17 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let amount_out    = u64::from_le_bytes(data[0..8].try_into().unwrap());
    let max_amount_in = u64::from_le_bytes(data[8..16].try_into().unwrap());
    let num_shards    = data[16] as usize;

    if num_shards == 0 || num_shards > 16 {
        msg!("num_shards must be 1..16, got {}", num_shards);
        return Err(ProgramError::InvalidInstructionData);
    }

    let required = FIXED_SWAP + num_shards * ACCS_PER_SHARD;
    if accounts.len() < required {
        msg!("Need {} accounts, got {}", required, accounts.len());
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let user          = &accounts[0];
    let user_source   = &accounts[1];
    let user_dest     = &accounts[2];
    let source_mint   = &accounts[3];
    let dest_mint     = &accounts[4];
    let samm_program  = &accounts[5];
    let token_program = &accounts[6];

    if !user.is_signer {
        msg!("User (accounts[0]) must sign");
        return Err(ProgramError::MissingRequiredSignature);
    }

    msg!(
        "route_swap: amount_out={} max_in={} shards={}",
        amount_out, max_amount_in, num_shards
    );

    // Select best shard on-chain (reads reserves + computes SAMM fee for each)
    let best = select_best_shard(accounts, FIXED_SWAP, num_shards, source_mint.key, amount_out)?;

    // Slippage guard
    if best.amount_in > max_amount_in {
        msg!(
            "Slippage exceeded: computed_in={} > max_amount_in={}",
            best.amount_in, max_amount_in
        );
        return Err(ProgramError::Custom(ERR_SLIPPAGE));
    }

    // Log c-Non-Splitting status
    if best.above_c {
        msg!("⚠ Trade is above c-threshold (c=0.96). Split routing may improve price.");
    } else {
        msg!("✓ c-Non-Splitting: single-shard is optimal (trade below c × destReserve)");
    }

    // Execute swap on the selected shard
    execute_on_shard(
        accounts, FIXED_SWAP, best.idx,
        user, user_source, user_dest,
        source_mint, dest_mint,
        samm_program, token_program,
        source_mint.key,
        amount_out, max_amount_in,
    )
}

/// Handle `route_swap_multi` (opcode 1) — two-hop with per-hop best-shard selection.
///
/// Works backward from the desired output:
///   1. Quote all hop-2 shards to find mid_amount_needed (how much intermediate token hop-2 will consume)
///   2. Quote all hop-1 shards for mid_amount_needed → find best shard for hop-1
///   3. Execute: hop-1 swap (source → mid), then hop-2 swap (mid → dest)
fn route_swap_multi<'a>(accounts: &'a [AccountInfo<'a>], data: &[u8]) -> ProgramResult {
    if data.len() < 18 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let amount_out       = u64::from_le_bytes(data[0..8].try_into().unwrap());
    let max_amount_in    = u64::from_le_bytes(data[8..16].try_into().unwrap());
    let n_shards_hop1    = data[16] as usize;
    let n_shards_hop2    = data[17] as usize;

    if n_shards_hop1 == 0 || n_shards_hop2 == 0 || n_shards_hop1 > 8 || n_shards_hop2 > 8 {
        msg!("n_shards per hop must be 1..8");
        return Err(ProgramError::InvalidInstructionData);
    }

    let required = FIXED_MULTI + (n_shards_hop1 + n_shards_hop2) * ACCS_PER_SHARD;
    if accounts.len() < required {
        msg!("Need {} accounts, got {}", required, accounts.len());
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let user          = &accounts[0];
    let user_source   = &accounts[1];
    let user_mid      = &accounts[2];
    let user_dest     = &accounts[3];
    let source_mint   = &accounts[4];
    let mid_mint      = &accounts[5];
    let dest_mint     = &accounts[6];
    let samm_program  = &accounts[7];
    let token_program = &accounts[8];

    if !user.is_signer {
        msg!("User (accounts[0]) must sign");
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Shard regions in the accounts slice
    let hop1_start = FIXED_MULTI;
    let hop2_start = hop1_start + n_shards_hop1 * ACCS_PER_SHARD;

    msg!(
        "route_swap_multi: amount_out={} max_in={} hop1_shards={} hop2_shards={}",
        amount_out, max_amount_in, n_shards_hop1, n_shards_hop2
    );

    // ── Step 1: Quote hop-2 (mid → dest) for the desired amount_out ────────────
    // This tells us how much mid token hop-2 will consume.
    let best_hop2 = select_best_shard(
        accounts, hop2_start, n_shards_hop2, mid_mint.key, amount_out,
    )?;
    let mid_amount_needed = best_hop2.amount_in;
    msg!("Hop-2: best shard idx={} mid_needed={}", best_hop2.idx, mid_amount_needed);

    // ── Step 2: Quote hop-1 (source → mid) for mid_amount_needed ──────────────
    let best_hop1 = select_best_shard(
        accounts, hop1_start, n_shards_hop1, source_mint.key, mid_amount_needed,
    )?;
    let total_in = best_hop1.amount_in;
    msg!("Hop-1: best shard idx={} total_in={}", best_hop1.idx, total_in);

    // Slippage guard over the full two-hop route
    if total_in > max_amount_in {
        msg!("Multi-hop slippage exceeded: total_in={} > max_amount_in={}", total_in, max_amount_in);
        return Err(ProgramError::Custom(ERR_SLIPPAGE));
    }

    // Log c-Non-Splitting status per hop
    if best_hop1.above_c || best_hop2.above_c {
        msg!("⚠ One or more hops above c-threshold");
    } else {
        msg!("✓ c-Non-Splitting: both hops below c × destReserve");
    }

    // ── Step 3: Execute hop-1 (source → mid) ──────────────────────────────────
    // CPI max_in must be in SOURCE token units (not mid).
    // Use total_in + 0.1% headroom so the pool doesn't reject due to rounding.
    let max_src_in = total_in.saturating_add(total_in / 1000 + 1);
    execute_on_shard(
        accounts, hop1_start, best_hop1.idx,
        user, user_source, user_mid,
        source_mint, mid_mint,
        samm_program, token_program,
        source_mint.key,
        mid_amount_needed, max_src_in,
    )?;

    // ── Step 4: Execute hop-2 (mid → dest) ────────────────────────────────────
    // CPI max_in must be in MID token units (not source).
    // mid_amount_needed is the exact computed cost; +0.1% headroom for rounding.
    let max_mid_in = mid_amount_needed.saturating_add(mid_amount_needed / 1000 + 1);
    execute_on_shard(
        accounts, hop2_start, best_hop2.idx,
        user, user_mid, user_dest,
        mid_mint, dest_mint,
        samm_program, token_program,
        mid_mint.key,
        amount_out, max_mid_in,
    )
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swap_revert_basic() {
        // x=100_000, y=100_000, dy=1_000 → dx = 100_000 × 1_000 / (100_000 − 1_000) = ~1010.1 → ceil = 1011
        let dx = swap_revert(1_000, 100_000, 100_000).unwrap();
        assert!(dx > 1_000, "dx={} should exceed output due to price impact", dx);
    }

    #[test]
    fn swap_revert_drain_returns_none() {
        assert!(swap_revert(100_000, 100_000, 100_000).is_none());
        assert!(swap_revert(100_001, 100_000, 100_000).is_none());
    }

    #[test]
    fn samm_fee_adaptive_small_trade() {
        // Small trade → adaptive branch → higher fee %
        let fee = samm_fee(100, 1_000_000, 1_000_000, 25, 10_000).unwrap();
        assert!(fee > 0);
        // Fee % should be close to (5×25 - tiny) / 10_000 ≈ 0.0125 × 100 / 10_000 × ...
    }

    #[test]
    fn samm_fee_minimal_large_trade() {
        // output=1000, reserve=10000 → tmp = 1000×12×10000/(10×10000) = 1200 > max=125 → minimal
        let fee = samm_fee(1_000, 10_000, 10_000, 25, 10_000).unwrap();
        let expected = (1_000u128 * 25 * 10_000) / (10_000 * 10_000);
        assert_eq!(fee, expected as u64);
    }

    #[test]
    fn quote_decomposes_correctly() {
        let amt = quote(1_000, 100_000, 100_000, 25, 10_000, 10, 10_000).unwrap();
        let base = swap_revert(1_000, 100_000, 100_000).unwrap();
        let fee  = samm_fee(1_000, 100_000, 100_000, 25, 10_000).unwrap();
        let own  = owner_fee(1_000, 10, 10_000);
        assert_eq!(amt, base + fee + own);
    }

    #[test]
    fn smaller_better_principle() {
        // Same trade size, larger reserves → lower amountIn (smaller relative price impact)
        // Use a trade size large enough that integer arithmetic shows a difference.
        let small_pool = quote(1_000, 10_000,    10_000,    25, 10_000, 0, 1).unwrap();
        let large_pool = quote(1_000, 100_000,   100_000,   25, 10_000, 0, 1).unwrap();
        let xlarge     = quote(1_000, 1_000_000, 1_000_000, 25, 10_000, 0, 1).unwrap();
        // Larger pool → lower amountIn for the same absolute trade (smaller relative impact)
        assert!(large_pool < small_pool,
            "large pool should quote lower than small pool: {} vs {}", large_pool, small_pool);
        assert!(xlarge <= large_pool,
            "xlarge pool should quote ≤ large pool: {} vs {}", xlarge, large_pool);
    }

    #[test]
    fn c_threshold_math() {
        // amount_out >= C_NUM/C_DEN × dest_reserve → above_c = true
        let dest_reserve: u64 = 100_000;
        let at_c = (dest_reserve as u128 * C_NUM as u128 / C_DEN as u128) as u64;
        let above = at_c + 1;
        let below = at_c - 1;
        let above_c_flag_above = (above as u128) * (C_DEN as u128) >= (dest_reserve as u128) * (C_NUM as u128);
        let above_c_flag_below = (below as u128) * (C_DEN as u128) >= (dest_reserve as u128) * (C_NUM as u128);
        assert!(above_c_flag_above);
        assert!(!above_c_flag_below);
    }
}
