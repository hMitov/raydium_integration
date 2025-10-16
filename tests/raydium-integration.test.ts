import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import Decimal from "decimal.js";
import {
  PublicKey,
  Keypair,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { expect } from "chai";
import {
  PoolUtils,
  Raydium,
  TickUtils,
  getPdaTickArrayAddress,
  getPdaProtocolPositionAddress,
  getPdaPersonalPositionAddress,
  TxVersion,
  ClmmKeys,
  ApiV3PoolInfoConcentratedItem,
} from "@raydium-io/raydium-sdk-v2";

import { RaydiumIntegration } from "../target/types/raydium_integration";
import {
  ensureTokenAccount,
  wrapSolToWsol,
  findOptimalPoolExactIn,
  findOptimalPoolExactOut,
} from "./utils/swap-utils";

describe("raydium_integration", () => {
  // Raydium CLMM mainnet constants
  const CLMM_PROGRAM = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
  const POOL_STATE = new PublicKey("3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv");
  const AMM_CONFIG = new PublicKey("3h2e43PunVA5K34vwKCLHWhZF4aZpyaC9RmxvshGAQpL");
  const OBSERVATION_STATE = new PublicKey("3Y695CuQ8AP4anbwAqiEBeQF9KxqHFr8piEwvw3UePnQ");
  const INPUT_VAULT = new PublicKey("4ct7br2vTPzfdmY3S5HLtTxcGSBfn6pnw98hsS6v359A"); // WSOL vault
  const OUTPUT_VAULT = new PublicKey("5it83u57VRrVgc51oNV19TTmAJuffPx5GtGwQr7gQNUo"); // USDC vault
  const INPUT_VAULT_MINT = new PublicKey("So11111111111111111111111111111111111111112"); // WSOL
  const OUTPUT_VAULT_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // USDC
  const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
  const SYSVAR_RENT_PUBKEY = new PublicKey("SysvarRent111111111111111111111111111111111");
  const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

  const SLIPPAGE_BPS = 300;
  const MAX_SLIPPAGE_BPS = 500;
  const WSOL_AMOUNT = 1;
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.RaydiumIntegration as Program<RaydiumIntegration>;
  const wallet = provider.wallet.publicKey;

  let raydium: Raydium;
  // PDA for user config
  const [USER_CFG] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_cfg"), wallet.toBuffer()],
    program.programId
  );

  before(async () => {
    console.log("Initializing test state...");
    raydium = await Raydium.load({
      connection: provider.connection,
      owner: provider.wallet.payer,
      disableLoadToken: true,
    });

    await new Promise(r => setTimeout(r, 2000));
  });

  it("sets slippage", async () => {
    const tx = await program.methods
      .setSlippage(SLIPPAGE_BPS) // 3%
      .accountsStrict({
        owner: wallet,
        userCfg: USER_CFG,
        systemProgram: SystemProgram.programId,
      }).rpc();

    console.log("Slippage set to 3%");
  });

  it("swaps exact in (WSOL → USDC)", async () => {
    const usdcAta = await ensureTokenAccount(provider, OUTPUT_VAULT_MINT, wallet);
    const wsolAta = await ensureTokenAccount(provider, INPUT_VAULT_MINT, wallet);
    wrapSolToWsol(provider, wallet, wsolAta, WSOL_AMOUNT);

    // Expected USDC (quote)
    const amountIn = new BN(1_000_000_000); // 1 SOL
    const expectedUsdc = new BN(130_000_000); // expected 130 USDC
    const sqrtPriceLimitX64 = new BN(0);
    const isBaseInput = true;

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

    expect(slippageBps.toNumber()).to.be.lessThanOrEqual(SLIPPAGE_BPS);
  });

  it("swaps exact out (WSOL → USDC)", async () => {
    const usdcAta = await ensureTokenAccount(provider, OUTPUT_VAULT_MINT, wallet);
    const wsolAta = await ensureTokenAccount(provider, INPUT_VAULT_MINT, wallet);
    await wrapSolToWsol(provider, wallet, wsolAta, WSOL_AMOUNT);

    const desiredOut = new BN(100_000); // 0.1 USDC
    const expectedMaxIn = new BN(100_000_000); // 0.1 SOL
    const sqrtPriceLimitX64 = new BN(0);
    const isBaseInput = false;

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
        tickArray: tickArrayAddr,
      }).rpc({ skipPreflight: true, commitment: "confirmed" });

    // Verify the exact out swap worked
    const wsolAfter = await getAccount(provider.connection, wsolAta);
    const usdcAfter = await getAccount(provider.connection, usdcAta);

    const usdcReceived = new BN(usdcAfter.amount.toString()).sub(new BN(usdcBefore.amount.toString()));
    const wsolSpent = new BN(wsolBefore.amount.toString()).sub(new BN(wsolAfter.amount.toString()));

    expect(usdcReceived.gte(desiredOut), "USDC received less than desired").to.be.true;

    // Check slippage (input side) - for exact out, compare actual spent vs max allowed
    const slippageBps = wsolSpent.mul(new BN(10000)).div(expectedMaxIn);

    expect(slippageBps.toNumber(), "Input slippage exceeds 5% tolerance").to.be.lte(MAX_SLIPPAGE_BPS);
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

    const usdcAta = await ensureTokenAccount(provider, OUTPUT_VAULT_MINT, wallet);
    const wsolAta = await ensureTokenAccount(provider, INPUT_VAULT_MINT, wallet);
    wrapSolToWsol(provider, wallet, wsolAta, WSOL_AMOUNT);

    const sqrtPriceLimitX64 = new BN(0);
    const isBaseInput = true;

    const { poolInfo } = await raydium.clmm.getPoolInfoFromRpc(bestPool.id);
    const startTickIndex = TickUtils.getTickArrayStartIndexByTick(
      (poolInfo as any).tickCurrent,
      (poolInfo as any).tickSpacing
    );
    const { publicKey: tickArrayAddr } = getPdaTickArrayAddress(
      new PublicKey(CLMM_PROGRAM),
      new PublicKey(bestPool.id),
      startTickIndex
    );

    console.log("Executing swap with optimal pool...");
    const tx = await program.methods
      .proxySwap(
        amountIn,
        bestOutput,
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
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    console.log("Exact swap in executed successfully!");

    // Verify the swap worked
    const usdcBalanceAfter = await getAccount(provider.connection, usdcAta);

    // Calculate actual slippage
    const expectedUsdcBN = new BN(bestOutput.toString());
    const actualUsdc = new BN(usdcBalanceAfter.amount.toString());
    const slippageBps = expectedUsdcBN.sub(actualUsdc).mul(new BN(10000)).div(expectedUsdcBN);

    // Verify slippage is within 3% tolerance
    expect(slippageBps.toNumber()).to.be.lessThanOrEqual(SLIPPAGE_BPS);
  });

  it("finds best pool and swaps exact out (WSOL → USDC)", async () => {
    // Add small delay to avoid transaction conflicts
    await new Promise(resolve => setTimeout(resolve, 1000));

    const connection = provider.connection;
    const walletPubkey = wallet;

    const desiredOut = new BN(100_000); // 0.1 USDC
    const outputMint = OUTPUT_VAULT_MINT; // USDC
    const inputMint = INPUT_VAULT_MINT;   // WSOL
    const sqrtPriceLimitX64 = new BN(0);
    const isBaseInput = false;

    const {
      bestPool,
      poolKeys,
      computePoolInfo,
      amountIn,
      maxAmountIn
    } = await findOptimalPoolExactOut(connection, walletPubkey, inputMint, outputMint, desiredOut);

    const usdcAta = await ensureTokenAccount(provider, outputMint, walletPubkey);
    const wsolAta = await ensureTokenAccount(provider, inputMint, walletPubkey);
    await wrapSolToWsol(provider, walletPubkey, wsolAta, WSOL_AMOUNT);

    const wsolBefore = await getAccount(connection, wsolAta);
    const usdcBefore = await getAccount(connection, usdcAta);


    // Determine direction (vault mapping)
    const inputIsMintA = computePoolInfo.mintA.address === inputMint.toBase58();
    const inputVault = inputIsMintA ? poolKeys.vaultA : poolKeys.vaultB;
    const outputVault = inputIsMintA ? poolKeys.vaultB : poolKeys.vaultA;

    await program.methods
      .setSlippage(MAX_SLIPPAGE_BPS)
      .accountsStrict({
        owner: walletPubkey,
        userCfg: USER_CFG,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const { poolInfo } = await raydium.clmm.getPoolInfoFromRpc(bestPool.id);
    const startTickIndex = TickUtils.getTickArrayStartIndexByTick(
      (poolInfo as any).tickCurrent,
      (poolInfo as any).tickSpacing
    );
    const { publicKey: tickArrayAddr } = getPdaTickArrayAddress(
      new PublicKey(CLMM_PROGRAM),
      new PublicKey(bestPool.id),
      startTickIndex
    );

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
      }).rpc({ skipPreflight: true, commitment: "confirmed" });

    console.log("Exact swap out executed successfully!");

    // Verify the swap worked
    const wsolAfter = await getAccount(connection, wsolAta);
    const usdcAfter = await getAccount(connection, usdcAta);

    const usdcReceived = new BN(usdcAfter.amount.toString()).sub(new BN(usdcBefore.amount.toString()));
    const wsolSpent = new BN(wsolBefore.amount.toString()).sub(new BN(wsolAfter.amount.toString()));

    expect(usdcReceived.gte(desiredOut), "USDC received below target").to.be.true;

    const expectedInput = amountIn;
    const slippageBps = wsolSpent.sub(expectedInput).mul(new BN(10_000)).div(expectedInput);

    expect(slippageBps.toNumber(), "Input slippage exceeds tolerance").to.be.lte(MAX_SLIPPAGE_BPS);
  });

  describe("liquidity position management", () => {
    before(async () => {

      const { poolInfo, poolKeys } = await raydium.clmm.getPoolInfoFromRpc(POOL_STATE.toBase58());
      const poolId = new PublicKey(poolKeys.id);

      const ownerPositions = await raydium.clmm.getOwnerPositionInfo({
        owner: provider.wallet.publicKey,
        programId: poolInfo.programId,
      });

      if (ownerPositions.length === 0) {

        const wsolAta = await ensureTokenAccount(provider, INPUT_VAULT_MINT, wallet);
        const usdcAta = await ensureTokenAccount(provider, OUTPUT_VAULT_MINT, wallet);
        await wrapSolToWsol(provider, wallet, wsolAta, WSOL_AMOUNT);

        // Tick range 
        const tickSpacing: number = (poolInfo as any).tickSpacing;
        const currentTick: number = (poolInfo as any).tickCurrent;
        const tickLower = currentTick - tickSpacing * 10;
        const tickUpper = currentTick + tickSpacing * 10;

        const tickArrayLowerStartIndex = TickUtils.getTickArrayStartIndexByTick(tickLower, tickSpacing);
        const tickArrayUpperStartIndex = TickUtils.getTickArrayStartIndexByTick(tickUpper, tickSpacing);

        // Liquidity
        const baseAmount = 0.1;
        const epochInfo = await raydium.fetchEpochInfo();
        const quote = await PoolUtils.getLiquidityAmountOutFromAmountIn({
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
        const liquidity = quote.liquidity;
        const amount0Max = new BN(baseAmount * 10 ** poolInfo.mintA.decimals);
        const amount1Max = new BN(quote.amountSlippageB.amount.toString());

        const { publicKey: tickArrayLower } = getPdaTickArrayAddress(CLMM_PROGRAM, poolId, tickArrayLowerStartIndex);
        const { publicKey: tickArrayUpper } = getPdaTickArrayAddress(CLMM_PROGRAM, poolId, tickArrayUpperStartIndex);
        const { publicKey: protocolPosition } = getPdaProtocolPositionAddress(CLMM_PROGRAM, poolId, tickLower, tickUpper);

        //   NFT mint / personal position
        const positionNftMint = Keypair.generate();
        const { publicKey: personalPosition } = getPdaPersonalPositionAddress(
          CLMM_PROGRAM,
          positionNftMint.publicKey
        );
        const positionNftAccount = getAssociatedTokenAddressSync(positionNftMint.publicKey, wallet);
        const [metadataAccount] = PublicKey.findProgramAddressSync(
          [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), positionNftMint.publicKey.toBuffer()],
          METADATA_PROGRAM_ID
        );

        // Map token accounts to vaults by mint order (A/B)
        const mintA = new PublicKey((poolInfo as any).mintA.address);
        const mintB = new PublicKey((poolInfo as any).mintB.address);
        const tokenVault0 = INPUT_VAULT;
        const tokenVault1 = OUTPUT_VAULT;

        const tokenAccount0 = mintA.equals(INPUT_VAULT_MINT) ? wsolAta : usdcAta;
        const tokenAccount1 = mintB.equals(OUTPUT_VAULT_MINT) ? usdcAta : wsolAta;

        const memoIx = SystemProgram.transfer({
          fromPubkey: wallet,
          toPubkey: wallet,
          lamports: 0,
        });
        const computeIx = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });

        const tx = await program.methods
          .proxyOpenPosition(
            tickLower,
            tickUpper,
            tickArrayLowerStartIndex,
            tickArrayUpperStartIndex,
            liquidity,
            amount0Max,
            amount1Max,
            true,   // with metadata
            null    // base_flag
          ).preInstructions([memoIx, computeIx])
          .accountsStrict({
            clmmProgram: CLMM_PROGRAM,
            payer: wallet,
            positionNftOwner: wallet,
            positionNftMint: positionNftMint.publicKey,
            positionNftAccount,
            metadataAccount,
            poolState: poolId,
            protocolPosition,
            tickArrayLower,
            tickArrayUpper,
            personalPosition,
            tokenAccount0,
            tokenAccount1,
            tokenVault0,
            tokenVault1,
            rent: SYSVAR_RENT_PUBKEY,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            metadataProgram: METADATA_PROGRAM_ID,
            tokenProgram2022: TOKEN_2022_PROGRAM_ID,
            vault0Mint: mintA,
            vault1Mint: mintB,
          }).transaction();

        const { blockhash, lastValidBlockHeight } = await provider.connection.getLatestBlockhash("finalized");
        tx.recentBlockhash = blockhash;
        tx.feePayer = wallet;
        tx.sign(positionNftMint);

        const txSig = await provider.sendAndConfirm(tx, [positionNftMint], {
          skipPreflight: false,
          commitment: "confirmed",
        });
      }
    });

    it("increases liquidity", async () => {
      const { poolInfo, poolKeys } = await raydium.clmm.getPoolInfoFromRpc(POOL_STATE.toBase58());

      // Find the existing position created in the open position test
      const ownerPositions = await raydium.clmm.getOwnerPositionInfo({
        owner: provider.wallet.publicKey,
        programId: poolInfo.programId,
      });

      if (ownerPositions.length === 0) throw new Error("No existing position found. Run proxy_open_position test first!");

      const existing = ownerPositions.find(p =>
        new PublicKey(p.poolId).equals(new PublicKey(poolInfo.id))
      );

      if (!existing) throw new Error("No existing position for this pool.");

      const nftMint = existing.nftMint;
      const tickLower = existing.tickLower;
      const tickUpper = existing.tickUpper;

      // Prepare to add liquidity
      const baseInitAmount = 0.05; // add another 0.05 SOL
      const epochInfo = await raydium.fetchEpochInfo();
      const slippage = 0;

      const liqCalc = await PoolUtils.getLiquidityAmountOutFromAmountIn({
        poolInfo,
        slippage,
        inputA: true,
        tickUpper,
        tickLower,
        amount: new BN(baseInitAmount * 10 ** poolInfo.mintA.decimals),
        add: true,
        amountHasFee: true,
        epochInfo,
      });

      const { execute: executeIncrease } = await raydium.clmm.increasePositionFromLiquidity({
        poolInfo,
        poolKeys,
        ownerPosition: {
          poolId: poolInfo.id,
          nftMint,
          tickLower,
          tickUpper,
        },
        ownerInfo: {
          useSOLBalance: true,
          feePayer: provider.wallet.publicKey,
        },
        liquidity: liqCalc.liquidity,
        amountMaxA: new BN(baseInitAmount * 10 ** poolInfo.mintA.decimals),
        amountMaxB: new BN(new Decimal(liqCalc.amountSlippageB.amount.toString()).mul(1.05).toFixed(0)),
        txVersion: TxVersion.LEGACY,
        nft2022: true,
      });

      const { txId } = await executeIncrease({ sendAndConfirm: true });
      console.log("Increased liquidity in existing position:", { txId });

      await new Promise(r => setTimeout(r, 4000));
    });


    it("decreases liquidity", async () => {
      const data = await raydium.api.fetchPoolById({ ids: POOL_STATE.toBase58() })
      let poolKeys: ClmmKeys | undefined
      const poolInfo = data[0] as ApiV3PoolInfoConcentratedItem;

      // Find the existing position created in the open position test
      const existingPositions = await raydium.clmm.getOwnerPositionInfo({
        programId: poolInfo.programId,
      });

      if (!existingPositions.length) throw new Error('user do not have any positions')

      const existingPosition = existingPositions.find((p) => p.poolId.toBase58() === poolInfo.id);

      if (!existingPosition) throw new Error(`user do not have position in pool: ${poolInfo.id}`)

      const { execute } = await raydium.clmm.decreaseLiquidity({
        poolInfo,
        poolKeys,
        ownerPosition: existingPosition,
        ownerInfo: {
          useSOLBalance: true,
          closePosition: false,
        },
        // Remove half liquidity
        liquidity: existingPosition.liquidity.divn(2),
        amountMinA: new BN(0),
        amountMinB: new BN(0),
        txVersion: TxVersion.LEGACY,
      });

      const { txId } = await execute({ sendAndConfirm: true });
      console.log("Decreased liquidity from existing position:", { txId });
    });
  });
});
