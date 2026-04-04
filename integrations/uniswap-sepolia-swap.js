/**
 * Uniswap Sepolia Swap Executor — Trading API Integration
 * 
 * Uses the OFFICIAL Uniswap Trading API (https://trade-api.gateway.uniswap.org)
 * with a valid API key to get optimal quotes and execute swaps on Sepolia.
 * 
 * Flow:
 *   1. POST /v1/quote — get optimal route (V2/V3/UniswapX)
 *   2. Handle Permit2 if needed (sign EIP-712 typed data)
 *   3. POST /v1/swap — get unsigned transaction calldata
 *   4. Sign + broadcast via wallet
 * 
 * Fallback: Direct V2 pair interaction when API is unavailable
 * 
 * Part of the SAMM DEX integration layer.
 */

const { ethers } = require('ethers');

// ─── Uniswap Trading API Config ──────────────────────────────────────────
const UNISWAP_API_BASE = 'https://trade-api.gateway.uniswap.org/v1';

// ─── Sepolia Contract Addresses ───────────────────────────────────────────
const ADDRESSES = {
  UNIVERSAL_ROUTER: '0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b',
  V2_FACTORY: '0xB7f907f7A9eBC822a80BD25E224be42Ce0A698A0',
  WETH9: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
  PERMIT2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  USDC: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  USDT: '0x7169D38820dfd117C3FA1f22a697dBA58d90BA06',
  DAI: '0x68194a729C2450ad26072b3D33ADaCbcef39D574',
  LINK: '0x779877A7B0D9E8603169DdbD7836e478b4624789',
  ROME: '0xbF23b6361146D7b1756bD68651aF6cb83bD1bcA0',
  NATIVE_ETH: '0x0000000000000000000000000000000000000000',
};

// ABIs
const WETH_ABI = [
  'function deposit() external payable',
  'function withdraw(uint256) external',
  'function balanceOf(address) external view returns (uint256)',
  'function transfer(address, uint256) external returns (bool)',
  'function approve(address, uint256) external returns (bool)',
];

const V2_PAIR_ABI = [
  'function getReserves() external view returns (uint112, uint112, uint32)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external',
];

const V2_FACTORY_ABI = [
  'function getPair(address, address) external view returns (address)',
];

const ERC20_ABI = [
  'function balanceOf(address) external view returns (uint256)',
  'function approve(address, uint256) external returns (bool)',
  'function allowance(address, address) external view returns (uint256)',
  'function symbol() external view returns (string)',
  'function decimals() external view returns (uint8)',
];

class UniswapSepoliaSwap {
  /**
   * @param {string} privateKey - Wallet private key
   * @param {string} rpcUrl - Sepolia RPC endpoint
   * @param {string|null} apiKey - Uniswap Trading API key (from developer.uniswap.org)
   */
  constructor(privateKey, rpcUrl = 'https://ethereum-sepolia-rpc.publicnode.com', apiKey = null) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.weth = new ethers.Contract(ADDRESSES.WETH9, WETH_ABI, this.wallet);
    this.factory = new ethers.Contract(ADDRESSES.V2_FACTORY, V2_FACTORY_ABI, this.provider);
    this.apiKey = apiKey || process.env.UNISWAP_API_KEY;
    this.swapHistory = [];

