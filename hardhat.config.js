require("@nomiclabs/hardhat-waffle");
require('@openzeppelin/hardhat-upgrades');
require("solidity-coverage");
require("@nomiclabs/hardhat-web3");
require("@nomiclabs/hardhat-etherscan");
// require("hardhat-gas-reporter");
const { infuraApiKey, mnemonic, etherscanApiKey } = require('./secrets.json');

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
        },
        kovan: {
            url: `https://kovan.infura.io/v3/${infuraApiKey}`,
            accounts: {mnemonic: mnemonic}
        }
    },
    etherscan: {
        apiKey:`${etherscanApiKey}`
    },
    solidity: {
        compilers: [{
            version: "0.8.7",
            settings: {
                optimizer: {
                    enabled: true,
                    runs: 200
                }
            }
        }]
    }
}


