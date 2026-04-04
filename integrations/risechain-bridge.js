/**
 * RiseChain ↔ Sepolia Bridge Integration
 * 
 * Uses OP Stack canonical bridge for cross-chain asset transfers.
 * RiseChain is an OP Stack L2 with standard bridge infrastructure.
 * 
 * L1StandardBridgeProxy (Sepolia): 0xe9a531a5d7253c9823c74af155d22fe14568b610
 * L2StandardBridge (RiseChain):    0x4200000000000000000000000000000000000010
 * L1CrossDomainMessenger:          0xcc1c4f905d0199419719f3c3210f43bb990953fc
 * OptimismPortalProxy:             0x77cce5cd26c75140c35c38104d0c655c7a786acb
 */

const { ethers } = require('ethers');

// ─── Bridge Contract Addresses ────────────────────────────────────────────
const BRIDGE_ADDRESSES = {
  // Sepolia (L1) contracts
  L1_STANDARD_BRIDGE: '0xe9a531a5d7253c9823c74af155d22fe14568b610',
  L1_CROSS_DOMAIN_MESSENGER: '0xcc1c4f905d0199419719f3c3210f43bb990953fc',
  OPTIMISM_PORTAL: '0x77cce5cd26c75140c35c38104d0c655c7a786acb',
  
  // RiseChain (L2) contracts
  L2_STANDARD_BRIDGE: '0x4200000000000000000000000000000000000010',
  L2_CROSS_DOMAIN_MESSENGER: '0x4200000000000000000000000000000000000007',
  L2_TO_L1_MESSAGE_PASSER: '0x4200000000000000000000000000000000000016',
  L2_WETH: '0x4200000000000000000000000000000000000006',
};

// ─── ABIs ─────────────────────────────────────────────────────────────────
const L1_BRIDGE_ABI = [
  'function depositETH(uint32 _minGasLimit, bytes calldata _extraData) external payable',
  'function depositERC20(address _l1Token, address _l2Token, uint256 _amount, uint32 _minGasLimit, bytes calldata _extraData) external',
  'function deposits(address, address) external view returns (uint256)',
];

const L2_BRIDGE_ABI = [
  'function withdraw(address _l2Token, uint256 _amount, uint32 _minGasLimit, bytes calldata _extraData) external payable',
  'function withdrawTo(address _l2Token, address _to, uint256 _amount, uint32 _minGasLimit, bytes calldata _extraData) external payable',
];

const OPTIMISM_PORTAL_ABI = [
  'function depositTransaction(address _to, uint256 _value, uint64 _gasLimit, bool _isCreation, bytes calldata _data) external payable',
  'function minimumGasLimit(uint64 _byteCount) external pure returns (uint64)',
];

const ERC20_ABI = [
  'function approve(address, uint256) external returns (bool)',
  'function allowance(address, address) external view returns (uint256)',
  'function balanceOf(address) external view returns (uint256)',
  'function symbol() external view returns (string)',
  'function decimals() external view returns (uint8)',
];

class RiseChainBridge {
  /**
   * @param {string} privateKey - Wallet private key
   * @param {string} sepoliaRpc - Sepolia RPC URL
   * @param {string} riseChainRpc - RiseChain RPC URL
   */
  constructor(privateKey, sepoliaRpc, riseChainRpc) {
    this.sepoliaProvider = new ethers.JsonRpcProvider(sepoliaRpc);
    this.riseChainProvider = new ethers.JsonRpcProvider(riseChainRpc);
    
    this.sepoliaWallet = new ethers.Wallet(privateKey, this.sepoliaProvider);
    this.riseChainWallet = new ethers.Wallet(privateKey, this.riseChainProvider);
    
    this.l1Bridge = new ethers.Contract(
      BRIDGE_ADDRESSES.L1_STANDARD_BRIDGE, L1_BRIDGE_ABI, this.sepoliaWallet
    );
    this.l2Bridge = new ethers.Contract(
      BRIDGE_ADDRESSES.L2_STANDARD_BRIDGE, L2_BRIDGE_ABI, this.riseChainWallet
    );
    this.portal = new ethers.Contract(
      BRIDGE_ADDRESSES.OPTIMISM_PORTAL, OPTIMISM_PORTAL_ABI, this.sepoliaWallet
    );
    
    this.bridgeHistory = [];
  }

