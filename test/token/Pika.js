
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

describe("Pika", function () {

  before(async function () {
    this.wallets = provider.getWallets()
    this.alice = this.wallets[0]
    this.bob = this.wallets[1]
    this.charlie = this.wallets[2]
    this.tokenERC = await hre.ethers.getContractFactory("SimpleERC20")
    this.pikaContract = await hre.ethers.getContractFactory("Pika")
    this.rewardDistributorContract = await hre.ethers.getContractFactory("RewardDistributor")
    this.testPikaPerpContract1 = await hre.ethers.getContractFactory("TestPikaPerp")
    this.testPikaPerpContract2 = await hre.ethers.getContractFactory("TestPikaPerp")
  })

  beforeEach(async function () {
    this.rewardToken = await this.tokenERC.deploy(18)
    this.pika = await this.pikaContract.deploy(1)
    // use ERC20 rewardToken as reward
    this.rewardDistributor1 = await this.rewardDistributorContract.deploy(this.pika.address, this.rewardToken.address)
    // use ETH as reward
    this.rewardDistributor2 = await this.rewardDistributorContract.deploy(this.pika.address, "0x0000000000000000000000000000000000000000");
    this.testPikaPerp1 = await this.testPikaPerpContract1.deploy()
    this.testPikaPerp2 = await this.testPikaPerpContract2.deploy()
    await this.testPikaPerp1.initialize(this.rewardToken.address)
    await this.testPikaPerp2.initialize("0x0000000000000000000000000000000000000000")
    await this.testPikaPerp1.setRewardDistributor(this.rewardDistributor1.address)
    await this.testPikaPerp2.setRewardDistributor(this.rewardDistributor2.address)
    await this.pika.setRewardDistributors([this.rewardDistributor1.address, this.rewardDistributor2.address])
    await this.rewardDistributor1.setPikaPerp(this.testPikaPerp1.address)
    await this.rewardDistributor2.setPikaPerp(this.testPikaPerp2.address)
  })


  describe("test mint and burn", async function(){
    it("test mint and burn", async function () {

      await expect(this.pika.mint(this.bob.address, "1000000")).to.be.revertedWith("Caller is not a minter")
      await expect(this.pika.burn(this.bob.address, "1000000")).to.be.revertedWith("Caller is not a burner")

      await this.pika.grantRole(await this.pika.MINTER_ROLE(), this.alice.address)
      await this.pika.grantRole(await this.pika.BURNER_ROLE(), this.alice.address)

      this.pika.mint(this.bob.address, "1000000");
      expect(await this.pika.balanceOf(this.bob.address)).to.be.equal("1000000")
      this.pika.burn(this.bob.address, "1000000");
      expect(await this.pika.balanceOf(this.bob.address)).to.be.equal("0")

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

    it("Test rewards distribution from multiple pikaPerp contracts", async function () {
      await this.pika.grantRole(await this.pika.MINTER_ROLE(), this.alice.address)
      await this.pika.mint(this.charlie.address, toWei("10"));
      await this.pika.mint(this.bob.address, toWei("10"));
      // testPikaPerp1 uses ERC20 rewardToken as reward
      await this.rewardToken.mint(this.testPikaPerp1.address, toWei("1000"));
      await this.testPikaPerp1.increaseReward(toWei("1000"))
      // testPikaPerp2 uses ETH as reward
      await web3.eth.sendTransaction({to: this.testPikaPerp2.address, from: this.alice.address, value: web3.utils.toWei("1000")});
      await this.testPikaPerp2.increaseReward(toWei("1000"))
      const initialCharlieEthBalance = await provider.getBalance(this.charlie.address);
      const initialBobEthBalance = await provider.getBalance(this.bob.address);

      // 1. Test claimable.
      expect(await this.rewardDistributor1.claimable(this.bob.address)).to.be.equal(toWei("500"))
      expect(await this.rewardDistributor2.claimable(this.bob.address)).to.be.equal(toWei("500"))

      // 2. Test claimReward function claims both eth and rewardToken as rewards.
      await this.pika.connect(this.bob).claimRewards(this.bob.address, {gasPrice: 0});

      expect(await this.rewardToken.balanceOf(this.bob.address)).to.be.equal(toWei("500"))
      expect((await provider.getBalance(this.bob.address)).sub(initialBobEthBalance)).to.be.equal(toWei("500"))
      expect(await this.rewardDistributor1.claimable(this.bob.address)).to.be.equal(toWei("0"))
      expect(await this.rewardDistributor2.claimable(this.bob.address)).to.be.equal(toWei("0"))

      // 3. Test claimable and claimReward after new eth reward is added to the distributor.
      await web3.eth.sendTransaction({to: this.testPikaPerp2.address, from: this.alice.address, value: web3.utils.toWei("1000")});
      await this.testPikaPerp2.increaseReward(toWei("1000"))

      expect(await this.rewardDistributor1.claimable(this.bob.address)).to.be.equal(toWei("0"))
      expect(await this.rewardDistributor2.claimable(this.bob.address)).to.be.equal(toWei("500"))

      await this.pika.connect(this.bob).claimRewards(this.bob.address, {gasPrice: 0});
      expect(await this.rewardToken.balanceOf(this.bob.address)).to.be.equal(toWei("500"))
      expect((await provider.getBalance(this.bob.address)).sub(initialBobEthBalance)).to.be.equal(toWei("1000"))
      expect(await this.rewardDistributor1.claimable(this.bob.address)).to.be.equal(toWei("0"))
      expect(await this.rewardDistributor2.claimable(this.bob.address)).to.be.equal(toWei("0"))
      expect(await this.rewardDistributor1.claimable(this.charlie.address)).to.be.equal(toWei("500"))
      expect(await this.rewardDistributor2.claimable(this.charlie.address)).to.be.equal(toWei("1000"))

      // 4. Test pika token transfer.
      // After pika token is transferred, the previous rewards still belongs to the old account.
      await this.pika.connect(this.charlie).transfer(this.bob.address, toWei("10"), {gasPrice: 0})
      expect(await this.rewardDistributor1.claimable(this.charlie.address)).to.be.equal(toWei("500"))
      expect(await this.rewardDistributor2.claimable(this.charlie.address)).to.be.equal(toWei("1000"))
      // After the new eth reward is added, the new reward only goes to the new pika token holder.
      await web3.eth.sendTransaction({to: this.testPikaPerp2.address, from: this.alice.address, value: web3.utils.toWei("1000"), gasPrice:0});
      await this.testPikaPerp2.increaseReward(toWei("1000"))

      expect(await this.rewardDistributor1.claimable(this.bob.address)).to.be.equal(toWei("0"))
      expect(await this.rewardDistributor2.claimable(this.bob.address)).to.be.equal(toWei("1000"))
      expect(await this.rewardDistributor1.claimable(this.charlie.address)).to.be.equal(toWei("500"))
      expect(await this.rewardDistributor2.claimable(this.charlie.address)).to.be.equal(toWei("1000"))

      await this.pika.connect(this.bob).claimRewards(this.bob.address, {gasPrice: 0});
      await this.pika.connect(this.charlie).claimRewards(this.charlie.address, {gasPrice: 0});
      expect(await this.rewardToken.balanceOf(this.bob.address)).to.be.equal(toWei("500")) // previous 500 + 0
      expect((await provider.getBalance(this.bob.address)).sub(initialBobEthBalance)).to.be.equal(toWei("2000")) // previous 1000 + 1000
      expect(await this.rewardToken.balanceOf(this.charlie.address)).to.be.equal(toWei("500"))
      expect((await provider.getBalance(this.charlie.address)).sub(initialCharlieEthBalance)).to.be.equal(toWei("1000"))
    })

    it("Test recover rewards", async function () {
      await this.pika.grantRole(await this.pika.MINTER_ROLE(), this.alice.address)
      await this.pika.mint(this.bob.address, toWei("10"));
      await this.rewardToken.mint(this.testPikaPerp1.address, toWei("1000"));
      await this.testPikaPerp1.increaseReward(toWei("1000"))

      // 1. Test claimable.
      expect(await this.rewardDistributor1.claimable(this.bob.address)).to.be.equal(toWei("1000"))

      // 2. Test recoverReward.
      await expect(this.pika.connect(this.charlie).recoverReward(this.bob.address, this.bob.address)).to.be.revertedWith("Caller is not the governor")
      await this.pika.connect(this.alice).recoverReward(this.bob.address, this.bob.address);
      expect(await this.rewardToken.balanceOf(this.bob.address)).to.be.equal(toWei("1000"))
    })
  })
})
