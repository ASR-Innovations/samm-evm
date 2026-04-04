const { ethers } = require('ethers');
const p = new ethers.JsonRpcProvider('https://ethereum-sepolia-rpc.publicnode.com');

async function main() {
  const tx = await p.getTransaction('0x4a6bd98d708bcbd5f0870431cc2f8ad13e00c2f3193818a963cadf631626e1b3');
  console.log('value:', ethers.formatEther(tx.value));
  console.log('data length:', tx.data.length);
  console.log('data prefix:', tx.data.slice(0, 10));
  console.log('Expected selector for execute(bytes,bytes[],uint256): 0x3593564c');

  const iface = new ethers.Interface([
    'function execute(bytes commands, bytes[] inputs, uint256 deadline)',
  ]);
  try {
    const decoded = iface.decodeFunctionData('execute', tx.data);
    console.log('commands hex:', decoded[0]);
    console.log('inputs count:', decoded[1].length);
    console.log('deadline:', decoded[2].toString());

    const cmds = ethers.getBytes(decoded[0]);
    console.log('command bytes:', Array.from(cmds).map(c => '0x' + c.toString(16).padStart(2, '0')));
    
    // Decode WRAP_ETH input (command 0x0b)
    const wrapDecoded = ethers.AbiCoder.defaultAbiCoder().decode(
      ['address', 'uint256'],
      decoded[1][0]
    );
    console.log('WRAP_ETH: recipient =', wrapDecoded[0], ', amount =', wrapDecoded[1].toString());
    
    // Decode V2_SWAP_EXACT_IN input (command 0x08)
    const swapDecoded = ethers.AbiCoder.defaultAbiCoder().decode(
      ['address', 'uint256', 'uint256', 'address[]', 'bool'],
      decoded[1][1]
    );
    console.log('V2_SWAP: recipient =', swapDecoded[0]);
    console.log('V2_SWAP: amountIn =', swapDecoded[1].toString());
    console.log('V2_SWAP: amountOutMin =', swapDecoded[2].toString());
    console.log('V2_SWAP: path =', swapDecoded[3]);
    console.log('V2_SWAP: payerIsUser =', swapDecoded[4]);
  } catch (e) {
    console.log('Decode error:', e.message);
  }
}

main().catch(console.error);
