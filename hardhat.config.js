require("@nomiclabs/hardhat-waffle");
require('@openzeppelin/hardhat-upgrades');

// This is a sample Hardhat task. To learn how to create your own go to
// https://hardhat.org/guides/create-task.html
task("accounts", "Prints the list of accounts", async () => {
    let provider = ethers.getDefaultProvider();
    const accounts = await ethers.getSigners();

    for (const account of accounts) {
        const balance = await provider.getBalance(account.address);
        console.log(account.address, balance.toString());
    }
});

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
                accountsBalance: "10000000000000000000000"
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


