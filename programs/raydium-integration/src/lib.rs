use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::metadata::Metadata;
use anchor_spl::token::Token;
use anchor_spl::token_interface::{Mint, Token2022, TokenAccount};
use raydium_amm_v3::{
    cpi,
    program::AmmV3,
    states::{
        AmmConfig, ObservationState, PoolState, TickArrayState, POSITION_SEED, TICK_ARRAY_SEED,
    },
};

declare_id!("CrMxnHJvvk2eRP8H1DLtc2ZTQfzD9NSxJKkDquCzr1Qu");

pub const DEFAULT_SLIPPAGE_BPS: u16 = 500;

#[program]
pub mod raydium_integration {
    use super::*;

    /*
     * Set slippage for a user, default is 5%
     */
    pub fn set_slippage(ctx: Context<SetSlippage>, bps: u16) -> Result<()> {
        require!(bps > 0, CustomError::InvalidSlippage);
        require!(bps <= 500, CustomError::InvalidSlippage);
        let user = &mut ctx.accounts.user_cfg;
        user.owner = ctx.accounts.owner.key();
        user.slippage_bps = bps;

        emit!(SlippageSet {
            owner: ctx.accounts.owner.key(),
            slippage_bps: bps,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /*
     * Swap tokens using Raydium CLMM, exact in or out
     */
    pub fn proxy_swap(
        ctx: Context<ProxySwap>,
        amount: u64,
        expected_other_amount: u64,
        sqrt_price_limit_x64: u128,
        is_base_input: bool,
    ) -> Result<()> {
        require!(amount > 0, CustomError::ZeroSwapAmount);
        require!(
            expected_other_amount > 0,
            CustomError::InvalidExpectedAmount
        );

        let user_cfg = &ctx.accounts.user_cfg;
        let bps = if user_cfg.slippage_bps == 0 {
            DEFAULT_SLIPPAGE_BPS
        } else {
            user_cfg.slippage_bps
        };

        require!(bps > 0 && bps <= 500, CustomError::InvalidSlippage);

        let threshold = compute_slippage_threshold(expected_other_amount, bps, is_base_input);

        msg!(
            "Swap | amount: {}, expected_other: {}, threshold: {}, slippage_bps: {}, is_base_input: {}",
            amount,
            expected_other_amount,
            threshold,
            bps,
            is_base_input
        );

        // Build CPI to Raydium AMM v3
        let cpi_accounts = cpi::accounts::SwapSingle {
            payer: ctx.accounts.payer.to_account_info(),
            amm_config: ctx.accounts.amm_config.to_account_info(),
            pool_state: ctx.accounts.pool_state.to_account_info(),
            input_token_account: ctx.accounts.input_token_account.to_account_info(),
            output_token_account: ctx.accounts.output_token_account.to_account_info(),
            input_vault: ctx.accounts.input_vault.to_account_info(),
            output_vault: ctx.accounts.output_vault.to_account_info(),
            observation_state: ctx.accounts.observation_state.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
            tick_array: ctx.accounts.tick_array.to_account_info(),
        };

        // Build CPI context
        let cpi_context =
            CpiContext::new(ctx.accounts.clmm_program.to_account_info(), cpi_accounts);
        cpi::swap(
            cpi_context,
            amount,
            threshold,
            sqrt_price_limit_x64,
            is_base_input,
        )?;

        emit!(SwapExecuted {
            user: ctx.accounts.payer.key(),
            pool: ctx.accounts.pool_state.key(),
            amount_in: amount,
            amount_out: expected_other_amount,
            expected_amount: expected_other_amount,
            slippage_bps: bps,
            is_base_input,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /*
     * Open a position using Raydium CLMM,
     */
    pub fn proxy_open_position<'a, 'b, 'c: 'info, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, ProxyOpenPosition<'info>>,
        tick_lower_index: i32,
        tick_upper_index: i32,
        tick_array_lower_start_index: i32,
        tick_array_upper_start_index: i32,
        liquidity: u128,
        amount_0_max: u64,
        amount_1_max: u64,
        with_matedata: bool,
        base_flag: Option<bool>,
    ) -> Result<()> {
        require!(
            tick_lower_index < tick_upper_index,
            CustomError::InvalidTickRange
        );
        require!(liquidity > 0, CustomError::ZeroLiquidity);
        require!(
            amount_0_max > 0 || amount_1_max > 0,
            CustomError::ZeroDeposit
        );

        // Build CPI accounts
        let cpi_accounts = cpi::accounts::OpenPositionV2 {
            payer: ctx.accounts.payer.to_account_info(),
            position_nft_owner: ctx.accounts.position_nft_owner.to_account_info(),
            position_nft_mint: ctx.accounts.position_nft_mint.to_account_info(),
            position_nft_account: ctx.accounts.position_nft_account.to_account_info(),
            metadata_account: ctx.accounts.metadata_account.to_account_info(),
            pool_state: ctx.accounts.pool_state.to_account_info(),
            protocol_position: ctx.accounts.protocol_position.to_account_info(),
            tick_array_lower: ctx.accounts.tick_array_lower.to_account_info(),
            tick_array_upper: ctx.accounts.tick_array_upper.to_account_info(),
            personal_position: ctx.accounts.personal_position.to_account_info(),
            token_account_0: ctx.accounts.token_account_0.to_account_info(),
            token_account_1: ctx.accounts.token_account_1.to_account_info(),
            token_vault_0: ctx.accounts.token_vault_0.to_account_info(),
            token_vault_1: ctx.accounts.token_vault_1.to_account_info(),
            rent: ctx.accounts.rent.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
            associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
            metadata_program: ctx.accounts.metadata_program.to_account_info(),
            token_program_2022: ctx.accounts.token_program_2022.to_account_info(),
            vault_0_mint: ctx.accounts.vault_0_mint.to_account_info(),
            vault_1_mint: ctx.accounts.vault_1_mint.to_account_info(),
        };

        // Build CPI context
        let cpi_context =
            CpiContext::new(ctx.accounts.clmm_program.to_account_info(), cpi_accounts)
                .with_remaining_accounts(ctx.remaining_accounts.to_vec());

        // Execute CPI
        cpi::open_position_v2(
            cpi_context,
            tick_lower_index,
            tick_upper_index,
            tick_array_lower_start_index,
            tick_array_upper_start_index,
            liquidity,
            amount_0_max,
            amount_1_max,
            with_matedata,
            base_flag,
        )?;

        emit!(PositionOpened {
            user: ctx.accounts.payer.key(),
            pool: ctx.accounts.pool_state.key(),
            position_nft: ctx.accounts.position_nft_mint.key(),
            tick_lower: tick_lower_index,
            tick_upper: tick_upper_index,
            liquidity,
            amount_0: amount_0_max,
            amount_1: amount_1_max,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

/*
 * ACCOUNT STRUCTS
 */

#[derive(Accounts)]
pub struct SetSlippage<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + UserConfig::SIZE,
        seeds = [b"user_cfg", owner.key().as_ref()],
        bump
    )]
    pub user_cfg: Account<'info, UserConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ProxySwap<'info> {
    pub clmm_program: Program<'info, AmmV3>,
    pub payer: Signer<'info>,

    #[account(
        seeds = [b"user_cfg", payer.key().as_ref()],
        bump
    )]
    pub user_cfg: Account<'info, UserConfig>,

    #[account(address = pool_state.load()?.amm_config)]
    pub amm_config: Box<Account<'info, AmmConfig>>,

    #[account(mut)]
    pub pool_state: AccountLoader<'info, PoolState>,

    #[account(mut)]
    pub input_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub output_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub input_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub output_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut, address = pool_state.load()?.observation_key)]
    pub observation_state: AccountLoader<'info, ObservationState>,

    pub token_program: Program<'info, Token>,

    #[account(mut, constraint = tick_array.load()?.pool_id == pool_state.key())]
    pub tick_array: AccountLoader<'info, TickArrayState>,
}

#[derive(Accounts)]
#[instruction(tick_lower_index: i32, tick_upper_index: i32,tick_array_lower_start_index:i32,tick_array_upper_start_index:i32)]
pub struct ProxyOpenPosition<'info> {
    pub clmm_program: Program<'info, AmmV3>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Receives the position NFT
    pub position_nft_owner: UncheckedAccount<'info>,

    #[account(mut)]
    pub position_nft_mint: Signer<'info>,

    /// CHECK: Token account where position NFT will be minted
    #[account(mut)]
    pub position_nft_account: UncheckedAccount<'info>,

    /// CHECK: To store metaplex metadata
    #[account(mut)]
    pub metadata_account: UncheckedAccount<'info>,

    #[account(mut)]
    pub pool_state: AccountLoader<'info, PoolState>,

    /// CHECK: Safety check performed inside function body
    #[account(
        mut,
        seeds = [
            POSITION_SEED.as_bytes(),
            pool_state.key().as_ref(),
            &tick_lower_index.to_be_bytes(),
            &tick_upper_index.to_be_bytes(),
        ],
        seeds::program = clmm_program,
        bump,
    )]
    pub protocol_position: UncheckedAccount<'info>,

