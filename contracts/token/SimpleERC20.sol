//SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import '@openzeppelin/contracts/token/ERC20/ERC20.sol';

contract SimpleERC20 is ERC20 {
    constructor(uint8 decimals)
    ERC20('TEST', 'TEST')
    public {
    }

    function mint(address to, uint amount) public {
        _mint(to, amount);
    }
}
