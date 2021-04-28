//SPDX-License-Identifier: MIT

pragma solidity 0.6.12;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./IRewardDistributor.sol";
import "./IPika.sol";

// code adapted from https://github.com/trusttoken/smart-contracts/blob/master/contracts/truefi/TrueFarm.sol
// and https://raw.githubusercontent.com/xvi10/gambit-contracts/master/contracts/tokens/YieldTracker.sol
contract RewardDistributor is IRewardDistributor, ReentrancyGuard {
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    uint256 constant PRECISION = 1e30;

    uint256 public constant DISTRIBUTION_INTERVAL = 1 hours;
    address public governor;
    address public pikaToken;
    address public rewardToken;

    uint256 public previousTotalReward;
    uint256 public cumulativeRewardPerToken;
    mapping (address => uint256) public claimableReward;
    mapping (address => uint256) public previousCumulatedRewardPerToken;

    event Claim(address receiver, uint256 amount);

    modifier onlyGovernor() {
        require(msg.sender == governor, "RewardDistributor: not governor");
        _;
    }

    constructor(address _pikaToken, address _rewardToken) public {
        governor = msg.sender;
        pikaToken = _pikaToken;
        rewardToken = _rewardToken;
    }

    function setGovernor(address newGovernor) external onlyGovernor {
        governor = newGovernor;
    }

    function claimable(address account) external override view returns (uint256) {
        uint256 balanceWithReward = IPika(pikaToken).balanceWithReward(account);
        if (balanceWithReward == 0) {
            return claimableReward[account];
        }
        uint256 totalSupplyWithReward = IPika(pikaToken).totalSupplyWithReward();
        uint256 currentTotalReward = IERC20(rewardToken).balanceOf(address(this));
        uint256 newReward = currentTotalReward.sub(previousTotalReward);
        uint256 nextCumulativeRewardPerToken = cumulativeRewardPerToken.add(newReward.div(totalSupplyWithReward));
        return claimableReward[account].add(
            balanceWithReward.mul(nextCumulativeRewardPerToken.sub(previousCumulatedRewardPerToken[account])).div(PRECISION));
    }

    function claimRewards(address account, address receiver) external override returns (uint256) {
        require(msg.sender == pikaToken, "RewardDistributor: forbidden");
        updateRewards(account);

        uint256 tokenAmount = claimableReward[account];
        claimableReward[account] = 0;

        IERC20(rewardToken).safeTransfer(receiver, tokenAmount);
        emit Claim(account, tokenAmount);

        return tokenAmount;
    }

    function updateRewards(address account) public override nonReentrant {
        uint256 currentTotalReward = IERC20(rewardToken).balanceOf(address(this));
        uint256 newReward = currentTotalReward.sub(previousTotalReward);
        previousTotalReward = currentTotalReward;

        uint256 _cumulativeRewardPerToken = cumulativeRewardPerToken;
        uint256 totalSupplyWithReward = IPika(pikaToken).totalSupplyWithReward();
        // only update cumulativeRewardPerToken when there are stakers, i.e. when totalSupply > 0
        // if blockReward == 0, then there will be no change to cumulativeRewardPerToken
        if (totalSupplyWithReward > 0 && newReward > 0) {
            _cumulativeRewardPerToken = _cumulativeRewardPerToken.add(newReward.mul(PRECISION).div(totalSupplyWithReward));
            cumulativeRewardPerToken = _cumulativeRewardPerToken;
        }

        // cumulativeRewardPerToken can only increase
        // so if cumulativeRewardPerToken is zero, it means there are no rewards yet
        if (_cumulativeRewardPerToken == 0) {
            return;
        }

        if (account != address(0)) {
            uint256 balanceWithReward = IPika(pikaToken).balanceWithReward(account);
            uint256 _previousCumulatedReward = previousCumulatedRewardPerToken[account];
            uint256 _claimableReward = claimableReward[account].add(
                balanceWithReward.mul(_cumulativeRewardPerToken.sub(_previousCumulatedReward)).div(PRECISION)
            );

            claimableReward[account] = _claimableReward;
            previousCumulatedRewardPerToken[account] = _cumulativeRewardPerToken;
        }
    }
}
