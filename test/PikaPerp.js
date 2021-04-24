// import { ethers } from "hardhat";
// import { expect } from "chai";
const { expect, should } = require("chai");
const hre = require("hardhat");
const { waffle } = require("hardhat");
const { BigNumber, ethers, utils } = require("ethers");

const provider = waffle.provider;
// const provider = ethers.getDefaultProvider()
const TRADING_FEE = 0.0025 // 0.25% of notional value.
const SAFE_THRESHOLD = 0.93;
const MintLong = 0;
const BurnLong = 1;
const MintShort = 2;
const BurnShort = 3;
const DECAY_PER_SECOND = 0.998

// Assert that actual is less than 0.001% difference from expected
function assertAlmostEqual(actual, expected, accuracy = 100000) {
  const expectedBN = BigNumber.isBigNumber(expected) ? expected : BigNumber.from(expected);
  const actualBN = BigNumber.isBigNumber(actual) ? actual : BigNumber.from(actual);
  const diffBN = expectedBN.gt(actualBN) ? expectedBN.sub(actualBN) : actualBN.sub(expectedBN);
  if (expectedBN.gt(0)) {
    return expect(
        diffBN).to.lt(expectedBN.div(BigNumber.from(accuracy.toString()))
    );
  }
  return expect(
      diffBN).to.lt(-1 * expectedBN.div(BigNumber.from(accuracy.toString()))
  );
}

function getSlot(strike) {
  if (strike < 100) return strike + 800;
  let magnitude = 1;
  while (strike >= 1000) {
    magnitude++;
    strike /= 10;
  }
  return 900 * magnitude + strike - 100;
}

