// import { ethers } from "hardhat";
// import { expect } from "chai";
const { expect, should } = require("chai");
const hre = require("hardhat");

describe("PikaPerp deploy", function () {

  before(async function () {

    this.signers = await ethers.getSigners()
    this.alice = this.signers[0]
    this.bob = this.signers[1]
    this.carol = this.signers[2]
    this.dev = this.signers[3]
    this.minter = this.signers[4]
    this.rewardDistributor = this.signers[5]

    this.token = this.signers[6]

    this.pikaPerp = await hre.ethers.getContractFactory("PikaPerp");
    this.tokenERC = await hre.ethers.getContractFactory("SimpleERC20");
    this.linkoracle = await hre.ethers.getContractFactory("SimpleOracle");
    this.pikacontract = await hre.ethers.getContractFactory("Pika")


  })

  beforeEach(async function () {
    this.PikaPerp = await this.pikaPerp.deploy();
    this.token = await this.tokenERC.deploy()
    this.oracle = await this.linkoracle.deploy()
    this.pika = await this.pikacontract.deploy(42)
    // this.token = await hre.ethers.constants.AddressZero
    this.uri = "http://github.com/"
    this.coeff = "104000000000000000000000000000000000000000000000"
    this.reserve = "10000000000000000000000"
    this.liquidationPerSec = "1000000000000000000"
    await this.PikaPerp.initialize(
      this.uri, this.pika.address, this.token, this.oracle.address, this.coeff, this.reserve, this.liquidationPerSec, this.rewardDistributor
    )
  })

  it("should call balanceof method", async function () {
    console.log(this.alice.address)
    const balance = await this.pikaPerp.balanceOf(this.alice.address, 0)
    expect(balance)
  })


  describe("call all initialize method", async function(){
    it("should call burden method", async function () {
      const burdenvalue = await this.pikaPerp.burden()
      expect(burdenvalue).to.equal("0")
    })

    it("should have MintShort and expect 1", async function () {
      const MintShort = await this.pikaPerp.MintShort()
      expect(MintShort).to.be.equal("2");
    })

    it("should have MintLong and", async function () {
      const MintLong = await this.pikaPerp.MintLong()
      expect(MintLong).to.be.equal("0");
    })

    it("should have minSafeShortSlot method", async function(){
      const slot = await this.pikaPerp.minSafeShortSlot()
      expect(slot).to.be.equal("18012");
    })


    it("should have burnlong and expect 1", async function () {
      const burnlong = await this.pikaPerp.BurnLong()
      expect(burnlong).to.be.equal("1");
    })

    it("should get value insurance method", async function () {
      const insurance = await this.pikaPerp.insurance()
      expect(insurance).to.equal('0')
    })

  it("should call poke method", async function () {
    const pokefunction = await this.pikaPerp.poke()
    expect(pokefunction)
  })


    it("should call short method", async function () {
      const short = await this.pikaPerp.BurnShort()
      expect(short).to.be.equal("3");
    })

    it("should call coeff method", async function () {
      const coeffvalue = await this.pikaPerp.coeff()
      expect(coeffvalue).to.equal("104000000000000000000000000000000000000000000000")
    })
    it("should call  commissionOf method", async function () {
      const commissionOf = await this.pikaPerp.commissionOf(this.dev.address)
      expect(commissionOf).to.equal("0")
    })

    it("should call decayPerSecond method", async function () {
      const perSecond = await this.pikaPerp.decayPerSecond()
      expect(perSecond).to.equal("998000000000000000")
    })

    it("should call getLatestMark method", async function () {
      const LatestMark = await this.pikaPerp.getLatestMark()
      expect(LatestMark).to.equal("1040000000000000000000")
    })

    it("should call reserve method", async function(){
      const reserve = await this.pikaPerp.reserve()
      expect(reserve).to.equal('10000000000000000000000')
    })

    it("should call maxSafeLongSlot method", async function(){
      const safeslot = await this.pikaPerp.maxSafeLongSlot()
      expect(safeslot).to.equal('17967')
    })


    it("should set value getLeverageFromStrike method", async function () {
      const strike = 100
      const getstrike = await this.pikaPerp.getLeverageFromStrike(strike)
      expect(getstrike).to.equal(strike)
    })

  })


  describe("call setter and getter method", async function () {

    it("should set setPendingGovernor method", async function () {
      const setGovernor = await this.pikaPerp.setPendingGovernor(this.bob.address)
      expect(setGovernor)
    })

    it("if sender is not governor ", async function () {
      await expect(this.pikaPerp.connect(this.bob).setSpotMarkThreshold("100", { from: this.bob.address })).to.be.revertedWith("Only governor can call this function.")
    })

    it("should set value setSpotMarkThreshold method", async function () {
      const newspot = '100000000'
      const spotMark = await this.pikaPerp.setSpotMarkThreshold(newspot)
      const spotMarkThreshold = await this.pikaPerp.spotMarkThreshold()
      expect(spotMarkThreshold).to.equal(newspot)
    })


    it("should set value setLiquidationPerSec method", async function () {
      const nextliquidation = "10000000000000000"
      const liquidation = await this.pikaPerp.setLiquidationPerSec(nextliquidation)
      const liquidationPerSec = await this.pikaPerp.liquidationPerSec()
      expect(liquidationPerSec).to.equal(nextliquidation)
    })

    it("should set value setTradingFee method", async function () {
      const TradingFee = "1000000"
      const fee = await this.pikaPerp.setTradingFee(TradingFee)
      const tradingFee = await this.pikaPerp.tradingFee()
      expect(tradingFee).to.equal(TradingFee)
    })


    it("should set value setFundingAdjustThreshold  and get fundingAdjustThreshold method", async function () {
      const setfunding = "10000000000"
      const funding = await this.pikaPerp.setFundingAdjustThreshold(setfunding)
      const fundingAdjustThreshold = await this.perpETH.fundingAdjustThreshold()
      expect(fundingAdjustThreshold).to.equal(setfunding)
    })

    it("should set value setSafeThreshold and get safeThreshold method ", async function () {
      const newsafethreshold = "1000000000000"
      const Threshold = await this.pikaPerp.setSafeThreshold(newsafethreshold)
      const safe = await this.pikaPerp.safeThreshold()
      expect(safe).to.be.equal(newsafethreshold)
    })

    it("should set value  setDecayPerSecond and get decayPerSecond  method", async function () {
      const newdecay = '10000000000'
      const PerSecond = await this.pikaPerp.setDecayPerSecond(newdecay)
      const decayPerSecond = await this.pikaPerp.decayPerSecond()
      expect(decayPerSecond).to.equal(newdecay)
    })

    it("should set value setMaxShiftChangePerSecond and get maxShiftChangePerSecond method", async function () {
      const maxshift = 100000000
      const maxpersecond = await this.pikaPerp.setMaxShiftChangePerSecond(maxshift)
      const maxShiftChangePerSecond = await this.pikaPerp.maxShiftChangePerSecond()
      expect(maxShiftChangePerSecond).to.equal(maxshift)
    })


    it("should set value setMaxPokeElapsed and get maxPokeElapsed method", async function () {
      const maxpoke = '100000000'
      const setnewvalue = await this.pikaPerp.setMaxPokeElapsed(maxpoke)
      const maxPokeElapsed = await this.pikaPerp.maxPokeElapsed()
      expect(maxPokeElapsed).to.equal(maxpoke)
    })

  })


  describe("this describe call for set value method ", async function () {

    it("should set value for setLiquidity method", async function () {
      const nextCoeff = "100000000000"
      const nextReserve0 = '1000000000000'
      const Liquidity = await this.pikaPerp.setLiquidity(nextCoeff, nextReserve0)
      expect(Liquidity)
    })

    it("should get value getSpotPx method", async function () {
      const getpx = await this.pikaPerp.getSpotPx()
      expect(getpx)
    })
  })


  describe("call openlong closelong  openShort closeShort method", function () {
    it("should call openlong method", async function () {
      const size = 5
      const strike = 1000000000000000
      const minget = 2
      const referrer = this.pika.address
      const long = await this.pikaPerp.openLong(size,strike,minget,referrer, {value: 500000000})
      expect(long)
    })

    it("should call closelong method", async function () {
      const size = 5
      const strike = "1000000000000000"
      const maxpay = "100000"
      const referrer = this.pika.address
      const close = await this.pikaPerp.closeLong(size, strike, maxpay, referrer)
      expect(close).to.be.revertedWith("subtraction overflow")
    })

    it("should call openShort method", async function () {
      const size = 5
      const strike = 1000000000000000
      const maxpay = 10000000000000
      const referrer = this.pika.address
      const close = await this.pikaPerp.openShort(size, strike, maxpay, referrer, {value: 500000000})
      expect(close)
    })
    it("should call closeShort method", async function () {
      const size = 5
      const strike = "1000000000000000"
      const minget = "1"
      const referrer = this.pika.address
      const close = await this.pikaPerp.closeShort(size, strike, minget, referrer)
      expect(close).to.be.revertedWith("subtraction overflow")

    })
  })
})
