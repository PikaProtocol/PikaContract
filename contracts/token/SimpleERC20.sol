// SPDX-License-Identifier: MIT

pragma solidity >= 0.6.12;
import '@openzeppelin/contracts/token/ERC20/ERC20.sol';

contract SimpleERC20 is ERC20 {
    constructor()
    ERC20('TEST', 'TEST')
    public
    { }

    function mint(address to, uint amount) public {
        _mint(to, amount);
    }
}