    if (this.apiKey) {
      console.log('[UniswapSepoliaSwap] Initialized with Uniswap Trading API key');
    } else {
      console.log('[UniswapSepoliaSwap] No API key — direct V2 pair fallback only');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  UNISWAP TRADING API — PRIMARY PATH
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Get a quote from the Uniswap Trading API
   * POST /v1/quote with x-api-key header
   */
  async getAPIQuote(tokenIn, tokenOut, amount, type = 'EXACT_INPUT', slippageTolerance = 5.0) {
    if (!this.apiKey) throw new Error('Uniswap API key required for getAPIQuote');

    const body = {
      tokenIn,
      tokenOut,
      tokenInChainId: 11155111,
      tokenOutChainId: 11155111,
      type,
      amount: amount.toString(),
      swapper: this.wallet.address,
      slippageTolerance,
    };

    console.log(`[UniswapAPI] Quote: ${tokenIn} -> ${tokenOut}, amount=${amount}, type=${type}, chain=sepolia`);

    const resp = await fetch(`${UNISWAP_API_BASE}/quote`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      const msg = err.detail || err.message || err.error || JSON.stringify(err);
      console.log(`[UniswapAPI] Quote error ${resp.status}: ${msg}`);
      throw new Error(`Uniswap API ${resp.status}: ${msg}`);
    }

    const data = await resp.json();
    console.log(`[UniswapAPI] Quote received — routing: ${data.routing}`);
    return data;
  }

  /**
   * Execute a full swap via the Uniswap Trading API:
   *   1. Get quote  
   *   2. Sign Permit2 (if needed)
   *   3. POST /v1/swap (CLASSIC) or /v1/order (UniswapX)
   *   4. Sign & broadcast the returned transaction
   */
  async executeAPISwap(tokenIn, tokenOut, amount, opts = {}) {
    const { type = 'EXACT_INPUT', slippageTolerance = 5.0 } = opts;
    console.log(`[UniswapAPI] Swap: ${tokenIn === ADDRESSES.NATIVE_ETH ? 'ETH' : tokenIn} -> ${tokenOut}`);

    // Step 1: Get quote
    const quoteData = await this.getAPIQuote(tokenIn, tokenOut, amount, type, slippageTolerance);
    const routing = quoteData.routing;

    // Step 2: Handle Permit2 signature if required
    let signature = undefined;
    const permitData = quoteData.permitData || null;
    if (permitData) {
      console.log(`[UniswapAPI] Signing Permit2 typed data...`);
      signature = await this.wallet.signTypedData(
        permitData.domain,
        permitData.types,
        permitData.values
      );
      console.log(`[UniswapAPI] Permit2 signed`);
    }

    // Step 3: Get unsigned transaction calldata
    let swapResponse;
    if (routing === 'CLASSIC' || routing === 'WRAP' || routing === 'UNWRAP' || routing === 'BRIDGE') {
      const swapBody = { quote: quoteData.quote };
      if (signature && permitData) {
        swapBody.signature = signature;
        swapBody.permitData = permitData;
      }
      console.log(`[UniswapAPI] POST /v1/swap (routing: ${routing})...`);
      const swapResp = await fetch(`${UNISWAP_API_BASE}/swap`, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(swapBody),
        signal: AbortSignal.timeout(15000),
      });
      if (!swapResp.ok) {
        const err = await swapResp.json().catch(() => ({}));
        throw new Error(`Uniswap /swap ${swapResp.status}: ${err.detail || err.message || JSON.stringify(err)}`);
      }
      swapResponse = await swapResp.json();
    } else {
      // UniswapX order flow
      const orderBody = { quote: quoteData.quote, signature };
      console.log(`[UniswapAPI] POST /v1/order (routing: ${routing})...`);
      const orderResp = await fetch(`${UNISWAP_API_BASE}/order`, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(orderBody),
        signal: AbortSignal.timeout(15000),
      });
      if (!orderResp.ok) {
        const err = await orderResp.json().catch(() => ({}));
        throw new Error(`Uniswap /order ${orderResp.status}: ${err.detail || err.message || JSON.stringify(err)}`);
      }
      swapResponse = await orderResp.json();
    }

    // Step 4: Sign and broadcast the transaction
    const txRequest = swapResponse.swap || swapResponse;
    if (!txRequest.data || txRequest.data === '' || txRequest.data === '0x') {
      throw new Error('Invalid transaction: empty data field from Uniswap API');
    }
    console.log(`[UniswapAPI] Signing tx to ${txRequest.to}`);

