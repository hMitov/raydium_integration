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
const { Raydium, PoolUtils, TickUtils } = pkg;

const CLMM_PROGRAM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const SUMULATION_SWAP_SLIPPAGE = 0.01;

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
        console.log(`Creating ATA for ${mint.toBase58()}`);
        const tx = new Transaction().add(
            createAssociatedTokenAccountInstruction(wallet, ata, owner, mint)
        );
        await provider.sendAndConfirm(tx);
        console.log(`Created ATA: ${ata.toBase58()}`);
    }

    return ata;
}

/**
 * Wraps SOL into WSOL for a given wallet.
 */
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
): Promise<any> {
    try {
        const raydium = await Raydium.load({
            connection,
            owner: wallet,
            disableLoadToken: true,
        });

        const poolData = await raydium.api.fetchPoolByMints({
            mint1: mintA.toBase58(),
            mint2: mintB.toBase58(),
        });

        const poolList = Array.isArray(poolData)
            ? poolData
            : (poolData as any).data || [];

        const clmmPools = poolList.filter(
            (p) => p.programId === CLMM_PROGRAM
        );

        if (!clmmPools.length) {
            throw new Error(
                `No CLMM pools found for ${mintA.toBase58()}/${mintB.toBase58()}`
            );
        }

        const results: any[] = [];
        const epochInfo = await connection.getEpochInfo();

        // Simulate swap for each pool
        for (const pool of clmmPools) {
            try {
                const { poolInfo, poolKeys, computePoolInfo, tickData } = await raydium.clmm.getPoolInfoFromRpc(pool.id)

                // Check if pool is approved for swaps by reading the status bit
                const poolAccount = await connection.getAccountInfo(new PublicKey(pool.id));
                if (!poolAccount) {
                    console.log(`Skipping ${pool.id} — pool account not found`);
                    continue;
                }

                // Read the status field from the pool state account
                const status = poolAccount.data.readUInt32LE(8);
                const swapBit = status & 1; // Check if swap bit (bit 0) is set

                if (swapBit === 0) {
                    continue;
                }

                // Check if the pool has any tick arrays available
                if (!tickData[pool.id] || Object.keys(tickData[pool.id]).length === 0) {
                    console.log(`Skipping pool ${pool.id} - no tick arrays available`);
                    continue;
                }

                const quote = PoolUtils.computeAmountOutFormat({
                    poolInfo: computePoolInfo,
                    tickArrayCache: tickData[pool.id],
                    amountIn: new BN(amountIn),
                    tokenOut: computePoolInfo.mintB,
                    slippage: SUMULATION_SWAP_SLIPPAGE,
                    epochInfo,
                });

                if (quote?.amountOut) {
                    const outputAmount = new BN(quote.amountOut.amount.raw.toString());
                    const rate = outputAmount.toNumber() / amountIn.toNumber();

                    results.push({
                        poolId: pool.id,
                        poolInfo,
                        outputAmount,
                        priceImpact: quote.priceImpact?.toString(),
                        fee: quote.fee?.toString(),
                        rate,
                        pool,
                        poolKeys,
                        computePoolInfo
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
        const best = results.sort((a, b) => b.outputAmount.sub(a.outputAmount).toNumber())[0];

        console.log("\n Best pool for exact in:");
        console.log(`   Pool ID: ${best.poolId}`);
        console.log(`   Expected Output: ${best.outputAmount.toString()}`);
        console.log(`   Rate: ${best.rate.toFixed(6)} USDC per WSOL`);
        console.log(`   Fee: ${best.fee.toString()}`);

        return {
            poolInfo: best.poolInfo,
            poolKeys: best.poolKeys,
            computePoolInfo: best.computePoolInfo,
            amountOut: best.outputAmount,
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
): Promise<any> {
    const raydium = await Raydium.load({
        connection,
        owner: wallet,
        disableLoadToken: true,
    });

    const epochInfo = await connection.getEpochInfo();

    const poolData = await raydium.api.fetchPoolByMints({
        mint1: mintA.toBase58(),
        mint2: mintB.toBase58(),
    });

    const poolList = Array.isArray(poolData)
        ? poolData
        : (poolData as any).data || [];

    const clmmPools = poolList.filter(
        (p) => p.programId === CLMM_PROGRAM
    );

    if (!clmmPools.length)
        throw new Error(
            `No CLMM pools found for ${mintA.toBase58()}/${mintB.toBase58()}`
        );

    const results: any[] = [];

    // Simulate swap for each pool
    for (const pool of clmmPools) {
        try {
            const { poolInfo, poolKeys, computePoolInfo, tickData } = await raydium.clmm.getPoolInfoFromRpc(pool.id)

            console.log("tickCurrent on find optimal pool: ", computePoolInfo.tickCurrent);

            // Check if pool is approved for swaps by reading the status bit
            const poolAccount = await connection.getAccountInfo(new PublicKey(pool.id));
            if (!poolAccount) {
                console.log(`Skipping ${pool.id} — pool account not found`);
                continue;
            }

            // Read the status field from the pool state account
            const status = poolAccount.data.readUInt32LE(8);
            const swapBit = status & 1; // Check if swap bit (bit 0) is set

            if (swapBit === 0) {
                continue;
            }

            const isMintAOutput = poolInfo.mintA.address === mintB.toBase58();
            const isMintBOutput = poolInfo.mintB.address === mintB.toBase58();

            if (!isMintAOutput && !isMintBOutput) {
                console.log(`Skipping ${pool.id} — target output mint not in pool`);
                continue;
            }

            const outputMint = isMintAOutput
                ? new PublicKey(poolInfo.mintA.address)
                : new PublicKey(poolInfo.mintB.address);

            // Check if the pool has any tick arrays available
            if (!tickData[pool.id] || Object.keys(tickData[pool.id]).length === 0) {
                console.log(`Skipping pool ${pool.id} - no tick arrays available`);
                continue;
            }

            const { amountIn, maxAmountIn, realAmountOut, remainingAccounts } = await PoolUtils.computeAmountIn({
                poolInfo: computePoolInfo,
                tickArrayCache: tickData[pool.id],
                amountOut: desiredOutput,
                baseMint: outputMint,
                slippage: SUMULATION_SWAP_SLIPPAGE,
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
        poolInfo: best.poolInfo,
        poolKeys: best.poolKeys,
        computePoolInfo: best.computePoolInfo,
        amountIn: best.amountIn,
        maxAmountIn: best.maxAmountIn,
    };
}

/**
 * Finds the correct tick array for a swap operation
 * 
 * @param poolInfo - The pool information from Raydium SDK
 * @param zeroForOne - Whether this is a zero_for_one swap (token0 -> token1)
 * @returns The tick array address to use for the swap
 */
export async function findCorrectTickArray(
    poolInfo: any,
    zeroForOne: boolean
): Promise<PublicKey> {
    const currentTick = poolInfo.tickCurrent;
    const tickSpacing = poolInfo.tickSpacing;

    console.log(`Finding tick array for current tick: ${currentTick}, zeroForOne: ${zeroForOne}`);

    // Calculate the current tick array start index
    const currentTickArrayStartIndex = TickUtils.getTickArrayStartIndexByTick(currentTick, tickSpacing);
    console.log(`Current tick array start index: ${currentTickArrayStartIndex}`);

    // Get all initialized tick arrays for this pool
    const allTickArrays = TickUtils.getAllInitializedTickArrayInfo(
        new PublicKey(CLMM_PROGRAM),
        new PublicKey(poolInfo.id),
        poolInfo.tickArrayBitmap,
        poolInfo.exBitmapInfo,
        tickSpacing
    );

    console.log(`Found ${allTickArrays.length} initialized tick arrays`);

    // Check if current tick array is initialized
    let isCurrentTickArrayInitialized = false;
    let firstTickArrayInfo = null;

    for (const tickArrayInfo of allTickArrays) {
        if (tickArrayInfo.tickArrayStartIndex === currentTickArrayStartIndex) {
            isCurrentTickArrayInitialized = true;
            firstTickArrayInfo = tickArrayInfo;
            console.log(`Current tick array is initialized: ${tickArrayInfo.tickArrayAddress.toBase58()}`);
            break;
        }
    }

    // If current tick array is not initialized, find the next one
    if (!isCurrentTickArrayInitialized) {
        console.log("Current tick array is not initialized, finding next initialized tick array");

        // Sort tick arrays by start index to find the closest one
        const sortedTickArrays = allTickArrays.sort((a, b) => a.tickArrayStartIndex - b.tickArrayStartIndex);

        if (zeroForOne) {
            // For zero_for_one, find the tick array with the highest start index <= currentTickArrayStartIndex
            let bestTickArray = null;
            let bestStartIndex = -Infinity;

            for (const tickArrayInfo of sortedTickArrays) {
                const tickArrayStartIndex = tickArrayInfo.tickArrayStartIndex;

                if (tickArrayStartIndex <= currentTickArrayStartIndex && tickArrayStartIndex > bestStartIndex) {
                    bestTickArray = tickArrayInfo;
                    bestStartIndex = tickArrayStartIndex;
                }
            }

            if (bestTickArray) {
                firstTickArrayInfo = bestTickArray;
                console.log(`Found next tick array (zero_for_one): ${bestTickArray.tickArrayAddress.toBase58()}, start=${bestStartIndex}`);
            }
        } else {
            // For one_for_zero, find the tick array with the lowest start index >= currentTickArrayStartIndex
            let bestTickArray = null;
            let bestStartIndex = Infinity;

            for (const tickArrayInfo of sortedTickArrays) {
                const tickArrayStartIndex = tickArrayInfo.tickArrayStartIndex;

                if (tickArrayStartIndex >= currentTickArrayStartIndex && tickArrayStartIndex < bestStartIndex) {
                    bestTickArray = tickArrayInfo;
                    bestStartIndex = tickArrayStartIndex;
                }
            }

            if (bestTickArray) {
                firstTickArrayInfo = bestTickArray;
                console.log(`Found next tick array (one_for_zero): ${bestTickArray.tickArrayAddress.toBase58()}, start=${bestStartIndex}`);
            }
        }
    }

    if (!firstTickArrayInfo) {
        throw new Error(`No initialized tick array found for current tick ${currentTick}`);
    }

    const tickArrayAddr = firstTickArrayInfo.tickArrayAddress;
    console.log("Using tick array: ", tickArrayAddr.toBase58());

    return tickArrayAddr;
}
