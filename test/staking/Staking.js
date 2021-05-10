
const { expect } = require("chai")
const hre = require("hardhat")
const { waffle, web3 } = require("hardhat")
const { BigNumber, ethers } = require("ethers")

const provider = waffle.provider

// Assert that actual is less than 1/accuracy difference from expected
function assertAlmostEqual(actual, expected, accuracy = 100000) {
    const expectedBN = BigNumber.isBigNumber(expected) ? expected : BigNumber.from(expected)
    const actualBN = BigNumber.isBigNumber(actual) ? actual : BigNumber.from(actual)
    const diffBN = expectedBN.gt(actualBN) ? expectedBN.sub(actualBN) : actualBN.sub(expectedBN)
    if (expectedBN.gt(0)) {
        return expect(
            diffBN).to.lt(expectedBN.div(BigNumber.from(accuracy.toString()))
        )
    }
    return expect(
        diffBN).to.lt(-1 * expectedBN.div(BigNumber.from(accuracy.toString()))
    )
}

describe("Staking", function () {

    before(async function () {
        this.wallets = provider.getWallets()
        this.owner = this.wallets[0]
        this.rewardDistributor = this.wallets[1]
        this.stakingAccount1 = this.wallets[2]
        this.stakingAccount2 = this.wallets[3]
        this.tokenERC = await hre.ethers.getContractFactory("SimpleERC20")
        this.pksContract = await hre.ethers.getContractFactory("PKS")
        this.stakingContract = await hre.ethers.getContractFactory("Staking")
    })

    beforeEach(async function () {
        this.rewardToken1 = await this.tokenERC.deploy(18)
        this.rewardToken2 = await this.tokenERC.deploy(18)
        this.pks = await this.pksContract.deploy(this.owner.address, this.owner.address)
        this.staking = await this.stakingContract.deploy(this.rewardToken1.address, 86400 * 7, this.rewardDistributor.address, this.pks.address)
        this.rewardToken1.mint(this.rewardDistributor.address, "10000000000000000000000")
        this.rewardToken2.mint(this.rewardDistributor.address, "10000000000000000000000")
        this.pks.mint(this.stakingAccount1.address, "10000000000000000000000")
        this.pks.mint(this.stakingAccount2.address, "10000000000000000000000")
    })


    describe("test notifyRewardAmount", async function(){
        it("notifyRewardAmount success", async function () {
            await this.rewardToken1.connect(this.rewardDistributor).transfer(this.staking.address, "1000000000000000000000")
            await this.staking.connect(this.rewardDistributor).notifyRewardAmount(0, "1000000000000000000000", {from: this.rewardDistributor.address})
            const sr = await this.staking.stakingRewards(0)
            expect(sr.periodFinish.sub(sr.lastUpdateTime)).to.be.equal(86400 * 7)
            expect(sr.rewardRate).to.be.equal(BigNumber.from("1000000000000000000000").div(86400 * 7))
        })

        it("notifyRewardAmount success with leftover", async function () {
            await this.rewardToken1.connect(this.rewardDistributor).transfer(this.staking.address, "1000000000000000000000")
            await this.staking.connect(this.rewardDistributor).notifyRewardAmount(0, "1000000000000000000000", {from: this.rewardDistributor.address})
            const sr1 = await this.staking.stakingRewards(0)
            await this.rewardToken1.connect(this.rewardDistributor).transfer(this.staking.address, "1000000000000000000000")
            await this.staking.connect(this.rewardDistributor).notifyRewardAmount(0, "1000000000000000000000", {from: this.rewardDistributor.address})
            const sr2 = await this.staking.stakingRewards(0)
            assertAlmostEqual(sr2.periodFinish.sub(sr2.lastUpdateTime), 86400 * 7)
            assertAlmostEqual(sr2.rewardRate, sr1.rewardRate.mul(2))
        })

        it("notifyRewardAmount reward is too small", async function () {
            await this.rewardToken1.connect(this.rewardDistributor).transfer(this.staking.address, "1000000000000000000000")
            await expect(this.staking.connect(this.rewardDistributor).notifyRewardAmount(0, "1")).to.be.revertedWith("Reward is too small")
        })

        it("notifyRewardAmount reward is too big", async function () {
            await this.rewardToken1.connect(this.rewardDistributor).transfer(this.staking.address, "1000000000000000000000")
            await expect(this.staking.connect(this.rewardDistributor).notifyRewardAmount(0, "10000000000000000000000")).to.be.revertedWith("Reward is too big")
        })
    })

    describe("test setDuration", async function() {
        it("setDuration before notifyReward", async function () {
            await this.staking.connect(this.rewardDistributor).setDuration(0, 3600);
            const sr = await this.staking.stakingRewards(0)
            expect(sr.duration).to.be.equal("3600")
        })

        it("setDuration after notifyReward fail", async function () {
            await this.rewardToken1.connect(this.rewardDistributor).transfer(this.staking.address, "1000000000000000000000")
            await this.staking.connect(this.rewardDistributor).notifyRewardAmount(0, "1000000000000000000000", {from: this.rewardDistributor.address})
            await expect(this.staking.connect(this.rewardDistributor).setDuration(0, 3600)).to.be.revertedWith("revert Not finished yet");
        })

        it("setDuration after notifyReward success", async function () {
            await this.rewardToken1.connect(this.rewardDistributor).transfer(this.staking.address, "1000000000000000000000")
            await this.staking.connect(this.rewardDistributor).notifyRewardAmount(0, "1000000000000000000000", {from: this.rewardDistributor.address})
            await provider.send("evm_increaseTime", [86400 * 7])
            await this.staking.connect(this.rewardDistributor).setDuration(0, 3600)
            const sr = await this.staking.stakingRewards(0)
            expect(sr.duration).to.be.equal("3600")
        })
    })

    describe("test stake, withdraw, claimReward, exit", async function() {
        it("single reward", async function () {
            await this.rewardToken1.connect(this.rewardDistributor).transfer(this.staking.address, "1000000000000000000000")
            await this.staking.connect(this.rewardDistributor).notifyRewardAmount(0, "1000000000000000000000", {from: this.rewardDistributor.address})
            const sr1 = await this.staking.stakingRewards(0)

            // stakingAccount1 stake
            await this.pks.connect(this.stakingAccount1).approve(this.staking.address, "10000000000000000000000")
            await this.staking.connect(this.stakingAccount1).stake("5000000000000000000000") // stake half of balance
            expect(await this.staking.balanceOf(this.stakingAccount1.address)).to.be.equal("5000000000000000000000")

            // 1 hour later stakingAccount1 check rewards
            await provider.send("evm_increaseTime", [3600])
            await provider.send("evm_mine")
            const stakingAccount1Earned = await this.staking.earned(0, this.stakingAccount1.address);
            assertAlmostEqual(stakingAccount1Earned, sr1.rewardRate.mul(3600), 1000)

            // withdraw half
            await this.staking.connect(this.stakingAccount1).withdraw("2500000000000000000000")
            expect(await this.staking.balanceOf(this.stakingAccount1.address)).to.be.equal("2500000000000000000000")

            // stakingAccount2 stake the same amount as stakingAccount1's current staked balance
            await this.pks.connect(this.stakingAccount2).approve(this.staking.address, "10000000000000000000000")
            await this.staking.connect(this.stakingAccount2).stake("2500000000000000000000")
            expect(await this.staking.balanceOf(this.stakingAccount2.address)).to.be.equal("2500000000000000000000")
            expect(await this.staking.totalSupply()).to.be.equal("5000000000000000000000")

            // 1 hour later check rewards
            await provider.send("evm_increaseTime", [3600])
            await provider.send("evm_mine")
            const newSr1 = await this.staking.stakingRewards(0)
            const newStakingAccount1Earned = await this.staking.earned(0, this.stakingAccount1.address)
            const stakingAccount2Earned = await this.staking.earned(0, this.stakingAccount2.address)
            assertAlmostEqual(newStakingAccount1Earned.sub(stakingAccount1Earned), newSr1.rewardRate.mul(3600).div(2), 100)
            assertAlmostEqual(stakingAccount2Earned, newSr1.rewardRate.mul(3600).div(2), 100)

            // claim reward for stakingAccount1
            await this.staking.connect(this.stakingAccount1).getReward(0)
            assertAlmostEqual(await this.rewardToken1.balanceOf(this.stakingAccount1.address), newStakingAccount1Earned, 1000)

            // exit for stakingAccount2
            await this.staking.connect(this.stakingAccount2).exit()
            assertAlmostEqual(await this.rewardToken1.balanceOf(this.stakingAccount2.address), stakingAccount2Earned, 1000)
            expect(await this.staking.totalSupply()).to.be.equal("2500000000000000000000") // stakingAccount1 still have staked balance
        })

        it("multiple reward", async function () {
            await this.rewardToken1.connect(this.rewardDistributor).transfer(this.staking.address, "1000000000000000000000")
            await this.staking.connect(this.rewardDistributor).notifyRewardAmount(0, "1000000000000000000000", {from: this.rewardDistributor.address})
            const sr1 = await this.staking.stakingRewards(0)
            await this.staking.addRewardToken(this.rewardToken2.address, 86400 * 7, this.rewardDistributor.address);
            await this.rewardToken2.connect(this.rewardDistributor).transfer(this.staking.address, "1000000000000000000000")
            await this.staking.connect(this.rewardDistributor).notifyRewardAmount(1, "1000000000000000000000", {from: this.rewardDistributor.address})
            const sr2 = await this.staking.stakingRewards(1)

            // stakingAccount1 stake
            await this.pks.connect(this.stakingAccount1).approve(this.staking.address, "10000000000000000000000")
            await this.staking.connect(this.stakingAccount1).stake("5000000000000000000000") // stake half of balance
            expect(await this.staking.balanceOf(this.stakingAccount1.address)).to.be.equal("5000000000000000000000")

            // 1 hour later stakingAccount1 check rewards
            await provider.send("evm_increaseTime", [3600])
            await provider.send("evm_mine")
            const stakingAccount1Reward1Earned = await this.staking.earned(0, this.stakingAccount1.address);
            const stakingAccount1Reward2Earned = await this.staking.earned(1, this.stakingAccount1.address);
            assertAlmostEqual(stakingAccount1Reward1Earned, sr1.rewardRate.mul(3600), 1000)
            assertAlmostEqual(stakingAccount1Reward2Earned, sr2.rewardRate.mul(3600), 1000)

            // withdraw half
            await this.staking.connect(this.stakingAccount1).withdraw("2500000000000000000000")
            expect(await this.staking.balanceOf(this.stakingAccount1.address)).to.be.equal("2500000000000000000000")

            // stakingAccount2 stake the same amount as stakingAccount1's current staked balance
            await this.pks.connect(this.stakingAccount2).approve(this.staking.address, "10000000000000000000000")
            await this.staking.connect(this.stakingAccount2).stake("2500000000000000000000")
            expect(await this.staking.balanceOf(this.stakingAccount2.address)).to.be.equal("2500000000000000000000")
            expect(await this.staking.totalSupply()).to.be.equal("5000000000000000000000")

            // 1 hour later check rewards
            await provider.send("evm_increaseTime", [3600])
            await provider.send("evm_mine")
            const newSr1 = await this.staking.stakingRewards(0)
            const newSr2 = await this.staking.stakingRewards(0)
            const newStakingAccount1Reward1Earned = await this.staking.earned(0, this.stakingAccount1.address)
            const stakingAccount2Reward1Earned = await this.staking.earned(0, this.stakingAccount2.address)
            const newStakingAccount1Reward2Earned = await this.staking.earned(1, this.stakingAccount1.address)
            const stakingAccount2Reward2Earned = await this.staking.earned(1, this.stakingAccount2.address)
            assertAlmostEqual(newStakingAccount1Reward1Earned.sub(stakingAccount1Reward1Earned), newSr1.rewardRate.mul(3600).div(2), 100)
            assertAlmostEqual(stakingAccount2Reward1Earned, newSr1.rewardRate.mul(3600).div(2), 100)
            assertAlmostEqual(newStakingAccount1Reward2Earned.sub(stakingAccount1Reward2Earned), newSr2.rewardRate.mul(3600).div(2), 100)
            assertAlmostEqual(stakingAccount2Reward2Earned, newSr2.rewardRate.mul(3600).div(2), 100)

            // claim reward for stakingAccount1
            await this.staking.connect(this.stakingAccount1).getAllRewards()
            assertAlmostEqual(await this.rewardToken1.balanceOf(this.stakingAccount1.address), newStakingAccount1Reward1Earned, 1000)
            assertAlmostEqual(await this.rewardToken2.balanceOf(this.stakingAccount1.address), newStakingAccount1Reward1Earned, 1000)

            // exit for stakingAccount2
            await this.staking.connect(this.stakingAccount2).exit()
            assertAlmostEqual(await this.rewardToken1.balanceOf(this.stakingAccount2.address), stakingAccount2Reward1Earned, 1000)
            assertAlmostEqual(await this.rewardToken2.balanceOf(this.stakingAccount2.address), stakingAccount2Reward2Earned, 1000)
            expect(await this.staking.totalSupply()).to.be.equal("2500000000000000000000") // stakingAccount1 still have staked balance
        })
    })
})
