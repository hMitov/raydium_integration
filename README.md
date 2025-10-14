# Raydium Integration

[![Surfpool](https://img.shields.io/badge/Operated%20with-Surfpool-green?labelColor=gray)](https://surfpool.run)

A Solana program that provides a simplified interface for interacting with Raydium's Concentrated Liquidity Market Maker (CLMM) protocol. This integration allows users to perform swaps and manage liquidity positions through a clean, event-driven API.

## Features

- **Token Swapping**: Execute exact-in and exact-out swaps through Raydium CLMM pools
- **Liquidity Management**: Create, increase, and decrease liquidity positions
- **Slippage Control**: Configurable slippage tolerance per user
- **Event Logging**: Comprehensive event emission for analytics and monitoring
- **Surfpool Integration**: Full support for Surfpool development workflow

## Architecture

### Program ID
```
EgVzMskheVJTgMRuWRxfxae9JjfA8Ernjx77NgGHoNzT
```

### Core Functions

#### 1. `set_slippage`
Set slippage tolerance for a user (0-500 basis points, default: 500 = 5%)

```rust
pub fn set_slippage(ctx: Context<SetSlippage>, bps: u16) -> Result<()>
```

#### 2. `proxy_swap`
Execute token swaps through Raydium CLMM pools

```rust
pub fn proxy_swap(
    ctx: Context<ProxySwap>,
    amount: u64,
    expected_other_amount: u64,
    sqrt_price_limit_x64: u128,
    is_base_input: bool,
) -> Result<()>
```

#### 3. `proxy_open_position`
Create new liquidity positions in Raydium pools

```rust
pub fn proxy_open_position(
    ctx: Context<ProxyOpenPosition>,
    tick_lower_index: i32,
    tick_upper_index: i32,
    tick_array_lower_start_index: i32,
    tick_array_upper_start_index: i32,
    liquidity: u128,
    amount_0_max: u64,
    amount_1_max: u64,
    with_metadata: bool,
    base_flag: Option<bool>,
) -> Result<()>
```

## Events

The program emits comprehensive events for monitoring and analytics:

### `SlippageSet`
Emitted when a user sets their slippage tolerance
```rust
pub struct SlippageSet {
    pub owner: Pubkey,
    pub slippage_bps: u16,
    pub timestamp: i64,
}
```

### `SwapExecuted`
Emitted when a swap is executed
```rust
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
```

### `PositionOpened`
Emitted when a new liquidity position is created
```rust
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
```

## Development with Surfpool

This project uses [Surfpool](https://surfpool.run) for enhanced Solana development workflow.

### Installation

Install Surfpool:

```bash
# macOS (Homebrew)
brew install txtx/taps/surfpool

# Linux (Snap Store)
snap install surfpool

# Or build from source
git clone https://github.com/hMitov/raydium_integration.git
cd surfpool
cargo surfpool-install
```

### Surfpool Workflow

#### 1. Start a Surfnet
```bash
# Start a local validator with mainnet fork
surfpool start

# Start with auto-redeploy on code changes
surfpool start --watch
```

#### 2. Deploy the Program
```bash
# Deploy using runbooks
surfpool run deployment

# Or deploy manually
anchor build
anchor deploy
```

#### 3. Run Tests
```bash
# Run tests on Surfnet
anchor test

# Or run specific test files
yarn test tests/raydium-integration.test.ts
```

### Surfpool Features Used

- **Surfnet**: Local validator with mainnet fork for realistic testing
- **Runbooks**: Infrastructure as code for deployments
- **Surfpool Studio**: Web UI for transaction introspection

## Setup

### Prerequisites

- Node.js 18+
- Rust 1.70+
- Solana CLI 1.17+
- Anchor Framework 0.31+
- Surfpool (for enhanced development)

### Installation

```bash
# Clone the repository
git clone <repository-url>
cd raydium-integration

# Install dependencies
yarn install

# Install Rust dependencies
cargo build
```

### Configuration

1. **Set up Solana CLI**:
```bash
solana config set --url localhost
solana-keygen new --outfile ~/.config/solana/id.json
```

2. **Configure Anchor**:
The project is configured for localnet by default. Update `Anchor.toml` for different networks:

```toml
[provider]
cluster = "localnet"  # or "devnet", "mainnet"
wallet = "~/.config/solana/id.json"
```

## Usage

### Basic Swap Example

```typescript
import { Program } from "@coral-xyz/anchor";
import { RaydiumIntegration } from "./target/types/raydium_integration";

// Set slippage (3%)
await program.methods
  .setSlippage(300)
  .accountsStrict({
    owner: wallet,
    userCfg: USER_CFG,
    systemProgram: SystemProgram.programId,
  })
  .rpc();

// Execute swap
await program.methods
  .proxySwap(
    amountIn,           // Input amount
    expectedOut,       // Expected output
    sqrtPriceLimitX64, // Price limit (0 = no limit)
    true               // is_base_input
  )
  .accountsStrict({
    clmmProgram: CLMM_PROGRAM,
    payer: wallet,
    userCfg: USER_CFG,
    ammConfig: AMM_CONFIG,
    poolState: POOL_STATE,
    inputTokenAccount: inputAta,
    outputTokenAccount: outputAta,
    inputVault: INPUT_VAULT,
    outputVault: OUTPUT_VAULT,
    observationState: OBSERVATION_STATE,
    tokenProgram: TOKEN_PROGRAM_ID,
    tickArray: tickArrayAddr,
  })
  .rpc();
```

### Creating a Position

```typescript
// Create new liquidity position
await program.methods
  .proxyOpenPosition(
    tickLower,         // Lower tick
    tickUpper,         // Upper tick
    tickArrayLowerStartIndex,
    tickArrayUpperStartIndex,
    liquidity,         // Liquidity amount
    amount0Max,       // Max token 0 amount
    amount1Max,       // Max token 1 amount
    true,             // With metadata
    null              // Base flag
  )
  .accountsStrict({
    clmmProgram: CLMM_PROGRAM,
    payer: wallet,
    positionNftOwner: wallet,
    positionNftMint: positionNftMint.publicKey,
    positionNftAccount: positionNftAccount,
    metadataAccount: metadataAccount,
    poolState: poolId,
    protocolPosition: protocolPosition,
    tickArrayLower: tickArrayLower,
    tickArrayUpper: tickArrayUpper,
    personalPosition: personalPosition,
    tokenAccount0: tokenAccount0,
    tokenAccount1: tokenAccount1,
    tokenVault0: tokenVault0,
    tokenVault1: tokenVault1,
    rent: SYSVAR_RENT_PUBKEY,
    systemProgram: SystemProgram.programId,
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    metadataProgram: METADATA_PROGRAM_ID,
    tokenProgram2022: TOKEN_2022_PROGRAM_ID,
    vault0Mint: vault0Mint,
    vault1Mint: vault1Mint,
  })
  .rpc();
```

## Testing

### Running Tests

```bash
# Run all tests
anchor test

# Run specific test file
yarn test tests/raydium-integration.test.ts

# Run with Surfpool
surfpool start --watch
```

### Test Structure

- **Unit Tests**: Test individual program functions
- **Integration Tests**: Test full swap and liquidity workflows
- **Surfpool Tests**: Test with mainnet fork for realistic scenarios

## Deployment

### Local Development

```bash
# Start Surfnet
surfpool start

# Deploy program
surfpool run deployment

# Or use Anchor
anchor build
anchor deploy
```

### Production Deployment

1. **Build the program**:
```bash
anchor build --release
```

2. **Deploy to devnet**:
```bash
solana config set --url devnet
anchor deploy
```

3. **Deploy to mainnet**:
```bash
solana config set --url mainnet
anchor deploy
```

## Project Structure

```
raydium-integration/
├── programs/
│   └── raydium-integration/
│       └── src/
│           └── lib.rs              # Main program logic
├── tests/
│   ├── raydium-integration.test.ts # Test suite
│   └── utils/
│       └── swap-utils.ts           # Utility functions
├── runbooks/
│   └── deployment/
│       └── main.tx                 # Surfpool deployment runbook
├── clients/
│   └── src/
│       └── js/
│           └── generated/          # Generated TypeScript client
├── Anchor.toml                     # Anchor configuration
├── codama.json                     # Code generation config
└── package.json                    # Node.js dependencies
```

## Dependencies

### Rust Dependencies
- `anchor-lang`: Anchor framework
- `anchor-spl`: SPL token integration
- `raydium-amm-v3`: Raydium AMM v3 integration

### TypeScript Dependencies
- `@coral-xyz/anchor`: Anchor TypeScript client
- `@raydium-io/raydium-sdk-v2`: Raydium SDK
- `@solana/web3.js`: Solana Web3.js
- `@solana/spl-token`: SPL token utilities

## Error Handling

The program includes comprehensive error handling:

```rust
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
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Run the test suite
6. Submit a pull request

## License

This project is licensed under the ISC License.

## Resources

- [Surfpool Documentation](https://docs.surfpool.run)
- [Anchor Framework](https://www.anchor-lang.com/)
- [Raydium SDK](https://github.com/raydium-io/raydium-sdk-v2)
- [Solana Documentation](https://docs.solana.com/)

## Support

For questions and support:
- Create an issue in this repository
- Join the [Surfpool Discord](https://discord.gg/surfpool)
- Check the [Surfpool 101 Series](https://www.youtube.com/playlist?list=PL0FMgRjJMRzO1FdunpMS-aUS4GNkgyr3T)