    const tx = await this.wallet.sendTransaction({
      to: txRequest.to,
      data: txRequest.data,
      value: txRequest.value ? BigInt(txRequest.value) : 0n,
      gasLimit: txRequest.gasLimit ? BigInt(txRequest.gasLimit) : 500000n,
      chainId: 11155111,
    });
    console.log(`[UniswapAPI] Broadcast tx: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`[UniswapAPI] Confirmed block=${receipt.blockNumber} gas=${receipt.gasUsed}`);

    if (receipt.status !== 1) {
      throw new Error(`Transaction reverted: ${tx.hash}`);
    }

    const result = {
      txHash: tx.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      routing,
      tokenIn,
      tokenOut,
      amountIn: (quoteData.quote?.amountIn || amount).toString(),
      amountOut: (quoteData.quote?.amountOut || '0').toString(),
      method: `uniswap-trading-api-${routing.toLowerCase()}`,
      source: 'Uniswap Trading API',
      chainId: 11155111,
      timestamp: Date.now(),
      status: 'SUCCESS',
    };
    this.swapHistory.push(result);
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  FRONTEND-COMPATIBLE FLOW (user signs in MetaMask, not server)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Step 1: Get a quote + Permit2 data for a user's wallet.
   * Returns everything the frontend needs so the user can sign in MetaMask.
   * Backend does NOT sign anything — it only proxies the quote.
   *
   * @param {string} userAddress — The user's MetaMask wallet address
   * @param {string} tokenIn — Input token address
   * @param {string} tokenOut — Output token address
   * @param {string} amount — Amount in wei
   * @param {object} opts — { type, slippageTolerance }
   * @returns {object} — { quote, permitData, routing, ... } for MetaMask
   */
  async prepareSwapForUser(userAddress, tokenIn, tokenOut, amount, opts = {}) {
    if (!this.apiKey) throw new Error('Uniswap API key required');
    const { type = 'EXACT_INPUT', slippageTolerance = 5.0 } = opts;

    const body = {
      tokenIn,
      tokenOut,
      tokenInChainId: 11155111,
      tokenOutChainId: 11155111,
      type,
      amount: amount.toString(),
      swapper: userAddress, // User's address, NOT the server wallet
      slippageTolerance,
    };

    console.log(`[PrepareForUser] Quote for ${userAddress}: ${tokenIn} -> ${tokenOut}`);

    const resp = await fetch(`${UNISWAP_API_BASE}/quote`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(`Uniswap API ${resp.status}: ${err.detail || err.message || JSON.stringify(err)}`);
    }

    const data = await resp.json();
    const isNativeETH = tokenIn === ADDRESSES.NATIVE_ETH;

    return {
      success: true,
      routing: data.routing,
      quote: data.quote,
      permitData: data.permitData || null,
      needsPermit2Signature: !!data.permitData,
      needsTokenApproval: !isNativeETH,
      permit2Address: ADDRESSES.PERMIT2,
      userAddress,
      tokenIn,
      tokenOut,
      amount: amount.toString(),
      type,
      slippageTolerance,
      instructions: {
        step1: isNativeETH
          ? 'Native ETH — no approval needed'
          : `Approve token ${tokenIn} for Permit2 (${ADDRESSES.PERMIT2}) if not already approved`,
        step2: data.permitData
          ? 'Sign the permitData using wallet.signTypedData(permitData.domain, permitData.types, permitData.values)'
          : 'No Permit2 signature needed for this swap',
        step3: 'POST /swap/sepolia/execute with { quote, signature, permitData }',
        step4: 'Sign the returned transaction and broadcast via MetaMask',
      },
    };
  }

  /**
   * Step 2: Get unsigned transaction calldata using the user's Permit2 signature.
   * Backend calls /v1/swap and returns the unsigned tx for MetaMask to sign.
   *
   * @param {object} quote — The quote object from prepareSwapForUser
   * @param {string|null} signature — The user's Permit2 signature (from MetaMask)
   * @param {object|null} permitData — The permitData from the quote
   * @param {string} routing — CLASSIC, WRAP, UNWRAP, etc.
   * @returns {object} — Unsigned transaction { to, data, value, chainId }
   */
  async getSwapCalldata(quote, signature, permitData, routing) {
    if (!this.apiKey) throw new Error('Uniswap API key required');

    if (routing === 'CLASSIC' || routing === 'WRAP' || routing === 'UNWRAP' || routing === 'BRIDGE') {
      const swapBody = { quote };
      if (signature && permitData) {
        swapBody.signature = signature;
        swapBody.permitData = permitData;
      }

      console.log(`[SwapCalldata] POST /v1/swap (routing: ${routing})...`);
      const swapResp = await fetch(`${UNISWAP_API_BASE}/swap`, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(swapBody),
        signal: AbortSignal.timeout(15000),
      });

      if (!swapResp.ok) {
        const err = await swapResp.json().catch(() => ({}));
        throw new Error(`Uniswap /swap ${swapResp.status}: ${err.detail || err.message || JSON.stringify(err)}`);
      }

      const swapResponse = await swapResp.json();
      const txRequest = swapResponse.swap || swapResponse;

      return {
        success: true,
        unsignedTransaction: {
          to: txRequest.to,
          data: txRequest.data,
          value: txRequest.value || '0',
          gasLimit: txRequest.gasLimit || '500000',
          chainId: 11155111,
        },
        routing,
        note: 'Sign this transaction in MetaMask and broadcast',
      };
    } else {
      // UniswapX order flow
      const orderBody = { quote, signature };
      const orderResp = await fetch(`${UNISWAP_API_BASE}/order`, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(orderBody),
        signal: AbortSignal.timeout(15000),
      });

      if (!orderResp.ok) {
        const err = await orderResp.json().catch(() => ({}));
        throw new Error(`Uniswap /order ${orderResp.status}: ${err.detail || err.message || JSON.stringify(err)}`);
      }

      const orderResponse = await orderResp.json();
      return {
        success: true,
        order: orderResponse,
        routing,
        note: 'UniswapX order submitted — filler will execute',
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  PUBLIC SWAP METHODS (API-first, V2-fallback)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Swap ETH for a token. Tries Uniswap Trading API first, falls back to V2.
   */
  async swapETHForToken(tokenOut, ethAmount, slippageBps = 500) {
    const amountIn = typeof ethAmount === 'string'
      ? ethers.parseEther(ethAmount)
      : BigInt(ethAmount);

    // Try Uniswap Trading API first
    if (this.apiKey) {
      try {
        return await this.executeAPISwap(
          ADDRESSES.NATIVE_ETH,
          tokenOut,
          amountIn.toString(),
          { type: 'EXACT_INPUT', slippageTolerance: slippageBps / 100 }
        );
      } catch (apiErr) {
        console.log(`[UniswapAPI] Failed, falling back to direct V2: ${apiErr.message}`);
      }
    }

    return await this._directV2SwapETHForToken(tokenOut, amountIn, slippageBps);
  }

  /**
   * Swap a token for ETH. Tries Uniswap Trading API first, falls back to V2.
   */
  async swapTokenForETH(tokenIn, amount, slippageBps = 500) {
    const tokenContract = new ethers.Contract(tokenIn, ERC20_ABI, this.wallet);
    const decimals = await tokenContract.decimals();
    const amountIn = typeof amount === 'string'
      ? ethers.parseUnits(amount, decimals)
      : BigInt(amount);

    // Try Uniswap Trading API first
    if (this.apiKey) {
      try {
        await this._ensurePermit2Approval(tokenIn, amountIn);
        return await this.executeAPISwap(
          tokenIn,
          ADDRESSES.NATIVE_ETH,
          amountIn.toString(),
          { type: 'EXACT_INPUT', slippageTolerance: slippageBps / 100 }
        );
      } catch (apiErr) {
        console.log(`[UniswapAPI] Failed, falling back to direct V2: ${apiErr.message}`);
      }
    }

    return await this._directV2SwapTokenForETH(tokenIn, amountIn, slippageBps, tokenContract, decimals);
  }

  /**
   * Ensure token is approved for Permit2 contract
   */
  async _ensurePermit2Approval(tokenAddress, amount) {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, this.wallet);
    const currentAllowance = await token.allowance(this.wallet.address, ADDRESSES.PERMIT2);
    if (currentAllowance < amount) {
      console.log(`[Permit2] Approving ${tokenAddress}...`);
      const tx = await token.approve(ADDRESSES.PERMIT2, ethers.MaxUint256);
      await tx.wait();
      console.log(`[Permit2] Approved`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  DIRECT V2 PAIR — FALLBACK PATH
  // ═══════════════════════════════════════════════════════════════════════

  async _directV2SwapETHForToken(tokenOut, amountIn, slippageBps) {
    const pairAddr = await this.factory.getPair(ADDRESSES.WETH9, tokenOut);
    if (pairAddr === ethers.ZeroAddress) {
      throw new Error(`No V2 pair for WETH/${tokenOut}`);
    }
    const pair = new ethers.Contract(pairAddr, V2_PAIR_ABI, this.wallet);

    const [reserve0, reserve1] = await pair.getReserves();
    const token0 = await pair.token0();
    const wethIsToken0 = token0.toLowerCase() === ADDRESSES.WETH9.toLowerCase();
    const [reserveIn, reserveOut] = wethIsToken0
      ? [reserve0, reserve1]
      : [reserve1, reserve0];

    const amountInWithFee = amountIn * 997n;
    const numerator = amountInWithFee * reserveOut;
    const denominator = reserveIn * 1000n + amountInWithFee;
    const expectedOut = numerator / denominator;

    const amount0Out = wethIsToken0 ? 0n : expectedOut;
    const amount1Out = wethIsToken0 ? expectedOut : 0n;

    console.log(`[V2 Fallback] Swap ETH -> Token via pair ${pairAddr}`);
    console.log(`[V2 Fallback] Input: ${ethers.formatEther(amountIn)} ETH`);

    // Wrap ETH -> WETH, transfer to pair, then swap
    const wrapTx = await this.weth.deposit({ value: amountIn });
    await wrapTx.wait();
    const transferTx = await this.weth.transfer(pairAddr, amountIn);
    await transferTx.wait();

    const tx = await pair.swap(amount0Out, amount1Out, this.wallet.address, '0x', {
      gasLimit: 200000n,
    });
    console.log(`[V2 Fallback] Tx: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`[V2 Fallback] Confirmed block=${receipt.blockNumber} gas=${receipt.gasUsed}`);

