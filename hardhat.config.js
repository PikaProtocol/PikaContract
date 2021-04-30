require("@nomiclabs/hardhat-waffle");
require('@openzeppelin/hardhat-upgrades');
require("solidity-coverage");
require("@nomiclabs/hardhat-web3");
// require("hardhat-gas-reporter");

// You need to export an object to set up your config
// Go to https://hardhat.org/config/ to learn more

/**
 * @type import('hardhat/config').HardhatUserConfig
 */

module.exports = {
    defaultNetwork: "hardhat",
    networks: {
        hardhat: {
            accounts: {
                accountsBalance: "100000000000000000000000"
            }
        }
    },
    solidity: {
        version: "0.6.12",
        settings: {
            outputSelection: {
                "*": {
                    "*": ["storageLayout"],
                },
            },
            optimizer: {
                enabled: true,
                runs: 200
            }
        }
    }
}


