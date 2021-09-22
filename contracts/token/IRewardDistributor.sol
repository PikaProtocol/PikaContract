//SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

interface IRewardDistributor {
    function claimRewards(address account, address payable receiver) external returns (uint256);
    function updateRewards(address account) external;
    function claimable(address account) external view returns (uint256);
}
