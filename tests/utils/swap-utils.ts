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
    createAssociatedTokenAccountInstruction
} from "@solana/spl-token";
import BN from "bn.js";
import { Raydium, PoolUtils } from "@raydium-io/raydium-sdk-v2";

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


export async function findOptimalPool(
    connection: Connection,
    wallet: PublicKey,
    mintA: PublicKey,
    mintB: PublicKey,
    amountIn: BN,
    isBaseInput: boolean
): Promise<PoolSelectionResult> {
    try {
        const raydium = await Raydium.load({ connection, owner: wallet, disableLoadToken: true });

        // Fetch all CLMM pools for this pair
        const poolData = await raydium.api.fetchPoolByMints({ mint1: mintA.toBase58(), mint2: mintB.toBase58() });

        const poolList = Array.isArray(poolData) ? poolData : (poolData as any).data || [];

        //  Filter to only CLMM pools
        const clmmPools = poolList.filter((p) => p.programId === CLMM_PROGRAM);

        if (clmmPools.length === 0) {
            throw new Error(`No CLMM pools found for ${mintA.toBase58()}/${mintB.toBase58()}`);
        }

        console.log(`Found ${clmmPools.length} CLMM pools.`);

        const results = [];

        for (const pool of clmmPools) {
            try {
                // Fetch live pool data
                const { poolInfo, poolKeys, computePoolInfo, tickData } = await raydium.clmm.getPoolInfoFromRpc(pool.id);
                const epochInfo = await connection.getEpochInfo();

                // Compute the amount out
                const quote = PoolUtils.computeAmountOutFormat({
                    poolInfo: computePoolInfo,
                    tickArrayCache: tickData[pool.id],
                    amountIn: new BN(amountIn),
                    tokenOut: isBaseInput ? computePoolInfo.mintB : computePoolInfo.mintA,
                    slippage: 0.01,
                    epochInfo: epochInfo,
                });

                if (quote?.amountOut) {
                    const outputAmount = new BN(quote.amountOut.amount.raw.toString());
                    const rate = isBaseInput 
                        ? outputAmount.toNumber() / amountIn.toNumber()  // exact in: output/input
                        : amountIn.toNumber() / outputAmount.toNumber(); // exact out: input/output

                    results.push({
                        poolId: pool.id,
                        output: outputAmount,
                        priceImpact: quote.priceImpact?.toString() || "0",
                        fee: quote.fee?.toString() || "0",
                        rate: rate,
                        pool: pool,
                        poolKeys: poolKeys
                    });

                    console.log(
                        `Pool ${pool.id.slice(0, 8)} | out: ${outputAmount.toString()} | impact: ${quote.priceImpact?.toFixed(4) || "0"} | fee: ${quote.fee.raw?.toString() || "0"}`
                    );
                }
            } catch (err: any) {
                console.log(`SDK simulation failed for ${pool.id}: ${err.message}`);
            }
        }

        if (results.length === 0) {
            throw new Error("No valid pool found with sufficient liquidity");
        }

        // Pick the best output
        const best = isBaseInput 
            ? results.sort((a, b) => b.output.sub(a.output).toNumber())[0] 
            : results.sort((a, b) => a.output.sub(b.output).toNumber())[0];

        console.log("\nSelected optimal CLMM pool:");
        console.log(`   Pool ID: ${best.poolId}`);
        console.log(`   Expected Output: ${best.output.toString()}`);
        console.log(`   Rate: ${best.rate.toFixed(6)} USDC per WSOL`);
        console.log(`   Fee: ${best.fee.toString()}`);
        
        console.log("bestOutput", best.output);

        return {
            bestPool: best.pool,
            bestOutput: best.output,
            bestRate: best.rate,
            poolKeys: best.poolKeys
        };
    } catch (error: any) {
        console.error("findOptimalPool() failed:", error.message);
        throw error;
    }
}