    /// CHECK: Account to mark the lower tick as initialized
    #[account(
        mut,
        seeds = [
            TICK_ARRAY_SEED.as_bytes(),
            pool_state.key().as_ref(),
            &tick_array_lower_start_index.to_be_bytes(),
        ],
        seeds::program = clmm_program,
        bump,
    )]
    pub tick_array_lower: UncheckedAccount<'info>,

    /// CHECK: Account to store data for the position's upper tick
    #[account(
        mut,
        seeds = [
            TICK_ARRAY_SEED.as_bytes(),
            pool_state.key().as_ref(),
            &tick_array_upper_start_index.to_be_bytes(),
        ],
        seeds::program = clmm_program,
        bump,
    )]
    pub tick_array_upper: UncheckedAccount<'info>,

    /// CHECK: personal position state
    #[account(
        mut,
        seeds = [POSITION_SEED.as_bytes(), position_nft_mint.key().as_ref()],
        bump,
        seeds::program = clmm_program,
    )]
    pub personal_position: UncheckedAccount<'info>,

    #[account(
        mut,
        token::mint = token_vault_0.mint
    )]
    pub token_account_0: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = token_vault_1.mint
    )]
    pub token_account_1: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = token_vault_0.key() == pool_state.load()?.token_vault_0
    )]
    pub token_vault_0: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = token_vault_1.key() == pool_state.load()?.token_vault_1
    )]
    pub token_vault_1: Box<InterfaceAccount<'info, TokenAccount>>,

    pub rent: Sysvar<'info, Rent>,

    pub system_program: Program<'info, System>,

    pub token_program: Program<'info, Token>,

    pub associated_token_program: Program<'info, AssociatedToken>,

    pub metadata_program: Program<'info, Metadata>,

    pub token_program_2022: Program<'info, Token2022>,

    #[account(
        address = token_vault_0.mint
    )]
    pub vault_0_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        address = token_vault_1.mint
    )]
    pub vault_1_mint: Box<InterfaceAccount<'info, Mint>>,
}

