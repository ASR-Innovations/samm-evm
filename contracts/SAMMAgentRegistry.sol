// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title SAMMAgentRegistry
 * @notice Lightweight on-chain registry for SAMM autonomous agents and shard identities.
 * @dev Stores ENS names + metadata for agent discoverability and reputation.
 *      records on-chain so external protocols can discover SAMM agents and shards.
 */
contract SAMMAgentRegistry is Ownable {
    struct Agent {
        string name;          // logical id e.g. "arb-bot"
        string ensName;       // e.g. "arb-bot.samm.eth"
        address agentAddress; // current wallet/address used by the agent
        string role;          // e.g. "arbitrage", "shard-manager"
        bool active;
        uint64 registeredAt;
        uint64 updatedAt;
    }

    struct ShardIdentity {
        string pair;          // e.g. "WETH-USDC"
        string tier;          // e.g. "Small"
        string ensName;       // e.g. "small.weth-usdc.samm.eth"
        address shardAddress;
        bool active;
        uint64 updatedAt;
    }

    mapping(address => bool) public registrars;

    mapping(bytes32 => Agent) private _agents;
    bytes32[] private _agentKeys;
    mapping(bytes32 => bool) private _agentExists;

    mapping(bytes32 => mapping(bytes32 => string)) private _agentTextRecords;

    mapping(bytes32 => ShardIdentity) private _shards;
    bytes32[] private _shardKeys;
    mapping(bytes32 => bool) private _shardExists;

    event RegistrarUpdated(address indexed registrar, bool enabled);
    event AgentRegistered(bytes32 indexed key, string name, string ensName, address agentAddress, string role, bool active);
    event AgentTextRecordUpdated(bytes32 indexed agentKey, string key, string value);
    event ShardRegistered(bytes32 indexed key, string pair, string tier, string ensName, address shardAddress, bool active);

    modifier onlyRegistrar() {
        require(registrars[msg.sender] || msg.sender == owner(), "not registrar");
        _;
    }

    constructor() Ownable(msg.sender) {
        registrars[msg.sender] = true;
    }

    function setRegistrar(address registrar, bool enabled) external onlyOwner {
        require(registrar != address(0), "zero registrar");
        registrars[registrar] = enabled;
        emit RegistrarUpdated(registrar, enabled);
    }

    function registerOrUpdateAgent(
        string calldata name,
        string calldata ensName,
        address agentAddress,
        string calldata role,
        bool active
    ) external onlyRegistrar {
        require(bytes(name).length > 0, "empty name");
        require(agentAddress != address(0), "zero agent");

        bytes32 key = _agentKey(name);
        Agent storage a = _agents[key];

        if (!_agentExists[key]) {
            _agentExists[key] = true;
            _agentKeys.push(key);
            a.registeredAt = uint64(block.timestamp);
        }

        a.name = name;
        a.ensName = ensName;
        a.agentAddress = agentAddress;
        a.role = role;
        a.active = active;
        a.updatedAt = uint64(block.timestamp);

        emit AgentRegistered(key, name, ensName, agentAddress, role, active);
    }

    function setAgentTextRecord(
        string calldata name,
        string calldata key,
        string calldata value
    ) external onlyRegistrar {
        bytes32 aKey = _agentKey(name);
        require(_agentExists[aKey], "agent not found");
        _agentTextRecords[aKey][_textKey(key)] = value;
        emit AgentTextRecordUpdated(aKey, key, value);
    }

    function setBatchAgentTextRecords(
        string calldata name,
        string[] calldata keys,
        string[] calldata values
    ) external onlyRegistrar {
        require(keys.length == values.length, "length mismatch");
        bytes32 aKey = _agentKey(name);
        require(_agentExists[aKey], "agent not found");

        for (uint256 i = 0; i < keys.length; i++) {
            _agentTextRecords[aKey][_textKey(keys[i])] = values[i];
            emit AgentTextRecordUpdated(aKey, keys[i], values[i]);
        }
    }

    function registerOrUpdateShard(
        string calldata pair,
        string calldata tier,
        string calldata ensName,
        address shardAddress,
        bool active
    ) external onlyRegistrar {
        require(bytes(pair).length > 0, "empty pair");
        require(bytes(tier).length > 0, "empty tier");
        require(shardAddress != address(0), "zero shard");

        bytes32 key = _shardKey(pair, tier);
        ShardIdentity storage s = _shards[key];

        if (!_shardExists[key]) {
            _shardExists[key] = true;
            _shardKeys.push(key);
        }

        s.pair = pair;
        s.tier = tier;
        s.ensName = ensName;
        s.shardAddress = shardAddress;
        s.active = active;
        s.updatedAt = uint64(block.timestamp);

        emit ShardRegistered(key, pair, tier, ensName, shardAddress, active);
    }

    function getAgent(string calldata name) external view returns (Agent memory) {
        return _agents[_agentKey(name)];
    }

    function getAgentTextRecord(string calldata name, string calldata key) external view returns (string memory) {
        return _agentTextRecords[_agentKey(name)][_textKey(key)];
    }

    function listAgents() external view returns (Agent[] memory agents) {
        agents = new Agent[](_agentKeys.length);
        for (uint256 i = 0; i < _agentKeys.length; i++) {
            agents[i] = _agents[_agentKeys[i]];
        }
    }

    function getShard(string calldata pair, string calldata tier) external view returns (ShardIdentity memory) {
        return _shards[_shardKey(pair, tier)];
    }

    function listShards() external view returns (ShardIdentity[] memory shards) {
        shards = new ShardIdentity[](_shardKeys.length);
        for (uint256 i = 0; i < _shardKeys.length; i++) {
            shards[i] = _shards[_shardKeys[i]];
        }
    }

    function _agentKey(string memory name) internal pure returns (bytes32) {
        return keccak256(bytes(name));
    }

    function _textKey(string memory key) internal pure returns (bytes32) {
        return keccak256(bytes(key));
    }

    function _shardKey(string memory pair, string memory tier) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(pair, "::", tier));
    }
}
