
const { expect } = require("chai")
const hre = require("hardhat")
const { waffle, web3 } = require("hardhat")
const { BigNumber, ethers } = require("ethers")

const provider = waffle.provider

function toWei (value) {
    return ethers.utils.parseUnits(value, 18);
}

function fromWei (value) {
    return ethers.utils.formatUnits(value, 18);
}

describe("StakingReward", function () {

    before(async function () {
        this.wallets = provider.getWallets()
        this.alice = this.wallets[0]
        this.bob = this.wallets[1]
        this.charlie = this.wallets[2]
        this.tokenERC = await hre.ethers.getContractFactory("SimpleERC20")
        this.pksContract = await hre.ethers.getContractFactory("PKS")
        this.stakingRewardContract = await hre.ethers.getContractFactory("StakingReward")
    })

    beforeEach(async function () {
        this.rewardToken1 = await this.tokenERC.deploy(18)
        this.rewardToken2 = await this.tokenERC.deploy(18)
        this.pks = await this.pksContract.deploy(this.alice.address, this.alice.address)
        this.stakingReward = await this.stakingRewardContract.deploy(this.rewardToken1.address, 86400 * 7, this.alice.address, this.pks.address)
        this.rewardToken1.mint(this.alice.address, "10000000000000000000000")
        this.rewardToken2.mint(this.alice.address, "10000000000000000000000")
        this.pks.mint(this.bob.address, "10000000000000000000000")
        this.pks.mint(this.charlie.address, "10000000000000000000000")
    })


    describe("test stake and withdraw", async function(){
        it("stake and withdraw", async function () {
            console.log(await this.stakingReward.stakingRewards())


        })
    })

    describe("Reward distribution", function () {
        it("Test rewards distribution for multiple pika token holders", async function () {
            await this.pika.grantRole(await this.pika.MINTER_ROLE(), this.alice.address)
            await this.pika.grantRole(await this.pika.BURNER_ROLE(), this.alice.address)
            await this.pika.mint(this.charlie.address, toWei("10"));
            await this.pika.mint(this.bob.address, toWei("10"));
            await this.rewardToken.mint(this.testPikaPerp1.address, toWei("1000"));
            await this.testPikaPerp1.increaseReward(toWei("1000"))

            // 1. Test claimable.
            expect(await this.rewardDistributor1.claimable(this.charlie.address)).to.be.equal(toWei("500"))
            expect(await this.rewardDistributor1.claimable(this.bob.address)).to.be.equal(toWei("500"))

            // 2. Test claimReward.
            await this.pika.connect(this.charlie).claimRewards(this.charlie.address);

            expect(await this.rewardToken.balanceOf(this.charlie.address)).to.be.equal(toWei("500"))
            expect(await this.rewardToken.balanceOf(this.bob.address)).to.be.equal(toWei("0"))
            expect(await this.rewardDistributor1.claimable(this.charlie.address)).to.be.equal(toWei("0"))
            expect(await this.rewardDistributor1.claimable(this.bob.address)).to.be.equal(toWei("500"))

            // 3. Test claimable and claimReward after new reward is added to the distributor.
            await this.rewardToken.mint(this.testPikaPerp1.address, toWei("1000"));
            await this.testPikaPerp1.increaseReward(toWei("1000"))

            expect(await this.rewardDistributor1.claimable(this.charlie.address)).to.be.equal(toWei("500"))
            expect(await this.rewardDistributor1.claimable(this.bob.address)).to.be.equal(toWei("1000"))

            await this.pika.connect(this.bob).claimRewards(this.bob.address);
            expect(await this.rewardToken.balanceOf(this.charlie.address)).to.be.equal(toWei("500"))
            expect(await this.rewardToken.balanceOf(this.bob.address)).to.be.equal(toWei("1000"))
            expect(await this.rewardDistributor1.claimable(this.charlie.address)).to.be.equal(toWei("500"))
            expect(await this.rewardDistributor1.claimable(this.bob.address)).to.be.equal(toWei("0"))

            // 4. Test burn token.
            await this.pika.burn(this.bob.address, toWei("5")); // After burning 5, bob has 5 token, and totalSupply is 15.
            // After the new reward is added, the new reward only goes to the new pika token holder.
            await this.rewardToken.mint(this.testPikaPerp1.address, toWei("900"));
            await this.testPikaPerp1.increaseReward(toWei("900"))
            expect(await this.rewardDistributor1.claimable(this.charlie.address)).to.be.equal(toWei("1100")) // previous 500 + 900 * 2/3
            expect(await this.rewardDistributor1.claimable(this.bob.address)).to.be.equal(toWei("300")) // 900/3

            // 5. Test add and remove no reward account
            await this.pika.addToNoRewardAccounts(this.bob.address)
            await this.rewardToken.mint(this.testPikaPerp1.address, toWei("1000"));
            await this.testPikaPerp1.increaseReward(toWei("1000"))
            expect(await this.rewardDistributor1.claimable(this.charlie.address)).to.be.equal(toWei("2100")) // previous 1100 + 1000
            expect(await this.rewardDistributor1.claimable(this.bob.address)).to.be.equal(toWei("300")) // no additional reward

            await this.pika.removeFromNoRewardAccounts(this.bob.address)
            await this.rewardToken.mint(this.testPikaPerp1.address, toWei("900"));
            await this.testPikaPerp1.increaseReward(toWei("900"))
            expect(await this.rewardDistributor1.claimable(this.charlie.address)).to.be.equal(toWei("2700")) // previous 2100 + 600
            expect(await this.rewardDistributor1.claimable(this.bob.address)).to.be.equal(toWei("600")) // previous 300 + 300

            // 6. Test pika token transfer.
            // After pika token is transferred, the previous rewards still belongs to the old account.
            await this.pika.connect(this.charlie).transfer(this.bob.address, toWei("10"))
            expect(await this.rewardDistributor1.claimable(this.charlie.address)).to.be.equal(toWei("2700"))
            expect(await this.rewardDistributor1.claimable(this.bob.address)).to.be.equal(toWei("600"))
            // After the new reward is added, the new reward only goes to the new pika token holder.
            await this.rewardToken.mint(this.testPikaPerp1.address, toWei("1000"));
            await this.testPikaPerp1.increaseReward(toWei("900"))
            expect(await this.rewardDistributor1.claimable(this.charlie.address)).to.be.equal(toWei("2700"))
            expect(await this.rewardDistributor1.claimable(this.bob.address)).to.be.equal(toWei("1500"))

            await this.pika.connect(this.charlie).claimRewards(this.charlie.address);
            await this.pika.connect(this.bob).claimRewards(this.bob.address);
            expect(await this.rewardToken.balanceOf(this.charlie.address)).to.be.equal(toWei("3200")) // previous 500 + 2700
            expect(await this.rewardToken.balanceOf(this.bob.address)).to.be.equal(toWei("2500")) // previous 1000 + 1500
        })
    })
})