    if (receipt.status !== 1) {
      throw new Error(`Transaction reverted: ${tx.hash}`);
    }

    const result = {
      txHash: tx.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      ethIn: ethers.formatEther(amountIn),
      expectedOut: expectedOut.toString(),
      pair: pairAddr,
      path: [ADDRESSES.WETH9, tokenOut],
      method: 'direct-v2-pair',
      source: 'Direct V2 Pair (fallback)',
      timestamp: Date.now(),
      status: 'SUCCESS',
    };
    this.swapHistory.push(result);
    return result;
  }

  async _directV2SwapTokenForETH(tokenIn, amountIn, slippageBps, tokenContract, decimals) {
    const symbol = await tokenContract.symbol();
    const pairAddr = await this.factory.getPair(tokenIn, ADDRESSES.WETH9);
    if (pairAddr === ethers.ZeroAddress) {
      throw new Error(`No V2 pair for ${symbol}/WETH`);
    }
    const pair = new ethers.Contract(pairAddr, V2_PAIR_ABI, this.wallet);

    const [reserve0, reserve1] = await pair.getReserves();
    const token0 = await pair.token0();
    const tokenIsToken0 = token0.toLowerCase() === tokenIn.toLowerCase();
    const [reserveIn, reserveOut] = tokenIsToken0
      ? [reserve0, reserve1]
      : [reserve1, reserve0];

    const amountInWithFee = amountIn * 997n;
    const expectedOut = (amountInWithFee * reserveOut) / (reserveIn * 1000n + amountInWithFee);
    const amount0Out = tokenIsToken0 ? 0n : expectedOut;
    const amount1Out = tokenIsToken0 ? expectedOut : 0n;

    console.log(`[V2 Fallback] Swap ${symbol} -> ETH via pair ${pairAddr}`);

    const transferTx = await tokenContract.transfer(pairAddr, amountIn);
    await transferTx.wait();
    const swapTx = await pair.swap(amount0Out, amount1Out, this.wallet.address, '0x', {
      gasLimit: 200000n,
    });
    const receipt = await swapTx.wait();

    // Unwrap any WETH received
    const wethBal = await this.weth.balanceOf(this.wallet.address);
    if (wethBal > 0n) {
      const unwrap = await this.weth.withdraw(wethBal);
      await unwrap.wait();
    }

    const result = {
      txHash: swapTx.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      tokenIn: symbol,
      amountIn: ethers.formatUnits(amountIn, decimals),
      expectedETH: ethers.formatEther(expectedOut),
      pair: pairAddr,
      method: 'direct-v2-pair',
      source: 'Direct V2 Pair (fallback)',
      timestamp: Date.now(),
      status: 'SUCCESS',
    };
    this.swapHistory.push(result);
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  UTILITY METHODS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Get a V2 on-chain quote (multi-hop capable)
   */
  async getV2Quote(amountIn, path) {
    let currentAmount = amountIn;
    for (let i = 0; i < path.length - 1; i++) {
      const tIn = path[i];
      const tOut = path[i + 1];
      const pairAddr = await this.factory.getPair(tIn, tOut);
      if (pairAddr === ethers.ZeroAddress) {
        throw new Error(`No V2 pair for ${tIn}/${tOut}`);
      }
      const pair = new ethers.Contract(pairAddr, V2_PAIR_ABI, this.provider);
      const [r0, r1] = await pair.getReserves();
      const t0 = await pair.token0();
      const [rIn, rOut] = t0.toLowerCase() === tIn.toLowerCase()
        ? [r0, r1]
        : [r1, r0];
      const fee = currentAmount * 997n;
      currentAmount = (fee * rOut) / (rIn * 1000n + fee);
    }
    return currentAmount;
  }

  /**
   * Get a swap quote — tries API first, falls back to V2
   */
  async getSwapQuote(tokenIn, tokenOut, amountIn) {
    // Try Uniswap Trading API first
    if (this.apiKey) {
      try {
        const apiTokenIn = tokenIn === ADDRESSES.WETH9 ? ADDRESSES.NATIVE_ETH : tokenIn;
        const apiTokenOut = tokenOut === ADDRESSES.WETH9 ? ADDRESSES.NATIVE_ETH : tokenOut;
        const data = await this.getAPIQuote(
          apiTokenIn, apiTokenOut, amountIn.toString(), 'EXACT_INPUT', 5.0
        );
        // Extract amountOut from API response (field varies by routing type)
        const amountOut = data.quote?.amountOut || data.quote?.output?.amount
          || data.output?.amount || data.amountOut || '0';
        return {
          amountIn: amountIn.toString(),
          amountOut: amountOut.toString(),
          routing: data.routing,
          source: 'uniswap-trading-api',
          apiUsed: true,
          gasEstimate: data.quote?.gasEstimate || null,
        };
      } catch (e) {
        console.log(`[UniswapAPI] Quote failed: ${e.message}`);
      }
    }

    // Fallback to V2 on-chain quote
    const path = [tokenIn, tokenOut];
    try {
      const out = await this.getV2Quote(amountIn, path);
      return {
        amountIn: amountIn.toString(),
        amountOut: out.toString(),
        path,
        source: 'uniswap-v2-sepolia',
        apiUsed: false,
      };
    } catch (e) {
      return {
        error: e.message,
        path,
        source: 'uniswap-v2-sepolia',
        apiUsed: false,
      };
    }
  }

  /**
   * Get V2 pair info (reserves, etc.)
   */
  async getPairInfo(tokenA, tokenB) {
    const pairAddr = await this.factory.getPair(tokenA, tokenB);
    if (pairAddr === ethers.ZeroAddress) {
      return { exists: false, pair: ethers.ZeroAddress };
    }
    const pair = new ethers.Contract(pairAddr, V2_PAIR_ABI, this.provider);
    const [r0, r1] = await pair.getReserves();
    const t0 = await pair.token0();
    const isT0A = t0.toLowerCase() === tokenA.toLowerCase();
    return {
      exists: true,
      pair: pairAddr,
      reserveA: (isT0A ? r0 : r1).toString(),
      reserveB: (isT0A ? r1 : r0).toString(),
    };
  }

  /**
   * Calculate price impact for a swap
   */
  _calculatePriceImpact(amountIn, amountOut, pairInfo) {
    if (!pairInfo.exists) return 'N/A';
    const rIn = BigInt(pairInfo.reserveA);
    const rOut = BigInt(pairInfo.reserveB);
    if (rIn === 0n || rOut === 0n) return 'N/A';
    const spot = (rOut * 10000n) / rIn;
    const exec = (amountOut * 10000n) / amountIn;
    return `${(Number(spot - exec) / Number(spot) * 100).toFixed(4)}%`;
  }

  /**
   * Get wallet token balances
   */
  async getBalances() {
    const eth = await this.provider.getBalance(this.wallet.address);
    const balances = { ETH: ethers.formatEther(eth) };
    const tokens = [
      { addr: ADDRESSES.WETH9, symbol: 'WETH', decimals: 18 },
      { addr: ADDRESSES.USDC, symbol: 'USDC', decimals: 6 },
      { addr: ADDRESSES.USDT, symbol: 'USDT', decimals: 6 },
      { addr: ADDRESSES.DAI, symbol: 'DAI', decimals: 18 },
      { addr: ADDRESSES.LINK, symbol: 'LINK', decimals: 18 },
      { addr: ADDRESSES.ROME, symbol: 'ROME', decimals: 18 },
    ];
    for (const t of tokens) {
      try {
        const c = new ethers.Contract(t.addr, ERC20_ABI, this.provider);
        balances[t.symbol] = ethers.formatUnits(
          await c.balanceOf(this.wallet.address), t.decimals
        );
      } catch {
        balances[t.symbol] = '0';
      }
    }
    return {
      wallet: this.wallet.address,
      network: 'sepolia',
      chainId: 11155111,
      balances,
    };
  }

  /**
   * Get swap history
   */
  getHistory() {
    return this.swapHistory;
  }
}

UniswapSepoliaSwap.ADDRESSES = ADDRESSES;
module.exports = UniswapSepoliaSwap;
