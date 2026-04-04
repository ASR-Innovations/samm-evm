const { ethers } = require('ethers');

const REGISTRY_ABI = [
  'function registerOrUpdateAgent(string,string,address,string,bool) external',
  'function setBatchAgentTextRecords(string,string[],string[]) external',
  'function registerOrUpdateShard(string,string,string,address,bool) external',
  'function getAgent(string) external view returns (tuple(string name,string ensName,address agentAddress,string role,bool active,uint64 registeredAt,uint64 updatedAt))',
  'function listAgents() external view returns (tuple(string name,string ensName,address agentAddress,string role,bool active,uint64 registeredAt,uint64 updatedAt)[])',
  'function listShards() external view returns (tuple(string pair,string tier,string ensName,address shardAddress,bool active,uint64 updatedAt)[])',
  'function getAgentTextRecord(string,string) external view returns (string)',
];

class ENSAgentRegistry {
  constructor({
    registryAddress,
    registryProvider,
    registrySigner,
    ensProvider,
    baseDomain = 'samm.eth',
  } = {}) {
    this.baseDomain = baseDomain;
    this.registryAddress = registryAddress || null;
    this.registryProvider = registryProvider || null;
    this.registrySigner = registrySigner || null;
    this.ensProvider = ensProvider || null;

    this.localAgents = new Map();
    this.localShards = new Map();

    this.hasRegistry = !!(registryAddress && ethers.isAddress(registryAddress));
    this.hasSigner = !!registrySigner;

    if (this.hasRegistry) {
      const runner = this.registrySigner || this.registryProvider;
      this.registry = new ethers.Contract(registryAddress, REGISTRY_ABI, runner);
    } else {
      this.registry = null;
    }
  }

  status() {
    return {
      enabled: true,
      registryConfigured: this.hasRegistry,
      registryAddress: this.registryAddress,
      registryWritable: this.hasRegistry && this.hasSigner,
      ensResolutionEnabled: !!this.ensProvider,
      baseDomain: this.baseDomain,
      localAgentCount: this.localAgents.size,
      localShardCount: this.localShards.size,
    };
  }

  toEnsName(nameOrEns) {
    if (!nameOrEns) return '';
    if (nameOrEns.endsWith('.eth')) return nameOrEns.toLowerCase();
    return `${nameOrEns.toLowerCase()}.${this.baseDomain}`;
  }

  async resolveAddress(addressOrEns) {
    if (!addressOrEns) return null;
    if (ethers.isAddress(addressOrEns)) return addressOrEns;

    const normalized = addressOrEns.toLowerCase();
    if (!normalized.endsWith('.eth')) return null;

    if (this.ensProvider) {
      try {
        const resolved = await this.ensProvider.resolveName(normalized);
        if (resolved) return resolved;
      } catch {
        // ignore and try local fallback
      }
    }

    for (const a of this.localAgents.values()) {
      if (a.ensName?.toLowerCase() === normalized && ethers.isAddress(a.agentAddress)) {
        return a.agentAddress;
      }
    }

    return null;
  }

  async registerAgent({ name, ensName, agentAddress, role = '', active = true, textRecords = {} }) {
    if (!name || !ethers.isAddress(agentAddress)) {
      throw new Error('Invalid agent registration payload');
    }

    const normalizedEns = this.toEnsName(ensName || name);

    const local = {
      name,
      ensName: normalizedEns,
      agentAddress,
      role,
      active,
      updatedAt: new Date().toISOString(),
      textRecords: { ...textRecords },
      source: 'local',
    };

    this.localAgents.set(name, local);

    if (this.hasRegistry && this.hasSigner) {
      try {
        const tx = await this.registry.registerOrUpdateAgent(name, normalizedEns, agentAddress, role, active);
        await tx.wait();

        const keys = Object.keys(textRecords || {});
        if (keys.length > 0) {
          const values = keys.map((k) => String(textRecords[k]));
          const tx2 = await this.registry.setBatchAgentTextRecords(name, keys, values);
          await tx2.wait();
        }

        local.source = 'onchain';
      } catch (err) {
        local.registryError = err.message?.slice(0, 140) || 'unknown';
      }
    }

    return local;
  }

  async updateAgentStats(name, stats = {}) {
    if (!this.localAgents.has(name)) return null;
    const current = this.localAgents.get(name);
    const merged = {
      ...(current.textRecords || {}),
      ...Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, String(v)])),
    };

    current.textRecords = merged;
    current.updatedAt = new Date().toISOString();

    if (this.hasRegistry && this.hasSigner) {
      try {
        const keys = Object.keys(stats);
        if (keys.length > 0) {
          const values = keys.map((k) => String(stats[k]));
          const tx = await this.registry.setBatchAgentTextRecords(name, keys, values);
          await tx.wait();
          current.source = 'onchain';
        }
      } catch (err) {
        current.registryError = err.message?.slice(0, 140) || 'unknown';
      }
    }

    this.localAgents.set(name, current);
    return current;
  }

  async registerShard({ pair, tier, shardAddress, ensName, active = true }) {
    if (!pair || !tier || !ethers.isAddress(shardAddress)) {
      throw new Error('Invalid shard registration payload');
    }

    const normalizedEns = this.toEnsName(ensName || `${tier}.${pair}`.replace(/\s+/g, '').toLowerCase());
    const key = `${pair}::${tier}`;

    const local = {
      pair,
      tier,
      ensName: normalizedEns,
      shardAddress,
      active,
      updatedAt: new Date().toISOString(),
      source: 'local',
    };

    this.localShards.set(key, local);

    if (this.hasRegistry && this.hasSigner) {
      try {
        const tx = await this.registry.registerOrUpdateShard(pair, tier, normalizedEns, shardAddress, active);
        await tx.wait();
        local.source = 'onchain';
      } catch (err) {
        local.registryError = err.message?.slice(0, 140) || 'unknown';
      }
    }

    return local;
  }

  async listAgents() {
    if (this.hasRegistry) {
      try {
        const rows = await this.registry.listAgents();
        return rows.map((r) => ({
          name: r.name,
          ensName: r.ensName,
          agentAddress: r.agentAddress,
          role: r.role,
          active: r.active,
          registeredAt: Number(r.registeredAt),
          updatedAt: Number(r.updatedAt),
          source: 'onchain',
        }));
      } catch {
        // fallback local
      }
    }

    return Array.from(this.localAgents.values());
  }

  async getAgent(name) {
    if (this.hasRegistry) {
      try {
        const r = await this.registry.getAgent(name);
        if (r.agentAddress && r.agentAddress !== ethers.ZeroAddress) {
          return {
            name: r.name,
            ensName: r.ensName,
            agentAddress: r.agentAddress,
            role: r.role,
            active: r.active,
            registeredAt: Number(r.registeredAt),
            updatedAt: Number(r.updatedAt),
            source: 'onchain',
            textRecords: this.localAgents.get(name)?.textRecords || {},
          };
        }
      } catch {
        // fallback local
      }
    }

    return this.localAgents.get(name) || null;
  }

  async listShards() {
    if (this.hasRegistry) {
      try {
        const rows = await this.registry.listShards();
        return rows.map((r) => ({
          pair: r.pair,
          tier: r.tier,
          ensName: r.ensName,
          shardAddress: r.shardAddress,
          active: r.active,
          updatedAt: Number(r.updatedAt),
          source: 'onchain',
        }));
      } catch {
        // fallback local
      }
    }

    return Array.from(this.localShards.values());
  }
}

module.exports = { ENSAgentRegistry };
