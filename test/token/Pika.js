
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
    this.tokenERC = await hre.ethers.getContractFactory("SimpleERC20")
    this.pikaContract = await hre.ethers.getContractFactory("Pika")
    this.rewardDistributorContract = await hre.ethers.getContractFactory("RewardDistributor")
  })

  beforeEach(async function () {
    this.rewardToken = await this.tokenERC.deploy(18)
    this.pika = await this.pikaContract.deploy(1)
    // use ERC20 rewardToken as reward
    this.rewardDistributor1 = await this.rewardDistributorContract.deploy(this.pika.address, this.rewardToken.address)
    // use ETH as reward
    this.rewardDistributor2 = await this.rewardDistributorContract.deploy(this.pika.address, "0x0000000000000000000000000000000000000000");
    await this.pika.setRewardDistributors([this.rewardDistributor1.address, this.rewardDistributor2.address])
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

  describe("reward distribution", function () {
    it("should claimRewards", async function () {
      await this.pika.grantRole(await this.pika.MINTER_ROLE(), this.alice.address)
      await this.pika.mint(this.alice.address, toWei("10"));
      await this.pika.mint(this.bob.address, toWei("10"));
      await this.rewardToken.mint(this.rewardDistributor1.address, toWei("1000"));
      await web3.eth.sendTransaction({to: this.rewardDistributor2.address, from: this.alice.address, value: web3.utils.toWei("1000")});

      expect(await this.rewardDistributor1.claimable(this.alice.address)).to.be.equal(toWei("500"))
      expect(await this.rewardDistributor1.claimable(this.bob.address)).to.be.equal(toWei("500"))

      await this.pika.claimRewards(this.alice.address);
      // await this.pika.claimRewards(this.bob.address);

      expect(await this.rewardToken.balanceOf(this.alice.address)).to.be.equal(toWei("500"))
      expect(await this.rewardToken.balanceOf(this.bob.address)).to.be.equal(toWei("0"))
      expect(await this.rewardDistributor1.claimable(this.alice.address)).to.be.equal(toWei("0"))
      expect(await this.rewardDistributor1.claimable(this.bob.address)).to.be.equal(toWei("500"))

      // new rewards is added to the distributor
      await this.rewardToken.mint(this.rewardDistributor1.address, toWei("1000"));

      expect(await this.rewardDistributor1.claimable(this.alice.address)).to.be.equal(toWei("500"))
      expect(await this.rewardDistributor1.claimable(this.bob.address)).to.be.equal(toWei("1000"))

    })
  })
})
