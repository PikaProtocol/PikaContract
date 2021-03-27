pragma solidity 0.6.12;

import '@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol';

contract SimpleERC20 is ERC20Upgradeable {
    constructor() public {
        __ERC20_init('MOCK', 'MOCK');
    }

    function mint(address to, uint amount) public {
        _mint(to, amount);
    }
}
