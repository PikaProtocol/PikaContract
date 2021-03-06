//SPDX-License-Identifier: MIT

pragma solidity 0.6.12;

interface IOracle {
    /// @dev Return the current target price for the asset.
    function getPrice() external view returns (uint256);
}
