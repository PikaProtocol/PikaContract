//SPDX-License-Identifier: MIT

pragma solidity 0.6.12;

interface IRewardDistributor {
    function claimRewards(address account, address receiver) external returns (uint256);
    function updateRewards(address account) external;
    function claimable(address account) external view returns (uint256);
}
