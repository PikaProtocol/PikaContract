// SPDX-License-Identifier: MIT

pragma solidity >=0.6.12;

contract SimpleOracle {
    uint256 public px;

    function setPrice(uint256 _px) external {
        px = _px;
    }

    function getPrice() external view returns (uint256) {
        return px;
    }
}
