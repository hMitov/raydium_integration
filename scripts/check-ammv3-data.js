import fetch from 'node-fetch'

async function checkAmmV3Data() {
  try {
    console.log('Checking ammV3 data structure...')
    
    const response = await fetch('https://api.raydium.io/v2/ammV3/ammPools')
    const data = await response.json()
    
    console.log('Data structure:')
    console.log('Keys:', Object.keys(data))
    
    if (data.data) {
      console.log('\nData.data type:', typeof data.data)
      console.log('Data.data length:', Array.isArray(data.data) ? data.data.length : 'Not an array')
      
      if (Array.isArray(data.data) && data.data.length > 0) {
        console.log('\nFirst few items:')
        data.data.slice(0, 3).forEach((item, i) => {
          console.log(`\n--- Item ${i + 1} ---`)
          console.log(JSON.stringify(item, null, 2))
        })
        
        // Check what fields are available in the pool data
        console.log('\n--- Pool Data Fields Analysis ---')
        if (data.data.length > 0) {
          const samplePool = data.data[0]
          console.log('Available fields:', Object.keys(samplePool))
          console.log('Program ID field:', samplePool.programId)
          console.log('Type field:', samplePool.type)
          console.log('AmmType field:', samplePool.ammType)
        }
        
        // Look for AMM v3 pools - try different identification methods
        const ammV3Pools = data.data.filter(pool => {
          return pool.programId === '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8' ||
                 pool.type === 'AMM' ||
                 pool.ammType === 'AMM' ||
                 pool.ammType === 'AMM_V3' ||
                 (pool.id && !pool.id.includes('CLMM')) ||
                 // Check if it has AMM v3 specific fields
                 (pool.ammConfig && pool.ammConfig.tradeFeeRate && pool.ammConfig.tradeFeeRate > 1000)
        })
        
        if (ammV3Pools.length > 0) {
          console.log(`\n🎉 Found ${ammV3Pools.length} potential AMM v3 pools!`)
          ammV3Pools.slice(0, 5).forEach((pool, i) => {
            console.log(`\n--- AMM v3 Pool ${i + 1} ---`)
            console.log('Pool ID:', pool.id)
            console.log('Program ID:', pool.programId || 'undefined')
            console.log('Type:', pool.type || 'undefined')
            console.log('AmmType:', pool.ammType || 'undefined')
            console.log('Mint A:', pool.mintA)
            console.log('Mint B:', pool.mintB)
            console.log('Vault A:', pool.vaultA)
            console.log('Vault B:', pool.vaultB)
            console.log('AMM Config:', pool.ammConfig?.id)
            console.log('Trade Fee Rate:', pool.ammConfig?.tradeFeeRate)
            console.log('Tick Spacing:', pool.ammConfig?.tickSpacing)
          })
        } else {
          console.log('\nNo AMM v3 pools found in ammV3 data')
        }
        
        // Also check for CLMM pools
        const clmmPools = data.data.filter(pool => {
          return pool.programId === 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK' ||
                 pool.type === 'CLMM' ||
                 pool.ammType === 'CLMM' ||
                 (pool.id && pool.id.includes('CLMM'))
        })
        
        if (clmmPools.length > 0) {
          console.log(`\n🎉 Found ${clmmPools.length} CLMM pools!`)
          clmmPools.slice(0, 2).forEach((pool, i) => {
            console.log(`\n--- CLMM Pool ${i + 1} ---`)
            console.log('Pool ID:', pool.id)
            console.log('Program ID:', pool.programId)
            console.log('Mint A:', pool.mintA)
            console.log('Mint B:', pool.mintB)
            console.log('Vault A:', pool.vaultA)
            console.log('Vault B:', pool.vaultB)
          })
        } else {
          console.log('\nNo CLMM pools found in ammV3 data')
        }
      }
    }
    
  } catch (error) {
    console.error('Error:', error)
  }
}

checkAmmV3Data()
