import {
    PublicKey,
    Transaction,
    SystemProgram,
    LAMPORTS_PER_SOL,
    Connection
} from "@solana/web3.js";
import {
    getAssociatedTokenAddressSync,
    createSyncNativeInstruction,
    getAccount,
    createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import BN from "bn.js";
import * as pkg from '@raydium-io/raydium-sdk-v2';
const { Raydium, PoolUtils } = pkg;

export interface PoolSelectionResult {
    bestPool: any;
    bestOutput: BN;
    bestRate: number;
    poolKeys: any;
}

const CLMM_PROGRAM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";

/**
 * Ensures that a user's associated token account (ATA) exists for a given mint.
 * Creates it if it doesn't.
 */
export async function ensureTokenAccount(provider: any, mint: PublicKey, owner: PublicKey) {
    const wallet = provider.wallet.publicKey;
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

export async function wrapSolToWsol(
    provider: any,
    wallet: PublicKey,
    wsolAta: PublicKey,
    solAmount: number
) {
    const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
    const tx = new Transaction().add(
        SystemProgram.transfer({
            fromPubkey: wallet,
            toPubkey: wsolAta,
            lamports,
        }),
        createSyncNativeInstruction(wsolAta)
    );

    const sig = await provider.sendAndConfirm(tx);
    console.log(`Wrapped ${solAmount} SOL into WSOL (tx: ${sig})`);
}

/**
 * Finds the optimal CLMM pool for an exact-in swap.
 * Given an input amount (mintA → mintB), returns the pool yielding the highest output.
 */
export async function findOptimalPoolExactIn(
    connection: Connection,
    wallet: PublicKey,
    mintA: PublicKey,
    mintB: PublicKey,
    amountIn: BN,
): Promise<PoolSelectionResult> {
    try {
        const raydium = await Raydium.load({ connection, owner: wallet, disableLoadToken: true });

        // Fetch all CLMM pools for this pair
        const poolData = await raydium.api.fetchPoolByMints({
            mint1: mintA.toBase58(),
            mint2: mintB.toBase58()
        });
        const poolList = Array.isArray(poolData) ? poolData : (poolData as any).data || [];
        const clmmPools = poolList.filter((p) => p.programId === CLMM_PROGRAM);

        if (clmmPools.length === 0) {
            throw new Error(`No CLMM pools found for ${mintA.toBase58()}/${mintB.toBase58()}`);
        }

        console.log(`Found ${clmmPools.length} CLMM pools.`);

        const results = [];
        const epochInfo = await connection.getEpochInfo();

        // Simulate swap for each pool
        for (const pool of clmmPools) {
            try {
                const { poolKeys, computePoolInfo, tickData } = await raydium.clmm.getPoolInfoFromRpc(pool.id);

                const quote = PoolUtils.computeAmountOutFormat({
                    poolInfo: computePoolInfo,
                    tickArrayCache: tickData[pool.id],
                    amountIn: new BN(amountIn),
                    tokenOut: computePoolInfo.mintB,
                    slippage: 0.01,
                    epochInfo,
                });

                if (quote?.amountOut) {
                    const outputAmount = new BN(quote.amountOut.amount.raw.toString());
                    const rate = outputAmount.toNumber() / amountIn.toNumber();

                    results.push({
                        poolId: pool.id,
                        output: outputAmount,
                        priceImpact: quote.priceImpact?.toString() || "0",
                        fee: quote.fee?.toString() || "0",
                        rate,
                        pool,
                        poolKeys
                    });
                }
            } catch (err: any) {
                console.log(`SDK simulation failed for ${pool.id}: ${err.message}`);
            }
        }

        if (results.length === 0) {
            throw new Error("No valid pool found with sufficient liquidity");
        }

        // Select pool with highest output
        const best = results.sort((a, b) => b.output.sub(a.output).toNumber())[0];

        console.log("\n Selected optimal CLMM pool:");
        console.log(`   Pool ID: ${best.poolId}`);
        console.log(`   Expected Output: ${best.output.toString()}`);
        console.log(`   Rate: ${best.rate.toFixed(6)} USDC per WSOL`);
        console.log(`   Fee: ${best.fee.toString()}`);

        return {
            bestPool: best.pool,
            bestOutput: best.output,
            bestRate: best.rate,
            poolKeys: best.poolKeys
        };
    } catch (error: any) {
        console.error("findOptimalPoolExactIn() failed:", error.message);
        throw error;
    }
}

/**
 * Finds the optimal CLMM pool for an exact-out swap.
 * Given a desired output amount, returns the pool requiring the least input.
 */
export async function findOptimalPoolExactOut(
    connection: Connection,
    wallet: PublicKey,
    mintA: PublicKey,
    mintB: PublicKey,
    desiredOutput: BN
): Promise<{
    bestPool: ApiV3PoolInfoConcentratedItem;
    poolKeys: ComputeClmmPoolInfo;
    computePoolInfo: ComputeClmmPoolInfo;
    amountIn: BN;
    maxAmountIn: BN;
    realAmountOut: BN;
    remainingAccounts: any[];
}> {
    const raydium = await Raydium.load({ connection, owner: wallet, disableLoadToken: true });
    const epochInfo = await connection.getEpochInfo();

    // Fetch pools for this pair
    const poolData = await raydium.api.fetchPoolByMints({
        mint1: mintA.toBase58(),
        mint2: mintB.toBase58(),
    });
    const poolList = Array.isArray(poolData) ? poolData : (poolData as any).data || [];
    // const clmmPools = poolList.filter((p) => p.programId === CLMM_PROGRAM && p.id == "EXHyQxMSttcvLPwjENnXCPZ8GmLjJYHtNBnAkcFeFKMn");
    const clmmPools = poolList.filter((p) => p.programId === CLMM_PROGRAM);

    if (clmmPools.length === 0) {
        throw new Error(`No CLMM pools found for ${mintA.toBase58()}/${mintB.toBase58()}`);
    }

    const results = [];

    // Simulate swap for each pool
    for (const pool of clmmPools) {
        try {
            const { poolInfo, poolKeys, computePoolInfo, tickData } = await raydium.clmm.getPoolInfoFromRpc(pool.id);

            const isMintAOutput = poolInfo.mintA.address === mintB.toBase58();
            const isMintBOutput = poolInfo.mintB.address === mintB.toBase58();

            if (!isMintAOutput && !isMintBOutput) {
                console.log(`Skipping ${pool.id} — target output mint not in pool`);
                continue;
            }

            const outputMint = isMintAOutput
                ? new PublicKey(poolInfo.mintA.address)
                : new PublicKey(poolInfo.mintB.address);

            // Compute required input for exact output
            const { amountIn, maxAmountIn, realAmountOut, remainingAccounts } = await PoolUtils.computeAmountIn({
                poolInfo: computePoolInfo,
                tickArrayCache: tickData[pool.id],
                amountOut: desiredOutput,
                baseMint: outputMint,
                slippage: 0.01,
                epochInfo,
            });

            const rate = desiredOutput.toNumber() / maxAmountIn.amount.toNumber();

            results.push({
                poolId: pool.id,
                poolInfo,
                poolKeys,
                computePoolInfo,
                amountIn: amountIn.amount,
                maxAmountIn: maxAmountIn.amount,
                realAmountOut: realAmountOut.amount,
                rate,
                remainingAccounts,
            });
        } catch (err: any) {
            console.log(`Simulation failed for ${pool.id}: ${err.message}`);
        }
    }

    if (results.length === 0) {
        throw new Error("No valid pool found with sufficient liquidity");
    }

    // Select pool with lowest max input (best rate)
    const best = results.sort((a, b) => a.maxAmountIn.sub(b.maxAmountIn).toNumber())[0];

    console.log("\nBest pool for exact out:");
    console.log(`Pool ID: ${best.poolId}`);
    console.log(`Rate: ${best.rate.toFixed(6)} USDC per WSOL`);
    console.log(`Max Input: ${best.maxAmountIn.toString()}`);
    console.log(`Real Output: ${best.realAmountOut.toString()}`);
    console.log(`Amount In: ${best.amountIn.toString()}`);

    return {
        bestPool: best.poolInfo,
        poolKeys: best.poolKeys,
        computePoolInfo: best.computePoolInfo,
        amountIn: best.amountIn,
        maxAmountIn: best.maxAmountIn,
        realAmountOut: best.realAmountOut,
        remainingAccounts: best.remainingAccounts,
    };

}
