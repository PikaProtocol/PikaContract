//SPDX-License-Identifier: MIT

pragma solidity ^0.6.12;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IPika is IERC20 {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
    function totalSupplyWithReward() external view returns (uint256);
    function balanceWithReward(address account) external view returns (uint256);
}