  /**
   * Bridge ETH from Sepolia (L1) → RiseChain (L2)
   * 
   * @param {string} amount - ETH amount in ether (e.g., "0.01")
   * @param {number} minGasLimit - L2 gas limit for the deposit (default 200000)
   */
  async depositETH(amount, minGasLimit = 200000) {
    const value = ethers.parseEther(amount);
    
    console.log(`\n🌉 Bridge ETH: Sepolia → RiseChain`);
    console.log(`   Amount: ${amount} ETH`);
    console.log(`   From: ${this.sepoliaWallet.address}`);
    console.log(`   L1 Bridge: ${BRIDGE_ADDRESSES.L1_STANDARD_BRIDGE}`);
    
    // Check L1 balance
    const l1Balance = await this.sepoliaProvider.getBalance(this.sepoliaWallet.address);
    console.log(`   L1 Balance: ${ethers.formatEther(l1Balance)} ETH`);
    
    if (l1Balance < value) {
      throw new Error(`Insufficient Sepolia ETH: have ${ethers.formatEther(l1Balance)}, need ${amount}`);
    }
    
    // Check L2 balance before
    const l2BalanceBefore = await this.riseChainProvider.getBalance(this.riseChainWallet.address);
    console.log(`   L2 Balance (before): ${ethers.formatEther(l2BalanceBefore)} ETH`);
    
    // Execute deposit
    const tx = await this.l1Bridge.depositETH(minGasLimit, '0x', {
      value: value,
      gasLimit: 800000n, // ~662K actual gas — previous 150K caused reverts
    });
    
    console.log(`   📤 L1 Tx submitted: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`   ✅ L1 Confirmed in block ${receipt.blockNumber} | Gas: ${receipt.gasUsed.toString()}`);
    console.log(`   ⏳ L2 deposit will be credited after challenge period (~minutes on testnet)`);
    
    const result = {
      type: 'deposit',
      direction: 'L1→L2',
      asset: 'ETH',
      amount: amount,
      l1TxHash: tx.hash,
      l1BlockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      from: this.sepoliaWallet.address,
      status: receipt.status === 1 ? 'L1_CONFIRMED' : 'L1_FAILED',
      timestamp: Date.now(),
      l2BalanceBefore: ethers.formatEther(l2BalanceBefore),
    };
    
    this.bridgeHistory.push(result);
    return result;
  }

  /**
   * Bridge ERC20 from Sepolia (L1) → RiseChain (L2)
   */
  async depositERC20(l1Token, l2Token, amount, minGasLimit = 200000) {
    const tokenContract = new ethers.Contract(l1Token, ERC20_ABI, this.sepoliaWallet);
    const decimals = await tokenContract.decimals();
    const symbol = await tokenContract.symbol();
    const amountParsed = ethers.parseUnits(amount, decimals);
    
    console.log(`\n🌉 Bridge ${symbol}: Sepolia → RiseChain`);
    console.log(`   Amount: ${amount} ${symbol}`);
    
    // Check and approve
    const allowance = await tokenContract.allowance(
      this.sepoliaWallet.address, BRIDGE_ADDRESSES.L1_STANDARD_BRIDGE
    );
    if (allowance < amountParsed) {
      console.log(`   Approving L1 Bridge...`);
      const approveTx = await tokenContract.approve(
        BRIDGE_ADDRESSES.L1_STANDARD_BRIDGE, ethers.MaxUint256
      );
      await approveTx.wait();
      console.log(`   ✅ Approved`);
    }
    
    const tx = await this.l1Bridge.depositERC20(
      l1Token, l2Token, amountParsed, minGasLimit, '0x',
      { gasLimit: 250000n }
    );
    
    console.log(`   📤 L1 Tx submitted: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`   ✅ L1 Confirmed in block ${receipt.blockNumber}`);
    
    const result = {
      type: 'deposit',
      direction: 'L1→L2',
      asset: symbol,
      amount,
      l1Token,
      l2Token,
      l1TxHash: tx.hash,
      l1BlockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      status: receipt.status === 1 ? 'L1_CONFIRMED' : 'L1_FAILED',
      timestamp: Date.now(),
    };
    
    this.bridgeHistory.push(result);
    return result;
  }

  /**
   * Withdraw ETH from RiseChain (L2) → Sepolia (L1)
   * Note: L2→L1 withdrawals have a challenge period before finalization
   */
  async withdrawETH(amount, minGasLimit = 200000) {
    const value = ethers.parseEther(amount);
    
    console.log(`\n🌉 Withdraw ETH: RiseChain → Sepolia`);
    console.log(`   Amount: ${amount} ETH`);
    
    const l2Balance = await this.riseChainProvider.getBalance(this.riseChainWallet.address);
    console.log(`   L2 Balance: ${ethers.formatEther(l2Balance)} ETH`);
    
    if (l2Balance < value) {
      throw new Error(`Insufficient RiseChain ETH: have ${ethers.formatEther(l2Balance)}, need ${amount}`);
    }
    
    // Withdraw using L2 bridge — send ETH as value, specify predeploy WETH as token
    const tx = await this.l2Bridge.withdraw(
      BRIDGE_ADDRESSES.L2_WETH, value, minGasLimit, '0x',
      { value: value, gasLimit: 200000n }
    );
    
    console.log(`   📤 L2 Tx submitted: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`   ✅ L2 Confirmed in block ${receipt.blockNumber}`);
    console.log(`   ⏳ Must prove & finalize on L1 after challenge period`);
    
    const result = {
      type: 'withdrawal',
      direction: 'L2→L1',
      asset: 'ETH',
      amount,
      l2TxHash: tx.hash,
      l2BlockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      status: 'L2_INITIATED',
      timestamp: Date.now(),
      note: 'Withdrawal needs to be proved and finalized on L1 after challenge period',
    };
    
    this.bridgeHistory.push(result);
    return result;
  }

  /**
   * Get cross-chain balances for the wallet
   */
  async getBalances() {
    const [l1Eth, l2Eth] = await Promise.all([
      this.sepoliaProvider.getBalance(this.sepoliaWallet.address),
      this.riseChainProvider.getBalance(this.riseChainWallet.address),
    ]);
    
    return {
      wallet: this.sepoliaWallet.address,
      sepolia: {
        ETH: ethers.formatEther(l1Eth),
        chainId: 11155111,
      },
      risechain: {
        ETH: ethers.formatEther(l2Eth),
        chainId: 11155931,
      },
    };
  }

  /**
   * Get bridge status and contract info
   */
  getStatus() {
    return {
      bridge: 'OP Stack Canonical Bridge',
      network: 'Sepolia ↔ RiseChain Testnet',
      contracts: BRIDGE_ADDRESSES,
      history: this.bridgeHistory,
      totalDeposits: this.bridgeHistory.filter(h => h.type === 'deposit').length,
      totalWithdrawals: this.bridgeHistory.filter(h => h.type === 'withdrawal').length,
    };
  }

  getHistory() {
    return this.bridgeHistory;
  }
}

RiseChainBridge.ADDRESSES = BRIDGE_ADDRESSES;

module.exports = RiseChainBridge;
