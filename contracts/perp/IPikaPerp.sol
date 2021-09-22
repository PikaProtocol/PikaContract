
//SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

interface IPikaPerp {
    // @dev Send reward to reward distributor.
    function distributeReward() external returns (uint256);

    // @dev Get the reward amount that has not been distributed.
    function getPendingReward() external view returns (uint256);
}