describe("PikaPerp", function () {

  before(async function () {
    this.wallets = provider.getWallets()
    // this.signers = await ethers.getSigners()
    this.alice = this.wallets[0]
    this.bob = this.wallets[1]
    this.carol = this.wallets[2]
    this.dev = this.wallets[3]
    this.referrer = this.wallets[4]
    this.rewardDistributor = this.wallets[5]
    const initialEthBalance = await provider.getBalance(this.alice.address);
    console.log("initial balance", initialEthBalance.toString());

    this.token = this.wallets[6]

    this.perp = await hre.ethers.getContractFactory("PikaPerp");
    this.tokenERC = await hre.ethers.getContractFactory("SimpleERC20");
    this.linkoracle = await hre.ethers.getContractFactory("SimpleOracle");
    this.pikacontract = await hre.ethers.getContractFactory("Pika")
  })

  beforeEach(async function () {
    this.pikaPerp = await this.perp.deploy();
    this.token = await this.tokenERC.deploy()
    this.oracle = await this.linkoracle.deploy()
    this.pika = await this.pikacontract.deploy(42)
    this.uri = "URI"
    this.coeff = "50000000000000000000000000000000000000000000000" // 5e46, 5e10 * 1e18 * 1e18
    this.reserve = "10000000000000000000000000" // 1e25, 10e7 * 1e18, representing $10m usd
    this.baseReserve = "5000000000000000000000" // 5e21, 5e3 * 1e18, representing 5000 eth
    this.liquidationPerSec = "100000000000000000000"
    await this.oracle.setPrice(500000000000000); // set oracle price to 1/2000
    await this.pikaPerp.initialize(
      this.uri, this.pika.address, "0x0000000000000000000000000000000000000000", this.oracle.address, this.coeff, this.reserve, this.liquidationPerSec, this.rewardDistributor.address
    )
    await this.pika.grantRole(await this.pika.MINTER_ROLE(), this.pikaPerp.address)
    await this.pika.grantRole(await this.pika.BURNER_ROLE(), this.pikaPerp.address)
  })


  describe("initialize", async function(){
    it("Verify parameters being set", async function () {
      const burdenValue = await this.pikaPerp.burden()
      expect(burdenValue).to.equal("0")

      const insurance = await this.pikaPerp.insurance()
      expect(insurance).to.equal('0')

      const pokeFunction = await this.pikaPerp.poke()
      expect(pokeFunction)

      const coeffValue = await this.pikaPerp.coeff()
      expect(coeffValue).to.equal(this.coeff)

      const commissionOf = await this.pikaPerp.commissionOf(this.dev.address)
      expect(commissionOf).to.equal("0")

      const decayPerSecond = await this.pikaPerp.decayPerSecond()
      expect(decayPerSecond).to.equal("998000000000000000")

      const spotPx = await this.pikaPerp.getSpotPx()
      expect(spotPx).to.equal(500000000000000) // initial price is 1/2000

      const latestMark = await this.pikaPerp.getLatestMark()
      expect(latestMark).to.equal(500000000000000) // 1/2000

      const reserve = await this.pikaPerp.reserve()
      expect(reserve).to.equal(this.reserve)

      const minSafeSlot = await this.pikaPerp.minSafeShortSlot()
      expect(minSafeSlot).to.be.equal("12138");

      const maxSafeSlot = await this.pikaPerp.maxSafeLongSlot()
      expect(maxSafeSlot).to.equal('12065')
    })
  })

  describe("trade functions", function () {
    it("should openLong success", async function () {
      const size = "1000000000000000000000" // 1000 usd
      const minGet = "300000000000000000" // 0.3 eth
      const strike = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", true);  // the strike for 5x long is 1667
      const referrer = this.referrer.address
      const initialEthBalance = await provider.getBalance(this.alice.address);
      await this.pikaPerp.openLong(size, strike, minGet, referrer, {from: this.alice.address, value: "1000000000000000000", gasPrice: "0"}) // 1eth
      // verity eth paid
      const expectedPay = BigNumber.from("600000000000000000")  // 0.6 eth , 1/1667 * 1000
      const expectedGet = BigNumber.from("498700129987001299") // 0.498.. eth, (5e3 - 5e10 / (1e7 + 1000)) * (1 - TRADING_FEE)
      const expectedGetWithoutFee = BigNumber.from("499950005000000000")
      const expectedEthPaid = expectedPay.sub(expectedGet)
      const currentEthBalance = await provider.getBalance(this.alice.address)
      const ethPaid = (initialEthBalance - currentEthBalance).toString()
      console.log("expected eth paid", expectedEthPaid.toString())
      console.log("eth paid", ethPaid)
      assertAlmostEqual(ethPaid, expectedEthPaid)
      // check leverage token balance
      const ident = await this.pikaPerp.getShortIdent(await this.pikaPerp.getSlot(strike));
      const tokenBalance = await this.pikaPerp.balanceOf(this.alice.address, ident);
      expect(tokenBalance).to.equal(size);
      // check protocol eth balance
      const protocolBalance = await provider.getBalance(this.pikaPerp.address);
      assertAlmostEqual(protocolBalance, expectedEthPaid);
      // check insurance amount
      assertAlmostEqual(await this.pikaPerp.insurance(), parseInt(expectedGetWithoutFee.sub(expectedGet) * 0.7))
      // check referrer fee
      const commission = parseInt(expectedGetWithoutFee.sub(expectedGet) * 0.1);
      assertAlmostEqual(await this.pikaPerp.commissionOf(this.referrer.address), commission)
      // check pikaReward
      const pikaRewardAmount = await this.pikaPerp.pikaReward();
      assertAlmostEqual(pikaRewardAmount, parseInt(expectedGetWithoutFee.sub(expectedGet) * 0.2))
      // check new spot price
      const newSpot = await this.pikaPerp.getSpotPx();
      assertAlmostEqual(newSpot, 4.99900015E14) // 5e10 / ((1e7 + 1000)*(1e7 + 1000)) = 0.000499900015
      // check new mark price after poke
      provider.send("evm_increaseTime", [60])
      await this.pikaPerp.poke()
      const newMark = await this.pikaPerp.mark()
      assertAlmostEqual(newMark, BigNumber.from("499988683084846"))  // 499988683084846 = 0.998 ^ 60 * 500000000000000 + (1 - 0.998 ^ 60) * 4.99900015E15
      // check reward is transferred to rewardDistributor when the execute function is triggered after an hour
      const initialRewardDistributorBalance = await provider.getBalance(this.rewardDistributor.address);
      await provider.send("evm_increaseTime", [3600])
      await this.pikaPerp.openLong(0, strike, 0, referrer, {from: this.alice.address, value: "1000000000000000000", gasPrice: "0"}) // 1eth
      expect((await provider.getBalance(this.rewardDistributor.address)).sub(initialRewardDistributorBalance)).to.equal(pikaRewardAmount)
      // test increase position size for the same strike
      const additionalSize = "2000000000000000000000" // 2000 usd
      await this.pikaPerp.openLong(additionalSize, strike, minGet, referrer, {from: this.alice.address, value: "1000000000000000000", gasPrice: "0"}) // 1eth
      expect(await this.pikaPerp.balanceOf(this.alice.address, ident)).to.equal("3000000000000000000000");
    })

    it("should openLong violate minGet", async function () {
      // openLong
      const size = "1000000000000000000000" // 1000 usd
      const minGet = "499000000000000000" // 0.499 eth
      const strike = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", true);  // the strike for 5x long is 1667
      await expect(this.pikaPerp.openLong(size, strike, minGet, this.referrer.address, {
        from: this.alice.address,
        value: "1000000000000000000",
        gasPrice: "0"
      })).to.be.revertedWith("min get constraint violation")
    })

    it("should openLong not enough eth", async function () {
      // openLong
      const size = "1000000000000000000000" // 1000 usd
      const minGet = "300000000000000000" // 0.3 eth
      const strike = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", true);  // the strike for 5x long is 1667
      await expect(this.pikaPerp.openLong(size, strike, minGet, this.referrer.address, {
        from: this.alice.address,
        value: "1000000000000000",
        gasPrice: "0"
      })).to.be.revertedWith("UniERC20: not enough value")
    })

    it("should openLong slippage is too high", async function () {
      // openLong
      const size = "300000000000000000000000" // 300000 usd (around 6% slippage)
      const minGet = "100000000000000000000" // 100 eth
      const strike = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", true);  // the strike for 5x long is 1667
      await expect(this.pikaPerp.openLong(size, strike, minGet, this.referrer.address, {
        from: this.alice.address,
        value: "34733009708737864077", // equal spent eth
        gasPrice: "0"
      })).to.be.revertedWith("slippage is too high")
    })

    it("should closeLong", async function () {
      // openLong
      const size = "1000000000000000000000" // 1000 usd
      const minGet = "300000000000000000" // 0.3 eth
      const strike = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", true);  // the strike for 5x long is 1667
      await this.pikaPerp.openLong(size, strike, minGet, this.referrer.address, {
        from: this.alice.address,
        value: "1000000000000000000",
        gasPrice: "0"
      }) // 1eth
      const ident = await this.pikaPerp.getShortIdent(await this.pikaPerp.getSlot(strike));
      expect(await this.pikaPerp.balanceOf(this.alice.address, ident)).to.equal(size);
      expect(await this.pikaPerp.getPosition(this.alice.address, strike, true)).to.equal(size);

      // closeLong
      const initialAliceBalance = await provider.getBalance(this.alice.address);
      const initialReserve = await this.pikaPerp.reserve();
      const initialCoeff = await this.pikaPerp.coeff();
      console.log("reserve", initialReserve.toString())
      console.log("coeff", initialCoeff.toString())
      const maxPay = "600000000000000000" // 0.5 eth
      await this.pikaPerp.closeLong(size, strike, maxPay, this.referrer.address, {
        from: this.alice.address,
        gasPrice: "0"
      }) // 1eth
      // check tokens are burned
      expect(await this.pikaPerp.balanceOf(this.alice.address, ident)).to.equal(0);
      const expectedGet = BigNumber.from("600000000000000000")  // 0.6 eth = 1/1667 * 1000
      const expectedPay = BigNumber.from("501199880000000000") // 0.50119988 eth = (5e10 / (1.0001e7 - 1000) - 5e10 / (1.0001e7)) * (1 + TRADING_FEE)
      const expectedEthGet = expectedGet.sub(expectedPay)
      console.log("expect get", expectedEthGet.toString())
      const currentAliceBalance = await provider.getBalance(this.alice.address);
      console.log("sub", (currentAliceBalance.sub(initialAliceBalance)).toString())
      assertAlmostEqual(currentAliceBalance.sub(initialAliceBalance), expectedEthGet);
      // check spot price is the same as the price before the long
      expect(await this.pikaPerp.getSpotPx()).to.equal("500000000000000");
      // check if close more than the position, it will revert
      await expect(this.pikaPerp.closeLong(1, strike, maxPay, this.referrer.address, {
        from: this.alice.address,
        gasPrice: "0"
      })).to.be.revertedWith("SafeMath: subtraction overflow")
    })
  })

  it("should openShort success", async function () {
    const size = "1000000000000000000000" // 1000 usd
    const maxPay = "600000000000000000" // 0.6 eth
    const strike = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", false);  // the strike for 5x short is 2500
    const referrer = this.referrer.address
    const initialEthBalance = await provider.getBalance(this.alice.address);
    await this.pikaPerp.openShort(size, strike, maxPay, referrer, {from: this.alice.address, value: "1000000000000000000", gasPrice: "0"}) // 1eth
    // verity eth paid
    const expectedPay = BigNumber.from("501300130013460100")  // 0.5013001300134601 eth = (5e10 / (1e7 - 1000) - 5e3) * (1 + TRADING_FEE)
    const expectedGet = BigNumber.from("400000000000000000") // 0.4 eth = 1/2500 * 1000
    const expectedPayWithoutFee = BigNumber.from("500050005000957800") // 0.5000500050009578 eth = (5e10 / (1e7 - 1000) - 5e3)
    const expectedEthPaid = expectedPay.sub(expectedGet)
    const currentEthBalance = await provider.getBalance(this.alice.address)
    const ethPaid = (initialEthBalance - currentEthBalance).toString() // 0.101300130012987400 eth
    assertAlmostEqual(ethPaid, expectedEthPaid)
    // check leverage token balance
    const ident = await this.pikaPerp.getLongIdent(await this.pikaPerp.getSlot(strike));
    const tokenBalance = await this.pikaPerp.balanceOf(this.alice.address, ident);
    expect(tokenBalance).to.equal(size);
    // check protocol eth balance
    const protocolBalance = await provider.getBalance(this.pikaPerp.address);
    assertAlmostEqual(protocolBalance, expectedEthPaid);
    // check insurance amount
    assertAlmostEqual(await this.pikaPerp.insurance(), expectedPay.sub(expectedPayWithoutFee) * 0.7)
    // check referrer fee
    const commission = parseInt(expectedPay.sub(expectedPayWithoutFee) * 0.1);
    assertAlmostEqual(await this.pikaPerp.commissionOf(this.referrer.address), commission)
    // check pikaReward
    const pikaRewardAmount = await this.pikaPerp.pikaReward();
    assertAlmostEqual(pikaRewardAmount, parseInt(expectedPay.sub(expectedPayWithoutFee) * 0.2))
    // check new spot price
    const newSpot = await this.pikaPerp.getSpotPx();
    assertAlmostEqual(newSpot, 5.00100015E14) // 5e10 / ((1e7 - 1000)*(1e7 - 1000)) = 0.000500100015
    // check new mark price after poke
    provider.send("evm_increaseTime", [60])
    await this.pikaPerp.poke()
    const newMark = await this.pikaPerp.mark()
    assertAlmostEqual(newMark, BigNumber.from("500011320310737"))  // 500011320310737 = 0.998 ^ 60 * 500000000000000 + (1 - 0.998 ^ 60) * 5.00100015E14
  })

  it("should openShort violate maxPay", async function () {
    const size = "1000000000000000000000" // 1000 usd
    const maxPay = "100000000000000000" // 0.6 eth
    const strike = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", false);  // the strike for 5x short is 2500
    await expect(this.pikaPerp.openShort(size, strike, maxPay, this.referrer.address, {
      from: this.alice.address,
      value: "1000000000000000",
      gasPrice: "0"
    })).to.be.revertedWith("max pay constraint violation")
  })

  it("should openShort slippage is too high", async function () {
    // openLong
    const size = "300000000000000000000000" // 300000 usd (around 6% slippage)
    const maxPay = "200000000000000000000" // 200 eth
    const strike = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", false);  // the strike for 5x long is 1667
    await expect(this.pikaPerp.openShort(size, strike, maxPay, this.referrer.address, {
      from: this.alice.address,
      value: "200000000000000000000",
      gasPrice: "0"
    })).to.be.revertedWith("slippage is too high")
  })

  it("should closeShort", async function () {
    // openShort
    const size = "1000000000000000000000" // 1000 usd
    const maxPay = "600000000000000000" // 0.6 eth
    const strike = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", false);  // the strike for 5x long is 1667
    await this.pikaPerp.openShort(size, strike, maxPay, this.referrer.address, {
      from: this.alice.address,
      value: "1000000000000000000",
      gasPrice: "0"
    }) // 1eth
    const ident = await this.pikaPerp.getLongIdent(await this.pikaPerp.getSlot(strike));
    expect(await this.pikaPerp.balanceOf(this.alice.address, ident)).to.equal(size);
    expect(await this.pikaPerp.getPosition(this.alice.address, strike, false)).to.equal(size);

    // closeShort
    const initialAliceBalance = await provider.getBalance(this.alice.address);
    const minGet = "300000000000000000" // 0.3 eth
    await this.pikaPerp.closeShort(size, strike, minGet, this.referrer.address, {
      from: this.alice.address,
      gasPrice: "0"
    }) // 1eth
    // check tokens are burned
    expect(await this.pikaPerp.balanceOf(this.alice.address, ident)).to.equal(0);
    expect(await this.pikaPerp.getPosition(this.alice.address, strike, true)).to.equal(0);
    const expectedGet = BigNumber.from("600000000000000000")  // 0.6 eth = 1/1667 * 1000
    const expectedPay = BigNumber.from("501199880000000000") // 0.50119988 eth = (5e10 / (1.0001e7 - 1000) - 5e10 / (1.0001e7)) * (1 + TRADING_FEE)
    const expectedEthGet = expectedGet.sub(expectedPay)
    const currentAliceBalance = await provider.getBalance(this.alice.address);
    assertAlmostEqual(currentAliceBalance.sub(initialAliceBalance), expectedEthGet);
    // check spot price is the same as the price before the long
    expect(await this.pikaPerp.getSpotPx()).to.equal("500000000000000");
    // check if close more than the position, it will revert
    await expect(this.pikaPerp.closeLong(1, strike, maxPay, this.referrer.address, {
      from: this.alice.address,
      gasPrice: "0"
    })).to.be.revertedWith("SafeMath: subtraction overflow")
  })

  describe("test execute with aggregated actions", function() {
    it("should execute", async function () {
      // 1. Execute a combination of MintLong and MintShort with same size
      const size = "1000000000000000000000" // 1000 usd
      const firstLongStrike = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", true);  // the strike for 5x long is 1667
      const firstShortStrike = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", false);  // the strike for 5x short is 2500
      const firstLongAction = 2n | (BigInt(await this.pikaPerp.getSlot(firstLongStrike)) << 2n) | (BigInt(size) << 18n);
      const secondShortAction = 0n | (BigInt(await this.pikaPerp.getSlot(firstShortStrike)) << 2n) | (BigInt(size) << 18n);
      const referrer = this.referrer.address
      const firstInitialEthBalance = await provider.getBalance(this.alice.address);
      await this.pikaPerp.execute([firstLongAction, secondShortAction], "600000000000000000", "0", referrer, {from: this.alice.address, value: "1000000000000000000", gasPrice: "0"}) // 1eth
      // verity eth paid
      const firstExpectedPay = BigNumber.from("600000000000000000")  // 0.6 eth , 1/1667 * 1000
      const firstExpectedGet = BigNumber.from("400000000000000000") // 0.4 eth, 1/2500 * 1000
      const firstExpectedEthPaid = firstExpectedPay.sub(firstExpectedGet)
      const firstEthPaid = (firstInitialEthBalance - await provider.getBalance(this.alice.address)).toString()
      assertAlmostEqual(firstEthPaid, firstExpectedEthPaid)
      // check leverage token balance
      const firstLongIdent = await this.pikaPerp.getShortIdent(await this.pikaPerp.getSlot(firstLongStrike))
      const firstShortIdent = await this.pikaPerp.getLongIdent(await this.pikaPerp.getSlot(firstShortStrike));
      expect(await this.pikaPerp.balanceOf(this.alice.address, firstLongIdent)).to.equal(size);
      expect(await this.pikaPerp.balanceOf(this.alice.address, firstShortIdent)).to.equal(size);
      // check protocol eth balance
      const protocolBalance = await provider.getBalance(this.pikaPerp.address);
      assertAlmostEqual(protocolBalance, firstExpectedEthPaid);
      // check insurance amount to be 0. Since long and short amounts are equal, no trading fee is collected.
      expect(await this.pikaPerp.insurance()).to.equal(0)
      // check new spot price equals original price, since long and short amounts are equal.
      const newSpot = await this.pikaPerp.getSpotPx();
      expect(newSpot).to.equal(5E14)

      // 2. Execute a combination of MintLong and MintShort for a new strike, CloseLong and CloseShort for the previous strike
      const secondLongStrike = await this.pikaPerp.getStrikeFromLeverage("3000000000000000000", true);  // the strike for 5x long is 1500
      const secondShortStrike = await this.pikaPerp.getStrikeFromLeverage("3000000000000000000", false);  // the strike for 5x short is 3000
      console.log(secondLongStrike.toString(), secondShortStrike.toString())
      const longAction = 2n | (BigInt(await this.pikaPerp.getSlot(secondLongStrike)) << 2n) | (BigInt(size) << 18n);
      const shortAction = 0n | (BigInt(await this.pikaPerp.getSlot(secondShortStrike)) << 2n) | (BigInt(size) << 18n);
      const closeLongAction = 3n | (BigInt(await this.pikaPerp.getSlot(firstLongStrike)) << 2n) | (BigInt(size) << 18n);
      const closeShortAction = 1n | (BigInt(await this.pikaPerp.getSlot(firstShortStrike)) << 2n) | (BigInt(size) << 18n);
      const secondInitialEthBalance = await provider.getBalance(this.alice.address);
      await this.pikaPerp.execute([longAction, shortAction, closeLongAction, closeShortAction], "1500000000000000000", "0", referrer, {from: this.alice.address, value: "1000000000000000000", gasPrice: "0"}) // 1eth
      // check leverage token balance
      // verity eth paid
      const secondExpectedPay = BigNumber.from("1066000000000000000")  // 1.066eth , 1/2500 * 1000 + 1/1500 * 1000
      const secondExpectedGet = BigNumber.from("933000000000000000") // 0.933 eth, 1/1667 * 1000 + 1/3000 * 1000
      const secondExpectedEthPaid = secondExpectedPay.sub(secondExpectedGet)
      const secondEthPaid = (secondInitialEthBalance - await provider.getBalance(this.alice.address)).toString()
      assertAlmostEqual(secondEthPaid, secondExpectedEthPaid, 1000)
      // verify positions
      const secondLongIdent = await this.pikaPerp.getShortIdent(await this.pikaPerp.getSlot(secondLongStrike))
      const secondShortIdent = await this.pikaPerp.getLongIdent(await this.pikaPerp.getSlot(secondShortStrike));
      expect(await this.pikaPerp.balanceOf(this.alice.address, secondLongIdent)).to.equal(size);
      expect(await this.pikaPerp.balanceOf(this.alice.address, secondShortIdent)).to.equal(size);
      expect(await this.pikaPerp.balanceOf(this.alice.address, firstLongIdent)).to.equal(0);
      expect(await this.pikaPerp.balanceOf(this.alice.address, firstShortIdent)).to.equal(0);
      // check protocol eth balance
      assertAlmostEqual(await provider.getBalance(this.pikaPerp.address), secondExpectedEthPaid.add(firstExpectedEthPaid));
      // check insurance amount to be 0. Since long and short amounts are equal, no trading fee is collected.
      expect(await this.pikaPerp.insurance()).to.equal(0)
      // check new spot price equals original price, since long and short amounts are equal.
      expect(await this.pikaPerp.getSpotPx()).to.equal(5E14)
    })
  })

  describe("test liquidation success", function () {
    it("should openLong liquidation", async function () {
      // openLong
      const longSize = "1000000000000000000000" // 1000 usd
      const minGet = "300000000000000000" // 0.3 eth
      const longStrike = parseInt(await this.pikaPerp.getStrikeFromLeverage("13000000000000000000", true));  // the strike for 13x long is 1857. Max leverage is 0.93/0.07 = 13.28
      const liquidationPrice = parseInt(longStrike * SAFE_THRESHOLD) // 1/1997 = "500769230769230"
      await this.pikaPerp.openLong(longSize, longStrike, minGet, this.referrer.address, {
        from: this.alice.address,
        value: "1000000000000000000",
        gasPrice: "0"
      }) // 1eth
      const slot = parseInt(await this.pikaPerp.getSlot(longStrike));
      const ident = await this.pikaPerp.getShortIdent(slot);
      expect(await this.pikaPerp.balanceOf(this.alice.address, ident)).to.equal(longSize);
      console.log("mark1", (await this.pikaPerp.mark()).toString())
      // test the long position has been liquidated
      const shortSize = "10000000000000000000000" // 10000 usd
      const maxPay = "6000000000000000000" // 6 eth
      const shortStrike = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", false);  // the strike for 5x short is 2500
      await this.pikaPerp.openShort(shortSize, shortStrike, maxPay, this.referrer.address, {
        from: this.alice.address,
        value: "10000000000000000000",
        gasPrice: "0"
      }) // 10eth
      await provider.send("evm_increaseTime", [3600])
      await this.pikaPerp.poke()
      const newIdent = await this.pikaPerp.getShortIdent(slot);  // Get new ident for the slot. The old ident has been invalidated by increasing shortOffsetOf(slot)
      const expectedNewIdent = ident | (1 << 16)
      expect(await this.pikaPerp.mark()).to.be.gt(liquidationPrice);
      expect(newIdent).to.be.equal(expectedNewIdent);
      expect(await this.pikaPerp.shortOffsetOf(slot)).to.equal(1)
      expect(await this.pikaPerp.balanceOf(this.alice.address, newIdent)).to.equal(0);
      expect(await this.pikaPerp.balanceOf(this.alice.address, ident)).to.equal(longSize);
      expect(await this.pikaPerp.getPosition(this.alice.address, longStrike, true)).to.equal(0);
    })
    // test the protocol's limit on liquidation per second.
    it("should openLong liquidation exceeds liquidation limit", async function () {
      // openLong
      const longSize = "1000000000000000000000" // 1000 usd
      const minGet = "300000000000000000" // 0.3 eth
      const longStrike = parseInt(await this.pikaPerp.getStrikeFromLeverage("13000000000000000000", true));  // the strike for 13x long is 1857. Max leverage is 0.93/0.07 = 13.28
      const liquidationPrice = parseInt(longStrike * SAFE_THRESHOLD) // 1/1997 = "500769230769230"
      const liquidationPerSecond = "100000000000000000"
      // Set liquidationPerSecond to a very small number
      this.pikaPerp.setLiquidationPerSec(liquidationPerSecond); // 0.1 usd per second
      await this.pikaPerp.openLong(longSize, longStrike, minGet, this.referrer.address, {
        from: this.alice.address,
        value: "1000000000000000000",
        gasPrice: "0"
      }) // 1eth
      const slot = parseInt(await this.pikaPerp.getSlot(longStrike));
      const ident = await this.pikaPerp.getShortIdent(slot);
      expect(await this.pikaPerp.balanceOf(this.alice.address, ident)).to.equal(longSize);
      console.log("mark1", (await this.pikaPerp.mark()).toString())
      // test the long position has been liquidated
      const shortSize = "10000000000000000000000" // 10000 usd
      const maxPay = "6000000000000000000" // 6 eth
      const shortStrike = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", false);  // the strike for 5x short is 2500
      await this.pikaPerp.openShort(shortSize, shortStrike, maxPay, this.referrer.address, {
        from: this.alice.address,
        value: "10000000000000000000",
        gasPrice: "0"
      }) // 10eth
      await provider.send("evm_increaseTime", [3600])
      await this.pikaPerp.poke()
      const newIdent = await this.pikaPerp.getShortIdent(slot);  // Get new ident for the slot. The old ident has been invalidated by increasing shortOffsetOf(slot)
      const expectedNewIdent = ident | (1 << 16)
      expect(await this.pikaPerp.mark()).to.be.gt(liquidationPrice);
      expect(newIdent).to.be.equal(expectedNewIdent);
      expect(await this.pikaPerp.shortOffsetOf(slot)).to.equal(1)
      expect(await this.pikaPerp.balanceOf(this.alice.address, newIdent)).to.equal(0);
      expect(await this.pikaPerp.balanceOf(this.alice.address, ident)).to.equal(longSize);
      expect(await this.pikaPerp.getPosition(this.alice.address, longStrike, true)).to.equal(0);
      // user's position gets fully liquidated, but the protocol gradually close the liquidation limited by the liquidationPerSecond
      // when user's 1000 usd position is liquidated, the protocol has -1000 debt. Because the liquidationPerSecond is 0.1 usd per second,
      // after 1 hour, the protocol can liquidate 360 usd(0.1 * 3600). Therefore, the current debt is -640 usd(360 - 1000)
      expect(parseInt(await this.pikaPerp.burden())).to.equal(parseInt(liquidationPerSecond) * 3600 - longSize);
    })

    it("should openShort liquidation success", async function () {
      // openShort
      const shortSize = "1000000000000000000000" // 1000 usd
      const maxPay = "600000000000000000" // 0.6 eth
      const shortStrike = await this.pikaPerp.getStrikeFromLeverage("13000000000000000000", false);  // the strike for 13x short is 2167
      const liquidationPrice = parseInt(shortStrike / SAFE_THRESHOLD) // 1/2015 = "496277915632754"
      await this.pikaPerp.openShort(shortSize, shortStrike, maxPay, this.referrer.address, {
        from: this.alice.address,
        value: "1000000000000000000",
        gasPrice: "0"
      }) // 1eth
      const slot = parseInt(await this.pikaPerp.getSlot(shortStrike));
      const ident = await this.pikaPerp.getLongIdent(slot);
      expect(await this.pikaPerp.balanceOf(this.alice.address, ident)).to.equal(shortSize);
      expect(await this.pikaPerp.getPosition(this.alice.address, shortStrike, false)).to.equal(shortSize);
      // test the short position is liquidated when the price goes up
      const longSize = "100000000000000000000000" // 100000 usd
      const minGet = "30000000000000000000" // 30 eth
      const longStrike = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", true);  // the strike for 5x short is 2500
      await this.pikaPerp.openLong(longSize, longStrike, minGet, this.referrer.address, {
        from: this.alice.address,
        value: "100000000000000000000",
        gasPrice: "0"
      }) // 100eth
      await provider.send("evm_increaseTime", [3600])
      await this.pikaPerp.poke()
      const newIdent = await this.pikaPerp.getLongIdent(slot);  // Get new ident for the slot. The old ident has been invalidated by increasing shortOffsetOf(slot)
      expect(liquidationPrice).to.be.gt(await this.pikaPerp.mark());
      expect(await this.pikaPerp.longOffsetOf(slot)).to.equal(1)
      expect(await this.pikaPerp.balanceOf(this.alice.address, newIdent)).to.equal(0);
      expect(await this.pikaPerp.balanceOf(this.alice.address, ident)).to.equal(shortSize);
      expect(await this.pikaPerp.getPosition(this.alice.address, shortStrike, true)).to.equal(0);
    })

    it("should openShort liquidation exceeds liquidation limit", async function () {
      // openShort
      const shortSize = "1000000000000000000000" // 1000 usd
      const maxPay = "600000000000000000" // 0.6 eth
      const shortStrike = await this.pikaPerp.getStrikeFromLeverage("13000000000000000000", false);  // the strike for 13x short is 2167
      const liquidationPrice = parseInt(shortStrike / SAFE_THRESHOLD) // 1/2015 = "496277915632754"
      const liquidationPerSecond = "100000000000000000"
      // Set liquidationPerSecond to a very small number
      this.pikaPerp.setLiquidationPerSec(liquidationPerSecond); // 0.1 usd per second
      await this.pikaPerp.openShort(shortSize, shortStrike, maxPay, this.referrer.address, {
        from: this.alice.address,
        value: "1000000000000000000",
        gasPrice: "0"
      }) // 1eth
      const slot = parseInt(await this.pikaPerp.getSlot(shortStrike));
      const ident = await this.pikaPerp.getLongIdent(slot);
      expect(await this.pikaPerp.balanceOf(this.alice.address, ident)).to.equal(shortSize);
      expect(await this.pikaPerp.getPosition(this.alice.address, shortStrike, false)).to.equal(shortSize);
      // test the short position is liquidated when the price goes up
      const longSize = "100000000000000000000000" // 100000 usd
      const minGet = "30000000000000000000" // 30 eth
      const longStrike = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", true);  // the strike for 5x short is 2500
      await this.pikaPerp.openLong(longSize, longStrike, minGet, this.referrer.address, {
        from: this.alice.address,
        value: "100000000000000000000",
        gasPrice: "0"
      }) // 100eth
      await provider.send("evm_increaseTime", [3600])
      await this.pikaPerp.poke()
      const newIdent = await this.pikaPerp.getLongIdent(slot);  // Get new ident for the slot. The old ident has been invalidated by increasing shortOffsetOf(slot)
      expect(liquidationPrice).to.be.gt(await this.pikaPerp.mark());
      expect(await this.pikaPerp.longOffsetOf(slot)).to.equal(1)
      expect(await this.pikaPerp.balanceOf(this.alice.address, newIdent)).to.equal(0);
      expect(await this.pikaPerp.balanceOf(this.alice.address, ident)).to.equal(shortSize);
      expect(await this.pikaPerp.getPosition(this.alice.address, shortStrike, true)).to.equal(0);
      // user's position gets fully liquidated, but the protocol gradually close the liquidation limited by the liquidationPerSecond
      // when user's 1000 usd position is liquidated, the protocol has 1000 debt. Because the liquidationPerSecond is 0.1 usd per second,
      // after 1 hour, the protocol can liquidate 360 usd(0.1 * 3600). Therefore, the current debt is 640 usd(1000 - 360)
      expect(parseInt(await this.pikaPerp.burden())).to.equal(shortSize - parseInt(liquidationPerSecond) * 3600 );
    })
  })

  describe("trade functions with price shift", function () {
    it("should openLong success with positive shift", async function () {
      const size = "1000000000000000000000" // 1000 usd
      const minGet = "300000000000000000" // 0.3 eth
      const strike = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", true);  // the strike for 5x long is 1667
      const referrer = this.referrer.address
      // set oracle price to 1/1667, which is more than 2.5% from 1/2000
      await this.oracle.setPrice(600000000000000);
      const initialEthBalance = await provider.getBalance(this.alice.address);
      const maxShiftChangePerSecond = await this.pikaPerp.maxShiftChangePerSecond();
      const lastPoke = await this.pikaPerp.lastPoke();
      const mark = await this.pikaPerp.mark();
      await provider.send("evm_increaseTime", [3600])
      await this.pikaPerp.openLong(size, strike, minGet, referrer, {
        from: this.alice.address,
        value: "1000000000000000000",
        gasPrice: "0"
      }) // 1eth
      // verity eth paid
      const timeElapsed = (await this.pikaPerp.lastPoke()).sub(lastPoke)
      const shift = await this.pikaPerp.shift()
      const expectedShift = timeElapsed.mul(maxShiftChangePerSecond).mul(mark).div("1000000000000000000")
      assertAlmostEqual(shift, expectedShift, 1000)
      const expectedPay = BigNumber.from("600000000000000000")  // 0.6 eth = 1/1667 * 1000
      const expectedGet = BigNumber.from("498907942500000000") // 0.4989079425 eth = (5e3 - 5e10 / (1e7 + 1000) + (shift * 1000)) * (1 - TRADING_FEE)
      const expectedGetWithoutFee = BigNumber.from("500158338300000000") // 0.5001583383 eth = (5e3 - 5e10 / (1e7 + 1000) + (shift * 1000))
      const expectedEthPaid = expectedPay.sub(expectedGet)
      const currentEthBalance = await provider.getBalance(this.alice.address)
      const ethPaid = (initialEthBalance.sub(currentEthBalance)).toString()
      assertAlmostEqual(ethPaid, expectedEthPaid)
      // check new spot price
      const newSpot = await this.pikaPerp.getSpotPx();
      assertAlmostEqual(newSpot, 5.001083483E14) // 5e10 / ((1e7 + 1000)*(1e7 + 1000)) + shift = 0.0005001083483
    })

    it("should openLong success with negative shift", async function () {
      const size = "1000000000000000000000" // 1000 usd
      const minGet = "300000000000000000" // 0.3 eth
      const strike = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", true);  // the strike for 5x long is 1667
      const referrer = this.referrer.address
      // set oracle price to 1/2500, which is less than 2.5% from 1/2000
      await this.oracle.setPrice(400000000000000);
      const initialEthBalance = await provider.getBalance(this.alice.address);
      const maxShiftChangePerSecond = await this.pikaPerp.maxShiftChangePerSecond();
      const lastPoke = await this.pikaPerp.lastPoke();
      const mark = await this.pikaPerp.mark();
      await provider.send("evm_increaseTime", [3600])
      await this.pikaPerp.openLong(size, strike, minGet, referrer, {
        from: this.alice.address,
        value: "1000000000000000000",
        gasPrice: "0"
      }) // 1eth
      // verity eth paid
      const timeElapsed = (await this.pikaPerp.lastPoke()).sub(lastPoke)
      const shift = await this.pikaPerp.shift()
      const expectedShift = timeElapsed.mul(maxShiftChangePerSecond).mul(mark).mul(-1).div("1000000000000000000")
      console.log(shift.toString(), expectedShift.toString())
      assertAlmostEqual(expectedShift, shift, 1000)
      const expectedPay = BigNumber.from("600000000000000000")  // 0.6 eth = 1/1667 * 1000
      const expectedGet = BigNumber.from("498492317500000000") // 0.4984923175 eth = (5e3 - 5e10 / (1e7 + 1000) + (shift * 1000)) * (1 - TRADING_FEE)
      const expectedGetWithoutFee = BigNumber.from("499741671700000000") // 0.4997416717 eth = (5e3 - 5e10 / (1e7 + 1000) + (shift * 1000))
      const expectedEthPaid = expectedPay.sub(expectedGet)
      const currentEthBalance = await provider.getBalance(this.alice.address)
      const ethPaid = (initialEthBalance.sub(currentEthBalance)).toString()
      assertAlmostEqual(ethPaid, expectedEthPaid)
      // check new spot price
      const newSpot = await this.pikaPerp.getSpotPx()
      assertAlmostEqual(newSpot, 4.996916817E14) // 5e10 / ((1e7 + 1000)*(1e7 + 1000)) + shift = 0.0004996916817
    })

    it("should openShort success with positive shift", async function () {
      const size = "1000000000000000000000" // 1000 usd
      const maxPay = "600000000000000000" // 0.6 eth
      const strike = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", false);  // the strike for 5x short is 2500
      const referrer = this.referrer.address
      // set oracle price to 1/1667, which is more than 2.5% from the 1/2000
      await this.oracle.setPrice(600000000000000);
      const initialEthBalance = await provider.getBalance(this.alice.address);
      const maxShiftChangePerSecond = await this.pikaPerp.maxShiftChangePerSecond();
      const lastPoke = await this.pikaPerp.lastPoke();
      const mark = await this.pikaPerp.mark();
      await provider.send("evm_increaseTime", [3600])
      await this.pikaPerp.openShort(size, strike, maxPay, referrer, {
        from: this.alice.address,
        value: "1000000000000000000",
        gasPrice: "0"
      }) // 1eth
      // verity eth paid
      const timeElapsed = (await this.pikaPerp.lastPoke()).sub(lastPoke)
      const shift = await this.pikaPerp.shift()
      const expectedShift = timeElapsed.mul(maxShiftChangePerSecond).mul(mark).div("1000000000000000000")
      assertAlmostEqual(shift, expectedShift, 1000)
      const expectedGet = BigNumber.from("400000000000000000")  // 0.4 eth = 1/2500 * 1000
      const expectedPay = BigNumber.from("501508984200000000") // 0.5015089842 eth = ((5e10 / (1e7 - 1000) - 5e3) + shift * 1000) * (1 + TRADING_FEE)
      const expectedPayWithoutFee = BigNumber.from("500258338300000000") // 0.5002583383 eth = (5e10 / (1e7 - 1000) - 5e3) + shift * 1000
      const expectedEthPaid = expectedPay.sub(expectedGet)
      const currentEthBalance = await provider.getBalance(this.alice.address)
      const ethPaid = initialEthBalance.sub(currentEthBalance)
      assertAlmostEqual(ethPaid, expectedEthPaid)
      // check new spot price
      const newSpot = await this.pikaPerp.getSpotPx();
      assertAlmostEqual(newSpot, 5.003083483E14) // 5e10 / ((1e7 - 1000)*(1e7 - 1000)) + shift = 0.0005003083483
    })

    it("should openShort success with negative shift", async function () {
      const size = "1000000000000000000000" // 1000 usd
      const maxPay = "600000000000000000" // 0.6 eth
      const strike = await this.pikaPerp.getStrikeFromLeverage("5000000000000000000", false);  // the strike for 5x short is 2500
      const referrer = this.referrer.address
      // set oracle price to 1/2500, which is less than 2.5% from 1/2000
      await this.oracle.setPrice(400000000000000);
      const initialEthBalance = await provider.getBalance(this.alice.address);
      const maxShiftChangePerSecond = await this.pikaPerp.maxShiftChangePerSecond();
      const lastPoke = await this.pikaPerp.lastPoke();
      const mark = await this.pikaPerp.mark();
      await provider.send("evm_increaseTime", [3600])
      await this.pikaPerp.openShort(size, strike, maxPay, referrer, {
        from: this.alice.address,
        value: "1000000000000000000",
        gasPrice: "0"
      }) // 1eth
      // verity eth paid
      const timeElapsed = (await this.pikaPerp.lastPoke()).sub(lastPoke)
      const shift = await this.pikaPerp.shift()
      const expectedShift = timeElapsed.mul(maxShiftChangePerSecond).mul(mark).mul(-1).div("1000000000000000000")
      assertAlmostEqual(shift, expectedShift, 1000)
      const expectedGet = BigNumber.from("400000000000000000")  // 0.4 eth = 1/2500 * 1000
      const expectedPay = BigNumber.from("501091275800000000") // 0.5010912758 eth = ((5e10 / (1e7 - 1000) - 5e3) + shift * 1000) * (1 + TRADING_FEE)
      const expectedPayWithoutFee = BigNumber.from("499841671700000000") // 0.4998416717 eth = (5e10 / (1e7 - 1000) - 5e3) + shift * 1000
      const expectedEthPaid = expectedPay.sub(expectedGet)
      const currentEthBalance = await provider.getBalance(this.alice.address)
      const ethPaid = initialEthBalance.sub(currentEthBalance)
      assertAlmostEqual(ethPaid, expectedEthPaid)
      // check new spot price
      const newSpot = await this.pikaPerp.getSpotPx();
      assertAlmostEqual(newSpot, 4.998916817E14) // 5e10 / ((1e7 - 1000)*(1e7 - 1000)) + shift = 0.0004998916817
    })
  })

  describe("test mint and burn PIKA", function () {
    it("should openShort with 1x leverage mint PIKA", async function () {
      // 1. test mint PIKA
      const size = "1000000000000000000000" // 1000 usd
      const maxPay = "600000000000000000" // 0.6 eth
      const strike = await this.pikaPerp.getStrikeFromLeverage("1000000000000000000", false);  // the strike for 1x short is 0
      const initialEthBalance = await provider.getBalance(this.alice.address);
      await this.pikaPerp.openShort(size, strike, maxPay, this.referrer.address, {from: this.alice.address, value: "1000000000000000000", gasPrice: "0"}) // 1eth
      // verity eth paid
      const expectedPay = BigNumber.from("501300130013460100")  // 0.5013001300134601 eth = (5e10 / (1e7 - 1000) - 5e3) * (1 + TRADING_FEE)
      const expectedGet = BigNumber.from("0") // 0.4 eth = 0 * 1000
      const expectedEthPaid = expectedPay.sub(expectedGet)
      const currentEthBalance = await provider.getBalance(this.alice.address)
      const ethPaid = (initialEthBalance - currentEthBalance).toString() // 0.101300130012987400 eth
      assertAlmostEqual(ethPaid, expectedEthPaid)
      // check leverage token balance
      const ident = await this.pikaPerp.getLongIdent(await this.pikaPerp.getSlot(strike));
      const leverageTokenBalance = await this.pikaPerp.balanceOf(this.alice.address, ident);
      // verify no leveraged token is minted
      expect(leverageTokenBalance).to.equal(0);
      const pikaBalance = await this.pika.balanceOf(this.alice.address);
      expect(pikaBalance).to.equal(size)

      // 2. test burn pika
      const minGet = "300000000000000000" // 0.3 eth
      await this.pikaPerp.closeShort(size, strike, minGet, this.referrer.address, {from: this.alice.address}) // 1eth
      expect(await this.pika.balanceOf(this.alice.address)).to.equal(0)
    })
  })


  // describe("call setter and getter method", async function () {
  //
  //   it("should set setPendingGovernor method", async function () {
  //     await this.pikaPerp.setPendingGovernor(this.bob.address)
  //     const pendingGovernor = await this.pikaPerp.pendingGovernor()
  //     expect(pendingGovernor).to.equal(this.bob.address)
  //   })
  //
  //   it("should fail if sender is not governor ", async function () {
  //     await expect(this.pikaPerp.connect(this.bob).setSpotMarkThreshold("100", { from: this.bob.address })).to.be.revertedWith("Only governor can call this function.")
  //   })
  //
  //   it("should set value setSpotMarkThreshold method", async function () {
  //     const newSpotSpotMarkThreshold = '100000000'
  //     await this.pikaPerp.setSpotMarkThreshold(newSpotSpotMarkThreshold)
  //     const spotMarkThreshold = await this.pikaPerp.spotMarkThreshold()
  //     expect(spotMarkThreshold).to.equal(newSpotSpotMarkThreshold)
  //   })
  //
  //
  //   it("should set value setLiquidationPerSec method", async function () {
  //     const nextLiquidationPerSec = "10000000000000000"
  //     await this.pikaPerp.setLiquidationPerSec(nextLiquidationPerSec)
  //     const liquidationPerSec = await this.pikaPerp.liquidationPerSec()
  //     expect(liquidationPerSec).to.equal(nextLiquidationPerSec)
  //   })
  //
  //   it("should set value setTradingFee method", async function () {
  //     const newTradingFee = "1000000"
  //     await this.pikaPerp.setTradingFee(newTradingFee)
  //     const tradingFee = await this.pikaPerp.tradingFee()
  //     expect(tradingFee).to.equal(newTradingFee)
  //   })
  //
  //
  //   it("should set value setFundingAdjustThreshold  and get fundingAdjustThreshold method", async function () {
  //     const newFundingAdjustThreshold = "10000000000"
  //     await this.pikaPerp.setFundingAdjustThreshold(newFundingAdjustThreshold)
  //     const fundingAdjustThreshold = await this.pikaPerp.fundingAdjustThreshold()
  //     expect(fundingAdjustThreshold).to.equal(newFundingAdjustThreshold)
  //   })
  //
  //   it("should set value setSafeThreshold and get safeThreshold method ", async function () {
  //     const newSafethreshold = "1000000000000"
  //     await this.pikaPerp.setSafeThreshold(newSafethreshold)
  //     const safethreshold = await this.pikaPerp.safeThreshold()
  //     expect(safethreshold).to.be.equal(newSafethreshold)
  //   })
  //
  //   it("should set value  setDecayPerSecond and get decayPerSecond  method", async function () {
  //     const newDecay = '10000000000'
  //     await this.pikaPerp.setDecayPerSecond(newDecay)
  //     const decayPerSecond = await this.pikaPerp.decayPerSecond()
  //     expect(decayPerSecond).to.equal(newDecay)
  //   })
  //
  //   it("should set value setMaxShiftChangePerSecond and get maxShiftChangePerSecond method", async function () {
  //     const newMaxShiftChangePerSecond = 100000000
  //     await this.pikaPerp.setMaxShiftChangePerSecond(newMaxShiftChangePerSecond)
  //     const maxShiftChangePerSecond = await this.pikaPerp.maxShiftChangePerSecond()
  //     expect(maxShiftChangePerSecond).to.equal(newMaxShiftChangePerSecond)
  //   })
  //
  //
  //   it("should set value setMaxPokeElapsed and get maxPokeElapsed method", async function () {
  //     const newMaxPokeElapsed = '100000000'
  //     await this.pikaPerp.setMaxPokeElapsed(newMaxPokeElapsed)
  //     const maxPokeElapsed = await this.pikaPerp.maxPokeElapsed()
  //     expect(maxPokeElapsed).to.equal(newMaxPokeElapsed)
  //   })
  //
  //   it("should set value for setLiquidity method", async function () {
  //     const newNextCoeff = "100000000000"
  //     const newNextReserve0 = '1000000000000'
  //     await this.pikaPerp.setLiquidity(newNextCoeff, newNextReserve0)
  //     const nextCoeff = await this.pikaPerp.coeff()
  //     const nextReserve0 = await this.pikaPerp.reserve0()
  //     expect(nextCoeff).to.equal(newNextCoeff)
  //     expect(nextReserve0).to.equal(newNextReserve0)
  //   })
  // })
})
