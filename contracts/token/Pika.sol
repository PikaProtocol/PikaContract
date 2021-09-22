//SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "./IPika.sol";
import "./IRewardDistributor.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";

//.----------------.  .----------------.  .----------------.  .----------------.
//| .--------------. || .--------------. || .--------------. || .--------------. |
//| |   ______     | || |     _____    | || |  ___  ____   | || |      __      | |
//| |  |_   __ \   | || |    |_   _|   | || | |_  ||_  _|  | || |     /  \     | |
//| |    | |__) |  | || |      | |     | || |   | |_/ /    | || |    / /\ \    | |
//| |    |  ___/   | || |      | |     | || |   |  __'.    | || |   / ____ \   | |
//| |   _| |_      | || |     _| |_    | || |  _| |  \ \_  | || | _/ /    \ \_ | |
//| |  |_____|     | || |    |_____|   | || | |____||____| | || ||____|  |____|| |
//| |              | || |              | || |              | || |              | |
//| '--------------' || '--------------' || '--------------' || '--------------' |
//'----------------'  '----------------'  '----------------'  '----------------'


/*
 * @dev PIKA Stablecoin
 */
contract Pika is IPika, ERC20, AccessControl {
    using SafeMath for uint256;
    string public constant NAME = "Pika";
    string public constant SYMBOL = "PIKA";
    bytes public constant EIP712_REVISION = bytes("1");
    bytes32 internal constant EIP712_DOMAIN = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant PERMIT_TYPEHASH = keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");

    bytes32 public DOMAIN_SEPARATOR;
    mapping(address => uint256) public nonces;

    address[] public rewardDistributors;
    mapping (address => bool) public noRewardAccounts;
    uint256 public noRewardSupply;

    modifier onlyGovernor {
        require(hasRole(DEFAULT_ADMIN_ROLE, msg.sender), "Caller is not the governor");
        _;
    }

    constructor(uint256 chainId) ERC20(NAME, SYMBOL) public {
        DOMAIN_SEPARATOR = keccak256(abi.encode(
                EIP712_DOMAIN,
                keccak256(bytes(NAME)),
                keccak256(EIP712_REVISION),
                chainId,
                address(this)
            ));
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function mint(address to, uint256 amount) public override {
        require(hasRole(MINTER_ROLE, msg.sender), "Caller is not a minter");
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) public override {
        require(hasRole(BURNER_ROLE, msg.sender), "Caller is not a burner");
        _burn(from, amount);
    }

    /**
    * @dev implements the permit function as for https://github.com/ethereum/EIPs/blob/8a34d644aacf0f9f8f00815307fd7dd5da07655f/EIPS/eip-2612.md
    * @param owner the owner of the funds
    * @param spender the spender
    * @param value the amount
    * @param deadline the deadline timestamp, type(uint256).max for no deadline
    * @param v signature param
    * @param s signature param
    * @param r signature param
    */
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(owner != address(0), "INVALID_OWNER");
        //solium-disable-next-line
        require(block.timestamp <= deadline, "INVALID_EXPIRATION");
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR,
                keccak256(
                    abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline))
            )
        );
        require(owner == ecrecover(digest, v, r, s), "INVALID_SIGNATURE");
        _approve(owner, spender, value);
    }

    function addToNoRewardAccounts(address account) external onlyGovernor {
        require(!noRewardAccounts[account], "PIKA: _address is already a no-reward address");
        _updateRewards(account);
        noRewardAccounts[account] = true;
        noRewardSupply = noRewardSupply.add(balanceOf(account));
    }

    function removeFromNoRewardAccounts(address account) external onlyGovernor {
        require(noRewardAccounts[account], "PIKA: _address is already a reward address");
        _updateRewards(account);
        noRewardAccounts[account] = false;
        noRewardSupply = noRewardSupply.sub(balanceOf(account));
    }

    function setRewardDistributors(address[] memory newRewardDistributors) external onlyGovernor {
        rewardDistributors = newRewardDistributors;
    }

    function recoverReward(address account, address payable receiver) external onlyGovernor {
        for (uint256 i = 0; i < rewardDistributors.length; i++) {
            IRewardDistributor(rewardDistributors[i]).claimRewards(account, receiver);
        }
    }

    function claimRewards(address payable receiver) external {
        for (uint256 i = 0; i < rewardDistributors.length; i++) {
            address rewardDistributor = rewardDistributors[i];
            IRewardDistributor(rewardDistributor).claimRewards(msg.sender, receiver);
        }
    }

    function totalSupplyWithReward() external override view returns (uint256) {
        return totalSupply().sub(noRewardSupply);
    }

    function balanceWithReward(address account) external override view returns (uint256) {
        if (noRewardAccounts[account]) {
            return 0;
        }
        return balanceOf(account);
    }

    function _beforeTokenTransfer(address from, address to, uint256 amount) internal override {
        if (from != address(0)) {
            _updateRewards(from);
        }
        if (to != address(0)) {
            _updateRewards(to);
        }
        if (noRewardAccounts[from]) {
            noRewardSupply = noRewardSupply.sub(amount);
        }
        if (noRewardAccounts[to]) {
            noRewardSupply = noRewardSupply.add(amount);
        }
    }

    function _updateRewards(address account) private {
        for (uint256 i = 0; i < rewardDistributors.length; i++) {
            IRewardDistributor(rewardDistributors[i]).updateRewards(account);
        }
    }
}