/*
 * State and helpers
 */
#[account]
pub struct UserConfig {
    pub owner: Pubkey,
    pub slippage_bps: u16,
}
impl UserConfig {
    pub const SIZE: usize = 32 + 2;
}

/*
 * Compute slippage tolerance threshold (min output / max input)
 */
fn compute_slippage_threshold(expected: u64, bps: u16, is_base_input: bool) -> u64 {
    if is_base_input {
        ((expected as u128 * (10_000u128 - bps as u128)) / 10_000u128) as u64
    } else {
        ((expected as u128 * (10_000u128 + bps as u128)) / 10_000u128) as u64
    }
}

/*
 * Error codes
 */
#[error_code]
pub enum CustomError {
    #[msg("Invalid slippage basis points")]
    InvalidSlippage,

    #[msg("Invalid tick range")]
    InvalidTickRange,

    #[msg("Zero liquidity")]
    ZeroLiquidity,

    #[msg("Zero deposit")]
    ZeroDeposit,

    #[msg("Invalid vault")]
    InvalidVault,

    #[msg("Zero swap amount")]
    ZeroSwapAmount,

    #[msg("Invalid expected amount")]
    InvalidExpectedAmount,
}

#[event]
pub struct SlippageSet {
    pub owner: Pubkey,
    pub slippage_bps: u16,
    pub timestamp: i64,
}

#[event]
pub struct SwapExecuted {
    pub user: Pubkey,
    pub pool: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
    pub expected_amount: u64,
    pub slippage_bps: u16,
    pub is_base_input: bool,
    pub timestamp: i64,
}

#[event]
pub struct PositionOpened {
    pub user: Pubkey,
    pub pool: Pubkey,
    pub position_nft: Pubkey,
    pub tick_lower: i32,
    pub tick_upper: i32,
    pub liquidity: u128,
    pub amount_0: u64,
    pub amount_1: u64,
    pub timestamp: i64,
}

#[event]
pub struct LiquidityIncreased {
    pub user: Pubkey,
    pub position_nft: Pubkey,
    pub liquidity_added: u128,
    pub amount_0_added: u64,
    pub amount_1_added: u64,
    pub timestamp: i64,
}

#[event]
pub struct LiquidityDecreased {
    pub user: Pubkey,
    pub position_nft: Pubkey,
    pub liquidity_removed: u128,
    pub amount_0_removed: u64,
    pub amount_1_removed: u64,
    pub timestamp: i64,
}
