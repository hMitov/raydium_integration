import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  Keypair,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createSyncNativeInstruction,
  getAccount,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { RaydiumIntegration } from "../target/types/raydium_integration";

describe("raydium_integration_exact_in", () => {
  // --- Anchor provider ---
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.RaydiumIntegration as Program<RaydiumIntegration>;
  const wallet = provider.wallet.publicKey;

  console.log("Wallet:", wallet.toBase58());

  // --- Raydium CLMM mainnet program ---
  const CLMM_PROGRAM = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");

  // --- Pool accounts (from successful transaction) ---
  const POOL_STATE = new PublicKey("3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv");
  const AMM_CONFIG = new PublicKey("3h2e43PunVA5K34vwKCLHWhZF4aZpyaC9RmxvshGAQpL");
  const OBSERVATION_STATE = new PublicKey("3Y695CuQ8AP4anbwAqiEBeQF9KxqHFr8piEwvw3UePnQ");

  // --- Token vaults and mints ---
  const INPUT_VAULT = new PublicKey("4ct7br2vTPzfdmY3S5HLtTxcGSBfn6pnw98hsS6v359A"); // WSOL vault
  const OUTPUT_VAULT = new PublicKey("5it83u57VRrVgc51oNV19TTmAJuffPx5GtGwQr7gQNUo"); // USDC vault
  const INPUT_VAULT_MINT = new PublicKey("So11111111111111111111111111111111111111112"); // WSOL
  const OUTPUT_VAULT_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // USDC

  // --- Single tick array (from successful transaction) ---
  const TICK_ARRAY = new PublicKey("BxEkg3zmPXBTKYdFwTqYDEBezRBUE2ctsNqciadWwd9X");

  // --- Token accounts (create for our wallet) ---
  const INPUT_TOKEN_ACCOUNT = getAssociatedTokenAddressSync(INPUT_VAULT_MINT, wallet); // WSOL ATA
  const OUTPUT_TOKEN_ACCOUNT = getAssociatedTokenAddressSync(OUTPUT_VAULT_MINT, wallet); // USDC ATA

  console.log("Input Token Account:", INPUT_TOKEN_ACCOUNT.toBase58());
  console.log("Output Token Account:", OUTPUT_TOKEN_ACCOUNT.toBase58());


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

  it("performs a proxy swap (SOL → USDC)", async () => {
    // Create token accounts for our wallet
    const usdcAta = await ensureTokenAccount(OUTPUT_VAULT_MINT, wallet);
    const wsolAta = await ensureTokenAccount(INPUT_VAULT_MINT, wallet);

    // Transfer SOL to WSOL account and wrap it
    const wrapAmount = 1 * LAMPORTS_PER_SOL; // 1 SOL
    const transferTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: wallet,
        toPubkey: wsolAta,
        lamports: wrapAmount,
      }),
      createSyncNativeInstruction(wsolAta)
    );
    await provider.sendAndConfirm(transferTx);
    console.log("Transferred and wrapped SOL to WSOL");

    const amountIn = new BN("100000000"); // 0.1 SOL (smaller amount for testing)
    const otherAmountThreshold = new BN(0);
    const sqrtPriceLimitX64 = new BN(0);
    const isBaseInput = true;

    console.log("Running proxy_swap with our wallet accounts...");
    console.log("Input:", wsolAta.toBase58());
    console.log("Output:", usdcAta.toBase58());


      const tx = await program.methods
        .proxySwap(amountIn, otherAmountThreshold, sqrtPriceLimitX64, isBaseInput)
        .accountsStrict({
          clmmProgram: CLMM_PROGRAM,
          payer: wallet,
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
        
        console.log("Exact in swap submitted successfully!");
        console.log("Signature:", tx);
  });

  it("performs a proxy swap exact out (WSOL → USDC)", async () => {
    // Create token accounts for our wallet
    const usdcAta = await ensureTokenAccount(OUTPUT_VAULT_MINT, wallet);
    const wsolAta = await ensureTokenAccount(INPUT_VAULT_MINT, wallet);

    // Check if WSOL account already has balance from previous test
    try {
      const wsolAccount = await getAccount(provider.connection, wsolAta);
      console.log("WSOL account already has balance:", wsolAccount.amount.toString());
    } catch {
      // If no balance, transfer SOL to WSOL account and wrap it
      const wrapAmount = 1 * LAMPORTS_PER_SOL; // 1 SOL
      const transferTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: wallet,
          toPubkey: wsolAta,
          lamports: wrapAmount,
        }),
        createSyncNativeInstruction(wsolAta)
      );
      await provider.sendAndConfirm(transferTx);
      console.log("Transferred and wrapped SOL to WSOL");
    }

    // For exact out, we specify the desired output amount (USDC)
    const amountOut = new BN("1000000"); // 1 USDC (6 decimals)
    const otherAmountThreshold = new BN("1000000000"); // Max input: 1 SOL
    const sqrtPriceLimitX64 = new BN(0);
    const isBaseInput = false; // This is the key difference - false for exact out

    console.log("Running proxy_swap exact out...");
    console.log("Input:", wsolAta.toBase58());
    console.log("Output:", usdcAta.toBase58());
    console.log("Desired output:", amountOut.toString(), "USDC");

      const tx = await program.methods
        .proxySwap(amountOut, otherAmountThreshold, sqrtPriceLimitX64, isBaseInput)
        .accountsStrict({
          clmmProgram: CLMM_PROGRAM,
          payer: wallet,
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

      console.log("Exact out swap submitted successfully!");
      console.log("Signature:", tx);
  });
});
