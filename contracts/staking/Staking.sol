pragma solidity ^0.8.0;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Context.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "./StakingTokenWrapper.sol";

// Modified https://github.com/Synthetixio/synthetix/blob/develop/contracts/StakingRewards.sol
// to support multiple types of reward tokens.
contract Staking is StakingTokenWrapper, Ownable {
    using SafeMath for uint256;
    using SafeERC20 for IERC20;
    using SafeERC20 for ERC20;

    struct StakingReward {
        IERC20 rewardToken;
        address rewardDistribution;

        uint256 periodFinish;
        uint256 rewardRate;
        uint256 duration;
        uint256 lastUpdateTime;
        uint256 rewardPerTokenStored;

        mapping(address => uint256) userRewardPerTokenPaid;
        mapping(address => uint256) rewards;
    }


    StakingReward[] public stakingRewards;
    uint public lastPauseTime;
    bool public paused;

    constructor(IERC20 _rewardToken, uint256 _duration, address _rewardDistribution, ERC20 _stakingToken) public StakingTokenWrapper(_stakingToken) {
        addRewardToken(_rewardToken, _duration, _rewardDistribution);
    }

    function name() external view returns(string memory) {
        return string(abi.encodePacked("Staking: ", stakingToken.name()));
    }

    function symbol() external view returns(string memory) {
        return string(abi.encodePacked("stake-", stakingToken.symbol()));
    }

    function decimals() external view returns(uint8) {
        return stakingToken.decimals();
    }

    function lastTimeRewardApplicable(uint i) public view returns (uint256) {
        return Math.min(block.timestamp, stakingRewards[i].periodFinish);
    }

    function rewardPerToken(uint i) public view returns (uint256) {
        StakingReward storage tr = stakingRewards[i];
        if (totalSupply() == 0) {
            return tr.rewardPerTokenStored;
        }
        return tr.rewardPerTokenStored.add(
            lastTimeRewardApplicable(i)
            .sub(tr.lastUpdateTime)
            .mul(tr.rewardRate)
            .mul(1e18)
            .div(totalSupply())
        );
    }

    function earned(uint i, address account) public view returns (uint256) {
        StakingReward storage tr = stakingRewards[i];
        return balanceOf(account)
        .mul(rewardPerToken(i).sub(tr.userRewardPerTokenPaid[account]))
        .div(1e18)
        .add(tr.rewards[account]);
    }

    function stake(uint256 amount) override public notPaused updateReward(msg.sender) {
        require(amount > 0, "Cannot stake 0");
        super.stake(amount);
        emit Staked(msg.sender, amount);
    }

    function withdraw(uint256 amount) override public updateReward(msg.sender) {
        require(amount > 0, "Cannot withdraw 0");
        super.withdraw(amount);
        emit Withdrawn(msg.sender, amount);
    }

    function exit() external {
        withdraw(balanceOf(msg.sender));
        getAllRewards();
    }

    function getReward(uint i) public updateReward(msg.sender) {
        StakingReward storage tr = stakingRewards[i];
        uint256 reward = tr.rewards[msg.sender];
        if (reward > 0) {
            tr.rewards[msg.sender] = 0;
            tr.rewardToken.safeTransfer(msg.sender, reward);
            emit RewardPaid(i, msg.sender, reward);
        }
    }

    function getAllRewards() public {
        uint256 len = stakingRewards.length;
        for (uint i = 0; i < len; i++) {
            getReward(i);
        }
    }

    function notifyRewardAmount(uint i, uint256 reward) external onlyRewardDistribution(i) updateReward(address(0)) {
        require(reward < uint256(2**256 - 1).div(1e18), "Reward overflow");

        StakingReward storage tr = stakingRewards[i];
        uint256 duration = tr.duration;
        if (block.timestamp >= tr.periodFinish) {
            require(reward >= duration, "Reward is too small");
            tr.rewardRate = reward.div(duration);
        } else {
            uint256 remaining = tr.periodFinish.sub(block.timestamp);
            uint256 leftover = remaining.mul(tr.rewardRate);
            require(reward.add(leftover) >= duration, "Reward is too small");
            tr.rewardRate = reward.add(leftover).div(duration);
        }

        uint balance = tr.rewardToken.balanceOf(address(this));
        require(tr.rewardRate <= balance.div(duration), "Reward is too big");

        tr.lastUpdateTime = block.timestamp;
        tr.periodFinish = block.timestamp.add(duration);
        emit RewardAdded(i, reward);
    }

    function setDuration(uint i, uint256 newDuration) external onlyRewardDistribution(i) {
        StakingReward storage tr = stakingRewards[i];
        require(block.timestamp >= tr.periodFinish, "Not finished yet");
        tr.duration = newDuration;
        emit RewardDurationUpdated(i, newDuration);
    }

    function setRewardDistribution(uint i, address newRewardDistribution) external onlyOwner {
        StakingReward storage tr = stakingRewards[i];
        tr.rewardDistribution = newRewardDistribution;
        emit RewardDistributionUpdated(i, newRewardDistribution);
    }

    function addRewardToken(IERC20 rewardToken, uint256 duration, address rewardDistribution) public onlyOwner {
        uint256 len = stakingRewards.length;
        for (uint i = 0; i < len; i++) {
            require(rewardToken != stakingRewards[i].rewardToken, "Reward token was already added");
        }

        StakingReward storage sr = stakingRewards.push();
        sr.rewardToken = rewardToken;
        sr.duration = duration;
        sr.rewardDistribution = rewardDistribution;

        emit NewRewardToken(len, rewardToken);
        emit RewardDurationUpdated(len, duration);
        emit RewardDistributionUpdated(len, rewardDistribution);
    }

    // Added to support recovering LP Rewards from other systems to be distributed to holders
    function recoverERC20(address tokenAddress, uint256 tokenAmount) external onlyOwner {
        require(tokenAddress != address(stakingToken), "Cannot withdraw the staking token");
        IERC20(tokenAddress).safeTransfer(owner(), tokenAmount);
        emit Recovered(tokenAddress, tokenAmount);
    }

    //Change the paused state of the contract
    function setPaused(bool _paused) external onlyOwner {
        // Ensure we're actually changing the state before we do anything
        if (_paused == paused) {
            return;
        }

        // Set our paused state.
        paused = _paused;

        // If applicable, set the last pause time.
        if (paused) {
            lastPauseTime = block.timestamp;
        }

        // Let everyone know that our pause state has changed.
        emit PauseChanged(paused);
    }

    /* ========== EVENTS ========== */

    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardAdded(uint256 indexed i, uint256 reward);
    event RewardPaid(uint256 indexed i, address indexed user, uint256 reward);
    event RewardDurationUpdated(uint256 indexed i, uint256 newDuration);
    event RewardDistributionUpdated(uint256 indexed i, address rewardDistribution);
    event NewRewardToken(uint256 indexed i, IERC20 token);
    event Recovered(address token, uint256 amount);
    event PauseChanged(bool isPaused);

    /* ========== MODIFIERS ========== */

    modifier onlyRewardDistribution(uint i) {
        require(msg.sender == stakingRewards[i].rewardDistribution, "Access denied: Caller is not reward distribution");
        _;
    }

    modifier updateReward(address account) {
        uint256 len = stakingRewards.length;
        for (uint i = 0; i < len; i++) {
            StakingReward storage sr = stakingRewards[i];
            sr.rewardPerTokenStored = rewardPerToken(i);
            sr.lastUpdateTime = lastTimeRewardApplicable(i);
            if (account != address(0)) {
                sr.rewards[account] = earned(i, account);
                sr.userRewardPerTokenPaid[account] = sr.rewardPerTokenStored;
            }
        }
        _;
    }

    modifier notPaused {
        require(!paused, "This action cannot be performed while the contract is paused");
        _;
    }
}
