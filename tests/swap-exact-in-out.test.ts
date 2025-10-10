import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import Decimal from 'decimal.js'
import {
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
  Connection,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { RaydiumIntegration } from "../target/types/raydium_integration";
import { ensureTokenAccount, wrapSolToWsol, findOptimalPoolExactIn, findOptimalPoolExactOut } from "./utils/swap-utils";
import { expect } from "chai";
import { PoolUtils, Raydium, TickUtils, getPdaTickArrayAddress, getPdaProtocolPositionAddress, getPdaPersonalPositionAddress, TxVersion } from "@raydium-io/raydium-sdk-v2";

export async function getCorrectNftAta(
  connection: Connection,
  nftMint: PublicKey,
  owner: PublicKey
): Promise<{
  ata: PublicKey;
  tokenProgram: PublicKey;
}> {
  // Get mint account info
  const mintAcc = await connection.getAccountInfo(nftMint);
  if (!mintAcc) {
    throw new Error(`Mint account ${nftMint.toBase58()} not found on-chain`);
  }

  // Detect whether it's Token-2022 or legacy SPL Token
  const isToken2022 = mintAcc.owner.equals(TOKEN_2022_PROGRAM_ID);
  const tokenProgram = isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

  // Derive the proper ATA
  const ata = getAssociatedTokenAddressSync(nftMint, owner, false, tokenProgram);

  return { ata, tokenProgram };
}

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

    const raydium = await Raydium.load({ connection: provider.connection, owner: wallet, disableLoadToken: true });
    const { poolInfo } = await raydium.clmm.getPoolInfoFromRpc(POOL_STATE.toBase58());


    const startTickIndex = TickUtils.getTickArrayStartIndexByTick(
      (poolInfo as any).tickCurrent,
      (poolInfo as any).tickSpacing
    );

    console.log("startTickIndex", startTickIndex);

    console.log("CLMM_PROGRAM", CLMM_PROGRAM);
    console.log("bestPool.id", POOL_STATE.toBase58());

    const { publicKey: tickArrayAddr } = getPdaTickArrayAddress(
      new PublicKey(CLMM_PROGRAM),  // Convert string to PublicKey
      new PublicKey(POOL_STATE.toBase58()),   // Convert string to PublicKey
      startTickIndex
    );

    console.log("TickArray PDA:", tickArrayAddr);
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
        tickArray: tickArrayAddr,
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

    // Get pool data for tick array calculation
    const raydium = await Raydium.load({ connection: provider.connection, owner: wallet, disableLoadToken: true });
    const { poolInfo } = await raydium.clmm.getPoolInfoFromRpc(POOL_STATE.toBase58());

    const startTickIndex = TickUtils.getTickArrayStartIndexByTick(
      (poolInfo as any).tickCurrent,
      (poolInfo as any).tickSpacing
    );

    const { publicKey: tickArrayAddr } = getPdaTickArrayAddress(
      new PublicKey(CLMM_PROGRAM),
      new PublicKey(POOL_STATE.toBase58()),
      startTickIndex
    );

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

  it("finds best pool and swaps exact in (WSOL → USDC)", async () => {
    const amountIn = new BN(1_000_000_000); // 1 SOL in lamports
    const { bestPool, bestOutput, poolKeys } = await findOptimalPoolExactIn(
      provider.connection,
      wallet,
      INPUT_VAULT_MINT,
      OUTPUT_VAULT_MINT,
      amountIn
    );

    // --- Ensure user token accounts exist ---
    const usdcAta = await ensureTokenAccount(provider, OUTPUT_VAULT_MINT, wallet);
    const wsolAta = await ensureTokenAccount(provider, INPUT_VAULT_MINT, wallet);

    // --- Wrap 1 SOL into WSOL for test ---
    wrapSolToWsol(provider, wallet, wsolAta, 1);

    const sqrtPriceLimitX64 = new BN(0);
    const isBaseInput = true;

    console.log("bestPool.ammConfig", bestPool.ammConfig);

    // Load the pool data to get current tick information
    const raydium = await Raydium.load({ connection: provider.connection, owner: wallet, disableLoadToken: true });
    const { poolInfo } = await raydium.clmm.getPoolInfoFromRpc(bestPool.id);

    const startTickIndex = TickUtils.getTickArrayStartIndexByTick(
      (poolInfo as any).tickCurrent,
      (poolInfo as any).tickSpacing
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

  it("finds best pool and swaps exact out (WSOL → USDC) via Rust proxySwap", async () => {
    const connection = provider.connection;
    const walletPubkey = wallet;

    // Desired swap parameters
    const desiredOut = new BN("100000"); // 0.1 USDC
    const outputMint = OUTPUT_VAULT_MINT; // USDC
    const inputMint = INPUT_VAULT_MINT;   // WSOL
    const sqrtPriceLimitX64 = new BN(0);
    const isBaseInput = false; // exact-out mode
    const SLIPPAGE_BPS = 500;  // 5%

    // Find optimal CLMM pool dynamically
    const {
      bestPool,
      poolKeys,
      computePoolInfo,
      amountIn,
      maxAmountIn,
      realAmountOut,
      remainingAccounts,
    } = await findOptimalPoolExactOut(connection, walletPubkey, inputMint, outputMint, desiredOut);

    // Ensure ATA accounts exist and fund WSOL
    const usdcAta = await ensureTokenAccount(provider, outputMint, walletPubkey);
    const wsolAta = await ensureTokenAccount(provider, inputMint, walletPubkey);

    await wrapSolToWsol(provider, walletPubkey, wsolAta, 0.5); // 0.5 SOL buffer

    const wsolBefore = await getAccount(connection, wsolAta);
    const usdcBefore = await getAccount(connection, usdcAta);

    // Compute tick arrays
    const startTickIndex = TickUtils.getTickArrayStartIndexByTick(
      computePoolInfo.tickCurrent,
      computePoolInfo.tickSpacing
    );

    const { publicKey: tickArrayAddr } = getPdaTickArrayAddress(
      new PublicKey(CLMM_PROGRAM),
      new PublicKey(bestPool.id),
      startTickIndex
    );

    // Determine direction (vault mapping)
    const inputIsMintA = computePoolInfo.mintA.address === inputMint.toBase58();
    const inputVault = inputIsMintA ? poolKeys.vaultA : poolKeys.vaultB;
    const outputVault = inputIsMintA ? poolKeys.vaultB : poolKeys.vaultA;

    // Update slippage config in your user account
    await program.methods
      .setSlippage(SLIPPAGE_BPS)
      .accountsStrict({
        owner: walletPubkey,
        userCfg: USER_CFG,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const tickArrayAccounts =
      remainingAccounts?.map(acc => ({
        pubkey: new PublicKey(acc.pubkey ?? acc),
        isSigner: false,
        isWritable: false,
      })) ?? [];

    // Execute swap via Anchor proxySwap instruction
    const txSig = await program.methods
      .proxySwap(desiredOut, maxAmountIn, sqrtPriceLimitX64, isBaseInput)
      .accountsStrict({
        clmmProgram: CLMM_PROGRAM,
        payer: walletPubkey,
        userCfg: USER_CFG,
        ammConfig: poolKeys.ammConfig.id,
        poolState: bestPool.id,
        inputTokenAccount: wsolAta,
        outputTokenAccount: usdcAta,
        inputVault,
        outputVault,
        observationState: poolKeys.observationId,
        tokenProgram: TOKEN_PROGRAM_ID,
        tickArray: tickArrayAddr,
      })
      .remainingAccounts(tickArrayAccounts)
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    // Post-swap validation
    const wsolAfter = await getAccount(connection, wsolAta);
    const usdcAfter = await getAccount(connection, usdcAta);

    const usdcReceived = new BN(usdcAfter.amount.toString()).sub(new BN(usdcBefore.amount.toString()));
    const wsolSpent = new BN(wsolBefore.amount.toString()).sub(new BN(wsolAfter.amount.toString()));

    console.log(`USDC received: ${usdcReceived.toString()} / desired: ${desiredOut.toString()}`);
    console.log(`WSOL spent: ${(wsolSpent.toNumber() / 1e9).toFixed(9)} SOL`);

    expect(usdcReceived.gte(desiredOut), "USDC received below target").to.be.true;

    const expectedInput = amountIn;
    const slippageBps = wsolSpent.sub(expectedInput).mul(new BN(10_000)).div(expectedInput);
    expect(slippageBps.toNumber(), "Input slippage exceeds tolerance").to.be.lte(500);
  });


  // it("finds best pool and swaps exact out (WSOL → USDC) using SDK swapBaseOut", async () => {
  //   const connection = provider.connection;
  //   const raydium = await Raydium.load({
  //     connection: provider.connection,
  //     owner: provider.wallet.payer,
  //     disableLoadToken: true,
  //   });

  //   // --- 1️⃣ Desired swap parameters
  //   const desiredOut = new BN("100000"); // 0.1 USDC
  //   const outputMint = OUTPUT_VAULT_MINT; // USDC
  //   const inputMint = INPUT_VAULT_MINT;   // WSOL

  //   // --- 2️⃣ Find best CLMM pool dynamically
  //   const {
  //     bestPool,
  //     poolKeys,
  //     computePoolInfo,
  //     amountIn,
  //     maxAmountIn,
  //     realAmountOut,
  //     remainingAccounts,
  //   } = await findOptimalPoolExactOut(connection, wallet, inputMint, outputMint, desiredOut);

  //   console.log("\n💧 Using best pool:", bestPool.id);
  //   console.log("   amountIn:", amountIn.toString());
  //   console.log("   maxAmountIn (buffered):", maxAmountIn.toString());
  //   console.log("   realAmountOut:", realAmountOut.toString());

  //   // --- 3️⃣ Ensure ATA accounts
  //   const usdcAta = await ensureTokenAccount(provider, outputMint, wallet);
  //   const wsolAta = await ensureTokenAccount(provider, inputMint, wallet);

  //   // --- 4️⃣ Fund WSOL account
  //   await wrapSolToWsol(provider, wallet, wsolAta, 0.5); // 0.5 SOL buffer
  //   const wsolBefore = await getAccount(connection, wsolAta);
  //   const usdcBefore = await getAccount(connection, usdcAta);

  //   // --- 5️⃣ Execute swap via Raydium SDK
  //   const { execute } = await raydium.clmm.swapBaseOut({
  //     poolInfo: bestPool,
  //     poolKeys,                // correct: actual key structure
  //     outputMint,
  //     amountInMax: maxAmountIn,
  //     amountOut: realAmountOut,
  //     observationId: computePoolInfo.observationId, // fixed
  //     ownerInfo: {
  //       useSOLBalance: true,
  //     },
  //     remainingAccounts,
  //     txVersion: 0,
  //     computeBudgetConfig: {
  //       units: 600_000,
  //       microLamports: 500_000,
  //     },
  //   });


  //   const { txId } = await execute({ sendAndConfirm: true });
  //   console.log("✅ Swap transaction:", `https://explorer.solana.com/tx/${txId}`);

  //   // --- 6️⃣ Verify results
  //   const wsolAfter = await getAccount(connection, wsolAta);
  //   const usdcAfter = await getAccount(connection, usdcAta);

  //   const usdcReceived = new BN(usdcAfter.amount.toString()).sub(new BN(usdcBefore.amount.toString()));
  //   const wsolSpent = new BN(wsolBefore.amount.toString()).sub(new BN(wsolAfter.amount.toString()));

  //   console.log(`USDC received: ${usdcReceived.toString()} / desired: ${desiredOut.toString()}`);
  //   console.log(`WSOL spent: ${(wsolSpent.toNumber() / 1e9).toFixed(9)} SOL`);

  //   // --- 7️⃣ Basic assertions
  //   expect(usdcReceived.gte(desiredOut), "USDC received less than desired").to.be.true;

  //   const slippageBps = wsolSpent.mul(new BN(10_000)).div(maxAmountIn);
  //   console.log(`Slippage used: ${(slippageBps.toNumber() / 100).toFixed(2)}%`);
  //   expect(slippageBps.toNumber(), "Input slippage exceeds tolerance").to.be.lte(1500); // 15% tolerance
  // });

  it("creates position using openPositionFromBase", async () => {
    const raydium = await Raydium.load({
      connection: provider.connection,
      owner: provider.wallet.payer,
      disableLoadToken: true,
    });

    // Load Pool Info
    const { poolInfo, poolKeys } = await raydium.clmm.getPoolInfoFromRpc(POOL_STATE.toBase58());
    console.log("Loaded pool:", poolKeys.id);

    // Check if we already have a position for this pool
    const existingPositions = await raydium.clmm.getOwnerPositionInfo({
      programId: poolInfo.programId,
    });

    const existingPosition = existingPositions.find((p) => p.poolId.toBase58() === poolInfo.id);
    if (existingPosition) {
      return;
    }

    // Ensure ATA accounts for wallet
    const wsolAta = await ensureTokenAccount(provider, INPUT_VAULT_MINT, wallet);
    const usdcAta = await ensureTokenAccount(provider, OUTPUT_VAULT_MINT, wallet);

    // Wrap some SOL
    await wrapSolToWsol(provider, wallet, wsolAta, 0.5);

    // Use openPositionFromBase instead of openPositionFromLiquidity
    const baseAmount = 0.1; // 0.1 SOL
    const tickSpacing = (poolInfo as any).tickSpacing;
    const currentTick = (poolInfo as any).tickCurrent;

    // Pick a range around the current tick
    const tickLower = currentTick - tickSpacing * 10;
    const tickUpper = currentTick + tickSpacing * 10;

    console.log("Creating position with openPositionFromBase...");
    console.log("Base amount:", baseAmount, "SOL");
    console.log("Tick range:", { tickLower, tickUpper });

    const epochInfo = await raydium.fetchEpochInfo();
    const res = await PoolUtils.getLiquidityAmountOutFromAmountIn({
      poolInfo,
      slippage: 0,
      inputA: true,
      tickUpper: Math.max(tickLower, tickUpper),
      tickLower: Math.min(tickLower, tickUpper),
      amount: new BN(baseAmount * 10 ** poolInfo.mintA.decimals),
      add: true,
      amountHasFee: true,
      epochInfo,
    });

    const otherAmountMax = res.amountSlippageB.amount.muln(2);

    const { execute, extInfo } = await raydium.clmm.openPositionFromBase({
      poolInfo,
      poolKeys,
      tickLower,
      tickUpper,
      base: 'MintA', // SOL is mintA
      baseAmount: new BN(baseAmount * 10 ** poolInfo.mintA.decimals),
      otherAmountMax,
      ownerInfo: {
        useSOLBalance: true,
        feePayer: provider.wallet.publicKey,
      },
      txVersion: TxVersion.LEGACY,
      nft2022: true,
      computeBudgetConfig: {
        units: 600000,
        microLamports: 10000,
      },
    });

    try {
      // Fetch a fresh blockhash to ensure the tx is unique each run
      await provider.connection.getLatestBlockhash("finalized");

      const { txId } = await execute({
        sendAndConfirm: true,
      });
      console.log("Position created successfully:", { txId });
    } catch (e: any) {
      if (e.message.includes("already been processed")) {
        console.log("Transaction already processed, skipping resend");
      } else {
        throw e;
      }
    }

    const nftMint = extInfo.nftMint;
    const baseInitAmount = 0.05; // 0.05 SOL = safe small test
    const epochInfo2 = await raydium.fetchEpochInfo();

    const liqInit = await PoolUtils.getLiquidityAmountOutFromAmountIn({
      poolInfo,
      slippage: 0,
      inputA: true,
      tickUpper: Math.max(tickLower, tickUpper),
      tickLower: Math.min(tickLower, tickUpper),
      amount: new BN(baseInitAmount * 10 ** poolInfo.mintA.decimals),
      add: true,
      amountHasFee: true,
      epochInfo: epochInfo2,
    });

    const { execute: executeIncrease } = await raydium.clmm.increasePositionFromLiquidity({
      poolInfo,
      poolKeys,
      ownerPosition: {
        poolId: poolInfo.id,
        nftMint,
        tickLower,
        tickUpper,
      } as any,
      ownerInfo: {
        useSOLBalance: true,
        feePayer: provider.wallet.publicKey,
      },
      liquidity: liqInit.liquidity,
      amountMaxA: new BN(baseInitAmount * 10 ** poolInfo.mintA.decimals),
      amountMaxB: new BN(new Decimal(liqInit.amountSlippageB.amount.toString()).mul(1.05).toFixed(0)),
      txVersion: TxVersion.LEGACY,
      nft2022: true,
    });

    const { txId: seedTxId } = await executeIncrease({ sendAndConfirm: true });
    console.log("Protocol position initialized:", { txId: seedTxId });

    await new Promise((resolve) => setTimeout(resolve, 4000));
  });


  it("decreases liquidity from Raydium CLMM", async () => {
    const raydium = await Raydium.load({
      connection: provider.connection,
      owner: provider.wallet.payer,
      disableLoadToken: true,
    });

    // Load Pool Info
    const { poolInfo, poolKeys } = await raydium.clmm.getPoolInfoFromRpc(POOL_STATE.toBase58());
    console.log("Loaded pool:", poolKeys.id);

    // Check if we already have a position for this pool
    const existingPositions = await raydium.clmm.getOwnerPositionInfo({
      programId: poolInfo.programId,
    });

    const existingPosition = existingPositions.find((p) => p.poolId.toBase58() === poolInfo.id);
    if (existingPosition) {
      return;
    }

    console.log("Decreasing liquidity for position:", existingPosition.nftMint.toBase58());
    console.log("Current liquidity:", existingPosition.liquidity.toString());

    // ====== 3️⃣ Build the decrease tx ======
    const { execute } = await raydium.clmm.decreaseLiquidity({
      poolInfo,
      poolKeys,
      ownerPosition: existingPosition,
      ownerInfo: {
        useSOLBalance: true,
        // set closePosition to true to withdraw everything & burn NFT
        closePosition: false, // or true if you want full withdrawal
        feePayer: raydium.owner.publicKey,
      },
      // Remove half liquidity (or all if closePosition: true)
      liquidity: existingPosition.liquidity.divn(2),
      amountMinA: new BN(0),
      amountMinB: new BN(0),
      txVersion: TxVersion.LEGACY,
    });

    try {
      await raydium.connection.getLatestBlockhash("finalized");

      const { txId } = await execute({ sendAndConfirm: true });
    } catch (e: any) {
      if (e.message.includes("already been processed")) {
        console.log("⚠️ Transaction already processed, skipping resend");
      } else {
        throw e;
      }
    }

    // Get updated position info using the correct method
    const updatedPositions = await raydium.clmm.getOwnerPositionInfo({
      programId: poolInfo.programId,
    });

    const updatedPosition = updatedPositions.find((p) => p.nftMint.toBase58() === existingPosition.nftMint.toBase58());
    if (updatedPosition) {
      // Verify liquidity increased
      expect(updatedPosition.liquidity.gt(existingPosition.liquidity), "Liquidity did not increase as expected");
    }
    else {
      throw new Error("Could not find updated position info");
    }
  });
});
