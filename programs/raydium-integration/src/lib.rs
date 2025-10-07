use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};
use raydium_amm_v3::{
    cpi,
    program::AmmV3,
    states::{AmmConfig, ObservationState, PoolState, TickArrayState},
};

declare_id!("FNTPyRGBAC1vdEB7N4PDST2At8ACyc8aSZks1znvVNeZ");

/// Memo msg for swap
pub const SWAP_MEMO_MSG: &'static [u8] = b"raydium_swap";
#[derive(Accounts)]
pub struct ProxySwap<'info> {
    pub clmm_program: Program<'info, AmmV3>,
    /// The user performing the swap
    pub payer: Signer<'info>,

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

#[program]
pub mod raydium_integration {
    use super::*;

    pub fn proxy_swap(
        ctx: Context<ProxySwap>,
        amount: u64,
        other_amount_threshold: u64,
        sqrt_price_limit_x64: u128,
        is_base_input: bool,
    ) -> Result<()> {
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
            other_amount_threshold,
            sqrt_price_limit_x64,
            is_base_input,
        )
    }
}