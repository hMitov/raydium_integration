use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};
use raydium_amm_v3::{
    cpi,
    program::AmmV3,
    states::{
        AmmConfig, ObservationState, PoolState, TickArrayState,
    }
};

declare_id!("FNTPyRGBAC1vdEB7N4PDST2At8ACyc8aSZks1znvVNeZ");

pub const DEFAULT_SLIPPAGE_BPS: u16 = 500;

#[program]
pub mod raydium_integration {
    use super::*;

    pub fn set_slippage(ctx: Context<SetSlippage>, bps: u16) -> Result<()> {
        require!(bps <= 500, CustomError::InvalidSlippage); // Max 20%
        let user = &mut ctx.accounts.user_cfg;
        user.owner = ctx.accounts.owner.key();
        user.slippage_bps = bps;
        Ok(())
    }

    pub fn proxy_swap(
        ctx: Context<ProxySwap>,
        amount: u64,
        expected_other_amount: u64,
        sqrt_price_limit_x64: u128,
        is_base_input: bool,
    ) -> Result<()> {
        let user_cfg = &ctx.accounts.user_cfg;

        let bps = if user_cfg.slippage_bps == 0 {
            DEFAULT_SLIPPAGE_BPS
        } else {
            user_cfg.slippage_bps
        };

        let threshold = compute_slippage_threshold(expected_other_amount, bps, is_base_input);

        msg!(
            "Swap | amount: {}, expected_other: {}, threshold: {}, slippage_bps: {}, is_base_input: {}",
            amount,
            expected_other_amount,
            threshold,
            bps,
            is_base_input
        );

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
        let cpi_context = CpiContext::new(
            ctx.accounts.clmm_program.to_account_info(),
            cpi_accounts
        );
        cpi::swap(
            cpi_context,
            amount,
            threshold,
            sqrt_price_limit_x64,
            is_base_input,
        )
    }
}

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
    /// The user performing the swap
    pub payer: Signer<'info>,

    #[account(
        seeds = [b"user_cfg", payer.key().as_ref()],
        bump
    )]
    pub user_cfg: Account<'info, UserConfig>,

    /// The factory state to read protocol fees
    #[account(address = pool_state.load()?.amm_config)]
    pub amm_config: Box<Account<'info, AmmConfig>>,

    /// The program account of the pool in which the swap will be performed
    #[account(mut)]
    pub pool_state: AccountLoader<'info, PoolState>,

    /// The user token account for input token
    #[account(mut)]
    pub input_token_account: Box<Account<'info, TokenAccount>>,

    /// The user token account for output token
    #[account(mut)]
    pub output_token_account: Box<Account<'info, TokenAccount>>,

    /// The vault token account for input token
    #[account(mut)]
    pub input_vault: Box<Account<'info, TokenAccount>>,

    /// The vault token account for output token
    #[account(mut)]
    pub output_vault: Box<Account<'info, TokenAccount>>,

    /// The program account for the most recent oracle observation
    #[account(mut, address = pool_state.load()?.observation_key)]
    pub observation_state: AccountLoader<'info, ObservationState>,

    /// SPL program for token transfers
    pub token_program: Program<'info, Token>,

    /// The tick array account for the swap
    #[account(mut, constraint = tick_array.load()?.pool_id == pool_state.key())]
    pub tick_array: AccountLoader<'info, TickArrayState>,
}

#[account]
pub struct UserConfig {
    pub owner: Pubkey,
    pub slippage_bps: u16,
}
impl UserConfig {
    pub const SIZE: usize = 32 + 2;
}


fn compute_slippage_threshold(expected: u64, bps: u16, is_base_input: bool) -> u64 {
    if is_base_input {
        // minimum output = expected * (1 - bps / 10_000)
        ((expected as u128 * (10_000u128 - bps as u128)) / 10_000u128) as u64
    } else {
        // maximum input = expected * (1 + bps / 10_000)
        ((expected as u128 * (10_000u128 + bps as u128)) / 10_000u128) as u64
    }
}

#[error_code]
pub enum CustomError {
    #[msg("Invalid slippage basis points")]
    InvalidSlippage,
}