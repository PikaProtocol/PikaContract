pragma solidity 0.6.12;

import './interfaces/IOracle.sol';

contract SimpleOracle is IOracle {
    uint public px;

    function setPx(uint _px) external {
        px = _px;
    }

    function getPx() external view override returns (uint) {
        return px;
    }
}
