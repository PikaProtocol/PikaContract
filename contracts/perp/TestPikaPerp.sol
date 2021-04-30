//SPDX-License-Identifier: MIT

pragma solidity 0.6.12;

import '@openzeppelin/contracts-upgradeable/proxy/Initializable.sol';
import '@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol';
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import './IPikaPerp.sol';
import '../lib/UniERC20.sol';

contract TestPikaPerp is Initializable, IPikaPerp {
    using SafeERC20 for IERC20;
    using UniERC20 for IERC20;
    using SafeMathUpgradeable for uint;

    IERC20 public token; // The token to settle perpetual contracts.
    uint public pikaReward; // The trading fee reward for pika holders.
    address payable public rewardDistributor; // The distributor address to receive the trading fee reward.

    function initialize(
        IERC20 _token
    ) public initializer {
        token = _token;
    }
    /// @dev Return the current insurance balance.
    function insurance() external view override returns (int) {
        return 0;
    }

    /// @dev Return the current burden value.
    function burden() external view override returns (int) {
        return 0;
    }

    /// @dev Return the current mark price.
    function mark() external view override returns (uint) {
        return 0;
    }

    // @dev Send reward to reward distributor.
    function distributeReward() external override returns (uint) {
        if (pikaReward > 0) {
            token.uniTransfer(rewardDistributor, pikaReward);
            uint distributedReward = pikaReward;
            pikaReward = 0;
            return distributedReward;
        }
        return 0;
    }

    // @dev Get the reward amount that has not been distributed.
    function getPendingReward() external override view returns (uint) {
        return pikaReward;
    }

    function increaseReward(uint reward) external {
        pikaReward = pikaReward.add(reward);
    }

    function setRewardDistributor(address payable newRewardDistributor) external {
        rewardDistributor = newRewardDistributor;
    }

    // function to receive ether as rewards
    receive() external payable {}
}
