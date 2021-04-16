//SPDX-License-Identifier: MIT

pragma solidity 0.6.12;

interface IPikaPerp {
    /// @dev Return the current insurance balance.
    function insurance() external view returns (int);

    /// @dev Return the current burden value.
    function burden() external view returns (int);

    /// @dev Return the current mark price.
    function mark() external view returns (uint);
}
