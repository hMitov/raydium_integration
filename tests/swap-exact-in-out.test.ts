import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAccount,
} from "@solana/spl-token";
import { RaydiumIntegration } from "../target/types/raydium_integration";
import { ensureTokenAccount, wrapSolToWsol, findOptimalPool } from "./utils/swap-utils";
import { expect } from "chai";
import { TickUtils, getPdaTickArrayAddress } from "@raydium-io/raydium-sdk-v2";

describe("raydium_integration_swaps", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.RaydiumIntegration as Program<RaydiumIntegration>;
  const wallet = provider.wallet.publicKey;

  // Raydium CLMM mainnet constants
  const CLMM_PROGRAM = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
  const POOL_STATE = new PublicKey("3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv");
  const AMM_CONFIG = new PublicKey("3h2e43PunVA5K34vwKCLHWhZF4aZpyaC9RmxvshGAQpL");
  const OBSERVATION_STATE = new PublicKey("3Y695CuQ8AP4anbwAqiEBeQF9KxqHFr8piEwvw3UePnQ");

  const INPUT_VAULT = new PublicKey("4ct7br2vTPzfdmY3S5HLtTxcGSBfn6pnw98hsS6v359A"); // WSOL vault
  const OUTPUT_VAULT = new PublicKey("5it83u57VRrVgc51oNV19TTmAJuffPx5GtGwQr7gQNUo"); // USDC vault
  const INPUT_VAULT_MINT = new PublicKey("So11111111111111111111111111111111111111112"); // WSOL
  const OUTPUT_VAULT_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // USDC
  const TICK_ARRAY = new PublicKey("BxEkg3zmPXBTKYdFwTqYDEBezRBUE2ctsNqciadWwd9X");

  // PDA for user config
  const [USER_CFG] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_cfg"), wallet.toBuffer()],
    program.programId
  );

  it("sets slippage", async () => {
    const tx = await program.methods
      .setSlippage(300) // 3%
      .accountsStrict({
        owner: wallet,
        userCfg: USER_CFG,
        systemProgram: SystemProgram.programId,
      }).rpc();

    console.log("Slippage set to 3%");
    console.log("Signature:", tx);
  });

  it("swaps exact in (WSOL → USDC)", async () => {
    const usdcAta = await ensureTokenAccount(provider, OUTPUT_VAULT_MINT, wallet);
    const wsolAta = await ensureTokenAccount(provider, INPUT_VAULT_MINT, wallet);

    // Wrap 1 SOL into WSOL
    wrapSolToWsol(provider, wallet, wsolAta, 1);

    // Expected USDC (quote)
    const amountIn = new BN("1000000000");
    const expectedUsdc = new BN("130000000"); // 130 USDC expected for 1 SOL
    const sqrtPriceLimitX64 = new BN(0);
    const isBaseInput = true;

    const tx = await program.methods
      .proxySwap(amountIn, expectedUsdc, sqrtPriceLimitX64, isBaseInput)
      .accountsStrict({
        clmmProgram: CLMM_PROGRAM,
        payer: wallet,
        userCfg: USER_CFG,
        ammConfig: AMM_CONFIG,
        poolState: POOL_STATE,
        inputTokenAccount: wsolAta,
        outputTokenAccount: usdcAta,
        inputVault: INPUT_VAULT,
        outputVault: OUTPUT_VAULT,
        observationState: OBSERVATION_STATE,
        tokenProgram: TOKEN_PROGRAM_ID,
        tickArray: TICK_ARRAY,
      }).rpc({ skipPreflight: true, commitment: "confirmed" });

    console.log("Exact in swap sent successfully!");

    // Verify the swap worked
    const usdcBalanceAfter = await getAccount(provider.connection, usdcAta);

    // Calculate actual slippage
    const expectedUsdcBN = new BN(expectedUsdc.toString());
    const actualUsdc = new BN(usdcBalanceAfter.amount.toString());
    const slippageBps = expectedUsdcBN.sub(actualUsdc).mul(new BN(10000)).div(expectedUsdcBN);

    // Verify slippage is within 3% tolerance
    expect(slippageBps.toNumber()).to.be.lessThanOrEqual(300);
  });

  it("swaps exact out (WSOL → USDC)", async () => {
    const usdcAta = await ensureTokenAccount(provider, OUTPUT_VAULT_MINT, wallet);
    const wsolAta = await ensureTokenAccount(provider, INPUT_VAULT_MINT, wallet);

    // Add more SOL to WSOL account for exact out test
    await wrapSolToWsol(provider, wallet, wsolAta, 0.5);

    // Desired output and expected input (smaller amount)
    const desiredOut = new BN("100000"); // 0.1 USDC (smaller amount)
    const expectedMaxIn = new BN("100000000"); // max 0.1 SOL
    const sqrtPriceLimitX64 = new BN(0);
    const isBaseInput = false;

    const wsolBefore = await getAccount(provider.connection, wsolAta);
    const usdcBefore = await getAccount(provider.connection, usdcAta);

    const tx = await program.methods
      .proxySwap(desiredOut, expectedMaxIn, sqrtPriceLimitX64, isBaseInput)
      .accountsStrict({
        clmmProgram: CLMM_PROGRAM,
        payer: wallet,
        userCfg: USER_CFG,
        ammConfig: AMM_CONFIG,
        poolState: POOL_STATE,
        inputTokenAccount: wsolAta,
        outputTokenAccount: usdcAta,
        inputVault: INPUT_VAULT,
        outputVault: OUTPUT_VAULT,
        observationState: OBSERVATION_STATE,
        tokenProgram: TOKEN_PROGRAM_ID,
        tickArray: TICK_ARRAY,
      }).rpc({ skipPreflight: true, commitment: "confirmed" });

    // Verify the exact out swap worked
    const wsolAfter = await getAccount(provider.connection, wsolAta);
    const usdcAfter = await getAccount(provider.connection, usdcAta);

    const usdcReceived = new BN(usdcAfter.amount.toString())
      .sub(new BN(usdcBefore.amount.toString()));
    const wsolSpent = new BN(wsolBefore.amount.toString())
      .sub(new BN(wsolAfter.amount.toString()));

    // --- Assertions ---
    // Check output amount reached target
    expect(usdcReceived.gte(desiredOut), "USDC received less than desired").to.be.true;

    // Check slippage (input side) - for exact out, compare actual spent vs max allowed
    const slippageBps = wsolSpent.mul(new BN(10000)).div(expectedMaxIn);

    console.log(`WSOL spent: ${wsolSpent.toNumber() / LAMPORTS_PER_SOL} SOL`);
    console.log(`Slippage: ${slippageBps.toNumber() / 100}%`);

    expect(slippageBps.toNumber(), "Input slippage exceeds 5% tolerance").to.be.lte(500);
  });

  it("finds best pool and swaps exact in (WSOL → USDC)", async () => {
    const amountIn = new BN(1_000_000_000); // 1 SOL in lamports
    const { bestPool, bestOutput, poolKeys } = await findOptimalPool(
      provider.connection,
      wallet,
      INPUT_VAULT_MINT,
      OUTPUT_VAULT_MINT,
      amountIn,
      true
    );

    // --- Ensure user token accounts exist ---
    const usdcAta = await ensureTokenAccount(provider, OUTPUT_VAULT_MINT, wallet);
    const wsolAta = await ensureTokenAccount(provider, INPUT_VAULT_MINT, wallet);

    // --- Wrap 1 SOL into WSOL for test ---
    wrapSolToWsol(provider, wallet, wsolAta, 1);

    const sqrtPriceLimitX64 = new BN(0);
    const isBaseInput = true;

    console.log("bestPool.ammConfig", bestPool.ammConfig);

    const startTickIndex = TickUtils.getTickArrayStartIndexByTick(
      poolKeys.tickCurrent,
      poolKeys.tickSpacing
    );

    console.log("startTickIndex", startTickIndex);

    console.log("CLMM_PROGRAM", CLMM_PROGRAM);
    console.log("bestPool.id", bestPool.id);

    const { publicKey: tickArrayAddr } = getPdaTickArrayAddress(
      new PublicKey(CLMM_PROGRAM),  // Convert string to PublicKey
      new PublicKey(bestPool.id),   // Convert string to PublicKey
      startTickIndex
    );
    console.log("TickArray PDA:", tickArrayAddr);


    // --- Execute the swap through your program using optimal pool ---
    console.log("Executing swap with optimal pool...");
    const tx = await program.methods
      .proxySwap(
        amountIn,                              // amount in (1 SOL)
        bestOutput,                            // expected_other_amount (USDC)
        sqrtPriceLimitX64,
        isBaseInput
      )
      .accountsStrict({
        clmmProgram: CLMM_PROGRAM,
        payer: wallet,
        userCfg: USER_CFG,
        ammConfig: poolKeys.ammConfig.id, 
        poolState: bestPool.id,
        inputTokenAccount: wsolAta,
        outputTokenAccount: usdcAta,
        inputVault: poolKeys.vaultA,
        outputVault: poolKeys.vaultB,
        observationState: poolKeys.observationId,
        tokenProgram: TOKEN_PROGRAM_ID,
        tickArray: tickArrayAddr,
      }).rpc({ skipPreflight: true, commitment: "confirmed" });

    console.log("Swap executed successfully!");

    // Verify the swap worked
    const usdcBalanceAfter = await getAccount(provider.connection, usdcAta);

    // Calculate actual slippage
    const expectedUsdcBN = new BN(bestOutput.toString());
    const actualUsdc = new BN(usdcBalanceAfter.amount.toString());
    const slippageBps = expectedUsdcBN.sub(actualUsdc).mul(new BN(10000)).div(expectedUsdcBN);

    // Verify slippage is within 3% tolerance
    expect(slippageBps.toNumber()).to.be.lessThanOrEqual(500);
  });

  it("finds best pool and swaps exact out (WSOL → USDC)", async () => {
    const desiredOut = new BN("100000"); // 0.1 USDC (smaller amount)

    const { bestPool, bestOutput, poolKeys } = await findOptimalPool(
      provider.connection,
      wallet,
      INPUT_VAULT_MINT,
      OUTPUT_VAULT_MINT,
      desiredOut,
      false
    );

    console.log("bestOutput", bestOutput);

    const usdcAta = await ensureTokenAccount(provider, OUTPUT_VAULT_MINT, wallet);
    const wsolAta = await ensureTokenAccount(provider, INPUT_VAULT_MINT, wallet);

    // Add more SOL to WSOL account for exact out test
    await wrapSolToWsol(provider, wallet, wsolAta, 0.5);

    // Desired output and expected input (smaller amount)
    // const expectedMaxIn = new BN("100000000"); // max 0.1 SOL
    const expectedMaxIn = bestOutput;

    const sqrtPriceLimitX64 = new BN(0);
    const isBaseInput = false;

    const wsolBefore = await getAccount(provider.connection, wsolAta);
    const usdcBefore = await getAccount(provider.connection, usdcAta);

    const startTickIndex = TickUtils.getTickArrayStartIndexByTick(
      poolKeys.tickCurrent,
      poolKeys.tickSpacing
    );

    console.log("startTickIndex", startTickIndex);

    console.log("CLMM_PROGRAM", CLMM_PROGRAM);
    console.log("bestPool.id", bestPool.id);

    const { publicKey: tickArrayAddr } = getPdaTickArrayAddress(
      new PublicKey(CLMM_PROGRAM),  // Convert string to PublicKey
      new PublicKey(bestPool.id),   // Convert string to PublicKey
      startTickIndex
    );
    console.log("TickArray PDA:", tickArrayAddr);

    const tx = await program.methods
      .proxySwap(desiredOut, expectedMaxIn, sqrtPriceLimitX64, isBaseInput)
      .accountsStrict({
        clmmProgram: CLMM_PROGRAM,
        payer: wallet,
        userCfg: USER_CFG,
        ammConfig: poolKeys.ammConfig.id,
        poolState: bestPool.id,
        inputTokenAccount: wsolAta,
        outputTokenAccount: usdcAta,
        inputVault: poolKeys.vaultA,
        outputVault: poolKeys.vaultB,
        observationState: poolKeys.observationId,
        tokenProgram: TOKEN_PROGRAM_ID,
        tickArray: tickArrayAddr,
      }).rpc({ skipPreflight: true, commitment: "confirmed" });

    // Verify the exact out swap worked
    const wsolAfter = await getAccount(provider.connection, wsolAta);
    const usdcAfter = await getAccount(provider.connection, usdcAta);

    const usdcReceived = new BN(usdcAfter.amount.toString())
      .sub(new BN(usdcBefore.amount.toString()));
    const wsolSpent = new BN(wsolBefore.amount.toString())
      .sub(new BN(wsolAfter.amount.toString()));

    // --- Assertions ---
    // Check output amount reached target
    expect(usdcReceived.gte(desiredOut), "USDC received less than desired").to.be.true;

    // Check slippage (input side) - for exact out, compare actual spent vs max allowed
    const slippageBps = wsolSpent.mul(new BN(10000)).div(expectedMaxIn);

    console.log(`WSOL spent: ${wsolSpent.toNumber() / LAMPORTS_PER_SOL} SOL`);
    console.log(`Slippage: ${slippageBps.toNumber() / 100}%`);

    expect(slippageBps.toNumber(), "Input slippage exceeds 5% tolerance").to.be.lte(500);
  });
});
