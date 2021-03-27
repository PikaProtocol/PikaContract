pragma solidity 0.6.12;

interface IOracle {
    /// @dev Return the current target price for the asset.
    function getPx() external view returns (uint);
}
