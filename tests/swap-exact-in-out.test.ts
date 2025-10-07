import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createSyncNativeInstruction,
  getAccount,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { RaydiumIntegration } from "../target/types/raydium_integration";

describe("raydium_integration_swaps", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.RaydiumIntegration as Program<RaydiumIntegration>;
  const wallet = provider.wallet.publicKey;

  console.log("Wallet:", wallet.toBase58());

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

  async function ensureTokenAccount(mint: PublicKey, owner: PublicKey) {
    const ata = getAssociatedTokenAddressSync(mint, owner);
    try {
      await getAccount(provider.connection, ata);
      console.log(`ATA exists for ${mint.toBase58()}`);
    } catch {
      console.log(`Creating ATA for ${mint.toBase58()}...`);
      const tx = new Transaction().add(
        createAssociatedTokenAccountInstruction(wallet, ata, owner, mint)
      );
      await provider.sendAndConfirm(tx);
      console.log(`Created ATA: ${ata.toBase58()}`);
    }
    return ata;
  }

  it("sets custom slippage tolerance", async () => {
    const tx = await program.methods
      .setSlippage(300) // 3%
      .accountsStrict({
        owner: wallet,
        userCfg: USER_CFG,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("Slippage set to 3%");
    console.log("Signature:", tx);
  });

  it("performs a proxy swap exact in (SOL → USDC)", async () => {
    const usdcAta = await ensureTokenAccount(OUTPUT_VAULT_MINT, wallet);
    const wsolAta = await ensureTokenAccount(INPUT_VAULT_MINT, wallet);

    // Wrap 1 SOL into WSOL
    const wrapAmount = 1 * LAMPORTS_PER_SOL;
    const transferTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: wallet,
        toPubkey: wsolAta,
        lamports: wrapAmount,
      }),
      createSyncNativeInstruction(wsolAta)
    );
    await provider.sendAndConfirm(transferTx);
    console.log("Wrapped 1 SOL into WSOL");

    // Expected USDC (quote)
    const expectedUsdc = new BN("130000000"); // 130 USDC expected for 1 SOL
    const sqrtPriceLimitX64 = new BN(0);
    const isBaseInput = true;

    const tx = await program.methods
      .proxySwap(new BN("1000000000"), expectedUsdc, sqrtPriceLimitX64, isBaseInput)
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
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    console.log("Exact in swap sent successfully!");
    console.log("Signature:", tx);

    // Verify the swap worked
    const wsolBalanceAfter = await getAccount(provider.connection, wsolAta);
    const usdcBalanceAfter = await getAccount(provider.connection, usdcAta);
    
    console.log("Verification Results:");
    console.log(`WSOL balance after: ${wsolBalanceAfter.amount.toString()}`);
    console.log(`USDC balance after: ${usdcBalanceAfter.amount.toString()}`);
    
    // Calculate actual slippage
    const expectedUsdcBN = new BN(expectedUsdc.toString());
    const actualUsdc = new BN(usdcBalanceAfter.amount.toString());
    const slippageBps = expectedUsdcBN.sub(actualUsdc).mul(new BN(10000)).div(expectedUsdcBN);
    console.log(`Actual slippage: ${slippageBps.toString()} bps (${slippageBps.toNumber() / 100}%)`);
    
    // Verify slippage is within 3% tolerance
    if (slippageBps.toNumber() <= 300) {
      console.log("Slippage within 3% tolerance");
    } else {
      console.log("Slippage exceeded 3% tolerance");
    }
  });

  it("performs a proxy swap exact out (WSOL → USDC)", async () => {
    const usdcAta = await ensureTokenAccount(OUTPUT_VAULT_MINT, wallet);
    const wsolAta = await ensureTokenAccount(INPUT_VAULT_MINT, wallet);

    // Add more SOL to WSOL account for exact out test
    const additionalSol = 0.5 * LAMPORTS_PER_SOL; // 0.5 SOL
    const transferTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: wallet,
        toPubkey: wsolAta,
        lamports: additionalSol,
      }),
      createSyncNativeInstruction(wsolAta)
    );
    await provider.sendAndConfirm(transferTx);
    console.log("💧 Added more SOL to WSOL for exact out test");

    // Desired output and expected input (smaller amount)
    const desiredOut = new BN("100000"); // 0.1 USDC (smaller amount)
    const expectedIn = new BN("100000000"); // max 0.1 SOL
    const sqrtPriceLimitX64 = new BN(0);
    const isBaseInput = false;

    const tx = await program.methods
      .proxySwap(desiredOut, expectedIn, sqrtPriceLimitX64, isBaseInput)
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
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    console.log("Exact out swap sent successfully!");
    console.log("Signature:", tx);

    // Verify the exact out swap worked
    const wsolBalanceAfter = await getAccount(provider.connection, wsolAta);
    const usdcBalanceAfter = await getAccount(provider.connection, usdcAta);
    
    console.log("Exact Out Verification Results:");
    console.log(`WSOL balance after: ${wsolBalanceAfter.amount.toString()}`);
    console.log(`USDC balance after: ${usdcBalanceAfter.amount.toString()}`);
    
    // For exact out, verify we got the desired amount
    const actualUsdc = new BN(usdcBalanceAfter.amount.toString());
    const desiredUsdcBN = new BN(desiredOut.toString());
    
    if (actualUsdc.gte(desiredUsdcBN)) {
      console.log("Received desired USDC amount or more");
    } else {
      console.log("Did not receive desired USDC amount");
    }
    
    // Calculate how much WSOL was actually spent
    const wsolSpent = new BN("1000000000").sub(new BN(wsolBalanceAfter.amount.toString()));
    console.log(`WSOL spent: ${wsolSpent.toString()} lamports (${wsolSpent.toNumber() / LAMPORTS_PER_SOL} SOL)`);
    
    // Verify slippage for exact out (input amount vs expected)
    const expectedInputBN = new BN(expectedIn.toString());
    const slippageBps = wsolSpent.sub(expectedInputBN).mul(new BN(10000)).div(expectedInputBN);
    console.log(`Input slippage: ${slippageBps.toString()} bps (${slippageBps.toNumber() / 100}%)`);
    
    if (slippageBps.toNumber() <= 300) {
      console.log("Input slippage within 3% tolerance");
    } else {
      console.log("Input slippage exceeded 3% tolerance");
    }
  });
});
