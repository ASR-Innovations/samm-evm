const { expect } = require('chai');
const { ENSAgentRegistry } = require('../../integrations/ens-agent-registry');

describe('ENSAgentRegistry (offchain/local mode)', function () {
  it('registers and returns local agent data', async function () {
    const reg = new ENSAgentRegistry({ baseDomain: 'samm.eth' });

    await reg.registerAgent({
      name: 'arb-bot',
      ensName: 'arb-bot',
      agentAddress: '0x1111111111111111111111111111111111111111',
      role: 'arbitrage-bot',
      textRecords: {
        'com.samm.min-deviation': '0.30%',
      },
    });

    const agent = await reg.getAgent('arb-bot');
    expect(agent).to.not.equal(null);
    expect(agent.ensName).to.equal('arb-bot.samm.eth');
    expect(agent.agentAddress).to.equal('0x1111111111111111111111111111111111111111');
    expect(agent.textRecords['com.samm.min-deviation']).to.equal('0.30%');
  });

  it('resolves locally registered ENS name when provider is unavailable', async function () {
    const reg = new ENSAgentRegistry({ baseDomain: 'samm.eth' });

    await reg.registerAgent({
      name: 'shard-manager',
      ensName: 'shard-manager.samm.eth',
      agentAddress: '0x2222222222222222222222222222222222222222',
      role: 'dynamic-shard-manager',
    });

    const resolved = await reg.resolveAddress('shard-manager.samm.eth');
    expect(resolved).to.equal('0x2222222222222222222222222222222222222222');
  });

  it('registers shard identities in local mode', async function () {
    const reg = new ENSAgentRegistry({ baseDomain: 'samm.eth' });

    await reg.registerShard({
      pair: 'WETH-USDC',
      tier: 'Small',
      shardAddress: '0x3333333333333333333333333333333333333333',
      ensName: 'small.weth-usdc.samm.eth',
      active: true,
    });

    const shards = await reg.listShards();
    expect(shards).to.have.length(1);
    expect(shards[0].pair).to.equal('WETH-USDC');
    expect(shards[0].ensName).to.equal('small.weth-usdc.samm.eth');
  });
});
