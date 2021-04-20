// import { ethers } from "hardhat";
// import { expect } from "chai";
const { expect, should } = require("chai");
const hre = require("hardhat");
const { waffle } = require("hardhat");
const { BigNumber, ethers, utils } = require("ethers");

const provider = waffle.provider;
// const provider = ethers.getDefaultProvider()
const TRADING_FEE = 0.0025 // 0.25% of notional value.
const MintLong = 0;
const BurnLong = 1;
const MintShort = 2;
const BurnShort = 3;
const DECAY_PER_SECOND = 0.998

// Assert that actual is less than 0.00001% difference from expected
function assertAlmostEqual(expected, actual) {
  const expectedBN = BigNumber.isBigNumber(expected) ? expected : BigNumber.from(expected);
  const actualBN = BigNumber.isBigNumber(actual) ? actual : BigNumber.from(actual);
  const diffBN = expectedBN.gt(actualBN) ? expectedBN.sub(actualBN) : actualBN.sub(expectedBN);
  return expect(
      diffBN).to.lt(expectedBN.div(BigNumber.from('100000'))
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
      assertAlmostEqual(ethPaid, expectedEthPaid)
      // check leverage token balance
      const ident = await this.pikaPerp.getShortIdent(getSlot(strike));
      const tokenBalance = await this.pikaPerp.balanceOf(this.alice.address, ident.toString());
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
      assertAlmostEqual(newSpot, 4.99900015E14) // 1e7 * 5e4 / ((1e7 + 1000)*(1e7 + 1000)) = 0.00499900015
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
      })).to.revertedWith("slippage is too high")
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
      const ident = await this.pikaPerp.getShortIdent(getSlot(strike));
      expect(await this.pikaPerp.balanceOf(this.alice.address, ident.toString())).to.equal(size);

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
      expect(await this.pikaPerp.balanceOf(this.alice.address, ident.toString())).to.equal(0);
      const expectedGet = BigNumber.from("600000000000000000")  // 0.6 eth = 1/1667 * 1000
      const expectedPay = BigNumber.from("501199880000000000") // 0.50119988 eth = (5e10 / (1.0001e7 - 1000) - 5e10 / (1.0001e7)) * (1 + TRADING_FEE)
      const expectedEthGet = expectedGet.sub(expectedPay)
      console.log("expect get", expectedEthGet.toString())
      const currentAliceBalance = await provider.getBalance(this.alice.address);
      assertAlmostEqual(expectedEthGet, currentAliceBalance.sub(initialAliceBalance));
      // check spot price is the same as the price before the long
      expect(await this.pikaPerp.getSpotPx()).to.equal("500000000000000");
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
